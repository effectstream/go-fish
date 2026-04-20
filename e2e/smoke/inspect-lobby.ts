/**
 * Diagnostic read against a live game's on-chain state.
 *
 * Usage:
 *   cd e2e
 *   LOBBY_ID=lobby_4111_70997970 \
 *     deno run -A --no-check --unstable-raw-imports smoke/inspect-lobby.ts
 *
 * Optional — pass a player's secrets blob (the JSON the browser stores
 * under window.localStorage["go-fish-player-secrets"]) to also read that
 * player's private hand state:
 *
 *   LOBBY_ID=lobby_4111_70997970 \
 *   PLAYER_SECRETS='{"version":1,"games":{...}}' \
 *     deno run -A --no-check --unstable-raw-imports smoke/inspect-lobby.ts
 *
 * Reads:
 *   - hasInitialBooksScored(gameId, 1) and (gameId, 2)
 *   - getBookedRanks(gameId, 1) and (gameId, 2)
 *   - getGamePhase / getCurrentTurn / getScores / getHandSizes
 *   - With PLAYER_SECRETS:
 *       - Full 21-card hand enumeration via doesPlayerHaveSpecificCard
 *       - Suit/rank breakdown per player whose secret is supplied
 */

import {
  cardName,
  createSmokeSession,
  formatBookedRanks,
  isMissing,
  lobbyIdToGameId,
  PHASE,
  RANKS,
} from "./_helpers.ts";

const LOBBY_ID = Deno.env.get("LOBBY_ID") ?? "lobby_4111_70997970";

const PHASE_NAMES: Record<number, string> = {
  [PHASE.Setup]: "Setup",
  [PHASE.TurnStart]: "TurnStart",
  [PHASE.WaitForResponse]: "WaitForResponse",
  [PHASE.WaitForTransfer]: "WaitForTransfer",
  [PHASE.WaitForDraw]: "WaitForDraw (V3.3 — requestToDrawCard → drawCard)",
  [PHASE.WaitForDrawCheck]: "WaitForDrawCheck",
  [PHASE.GameOver]: "GameOver",
};

console.log(`\n══ Inspecting lobby ${LOBBY_ID} ══\n`);
const gameId = lobbyIdToGameId(LOBBY_ID);
const gameIdHex = "0x" + Array.from(gameId)
  .map(b => b.toString(16).padStart(2, "0"))
  .join("");
console.log(`gameId (hex): ${gameIdHex}`);

const session = await createSmokeSession(`inspect-${LOBBY_ID}`);

async function read<T = unknown>(name: string, ...args: unknown[]) {
  try {
    const v = await session.read<T>(name, ...args);
    if (isMissing(v)) return { value: null, error: "missing" } as const;
    return { value: v, error: null } as const;
  } catch (err) {
    return { value: null, error: (err as Error).message } as const;
  }
}

// ─── V4 owner / admin snapshot ──────────────────────────────────────────
console.log(`\n── V4 owner ──`);
const isOwnerR = await read<boolean>("isOwner");
console.log(`  isOwner:             ${isOwnerR.value === null ? "(error: " + isOwnerR.error + ")" : isOwnerR.value}`);
const ownerR = await read<Uint8Array>("getOwner");
if (ownerR.value === null) {
  console.log(`  getOwner:            (error: ${ownerR.error})`);
} else {
  const hex = "0x" + Array.from(ownerR.value).map(b => b.toString(16).padStart(2, "0")).join("");
  console.log(`  getOwner:            ${hex.slice(0, 18)}…`);
}

// ─── Phase / turn snapshot ──────────────────────────────────────────────
const phase = await read<number | bigint>("getGamePhase", gameId);
const phaseNum = phase.value !== null ? Number(phase.value) : null;
console.log(`\n── Phase / turn ──`);
console.log(`  getGamePhase:        ${phaseNum} (${phaseNum !== null ? PHASE_NAMES[phaseNum] ?? "?" : "?"})  ${phase.error ?? ""}`);

const turn = await read<number | bigint>("getCurrentTurn", gameId);
console.log(`  getCurrentTurn:      ${turn.value !== null ? Number(turn.value) : "(missing)"}  ${turn.error ?? ""}`);

const scores = await read<[unknown, unknown]>("getScores", gameId);
console.log(
  `  getScores:           ${scores.value ? `${Number(scores.value[0])}-${Number(scores.value[1])}` : "(missing)"}  ${scores.error ?? ""}`,
);

const handSizes = await read<[unknown, unknown]>("getHandSizes", gameId);
console.log(
  `  getHandSizes:        ${handSizes.value ? `P1=${Number(handSizes.value[0])} P2=${Number(handSizes.value[1])}` : "(missing)"}  ${handSizes.error ?? ""}`,
);

// ─── Initial-book scan flags ────────────────────────────────────────────
console.log(`\n── hasInitialBooksScored ──`);
for (const pid of [1n, 2n] as const) {
  const r = await read<boolean>("hasInitialBooksScored", gameId, pid);
  console.log(`  P${pid}: ${r.value === null ? "(error: " + r.error + ")" : r.value}`);
}

// ─── Per-player booked-rank vectors ─────────────────────────────────────
console.log(`\n── getBookedRanks ──`);
for (const pid of [1n, 2n] as const) {
  const r = await read<boolean[]>("getBookedRanks", gameId, pid);
  if (r.value === null) {
    console.log(`  P${pid}: (error: ${r.error})`);
  } else {
    console.log(`  P${pid}: ${JSON.stringify(r.value)}  → ${formatBookedRanks(r.value)}`);
    // Spell out ranks for clarity
    for (let rank = 0; rank < r.value.length; rank++) {
      console.log(`    rank ${rank} (${RANKS[rank] ?? "?"}): ${r.value[rank]}`);
    }
  }
}

// ─── Per-card hand reads (requires player secret) ───────────────────────
const secretsRaw = Deno.env.get("PLAYER_SECRETS");
if (!secretsRaw) {
  console.log(`\n── doesPlayerHaveSpecificCard ──`);
  console.log(
    `  Skipped (no PLAYER_SECRETS env var). Pass the browser's secrets\n` +
    `  blob to enable hand reads. Cards: 4=${cardName(4)}, 11=${cardName(11)}, 18=${cardName(18)}.`,
  );
} else {
  const blob = JSON.parse(secretsRaw) as {
    games: Record<string, { secret: string; shuffleSeed: string; playerId: number }>;
  };

  // Pull every (lobbyId, playerId) entry whose lobbyId matches LOBBY_ID
  const entries: Array<{ playerId: 1 | 2; secret: bigint; seed: Uint8Array }> = [];
  for (const [key, val] of Object.entries(blob.games)) {
    const [lobbyKey, pidKey] = key.split(":");
    if (lobbyKey !== LOBBY_ID) continue;
    const playerId = (val.playerId ?? Number(pidKey)) as 1 | 2;
    if (playerId !== 1 && playerId !== 2) continue;
    entries.push({
      playerId,
      secret: BigInt("0x" + val.secret),
      seed: hexToBytes(val.shuffleSeed),
    });
  }

  if (entries.length === 0) {
    console.log(
      `\n── doesPlayerHaveSpecificCard ──\n` +
      `  PLAYER_SECRETS supplied but no entry matched LOBBY_ID=${LOBBY_ID}.`,
    );
  } else {
    // V3's ec_mul-guard pattern fetches BOTH players' secrets unconditionally
    // (then ternary-selects), so even reading one player's hand requires the
    // witness to return *something* for the other player. Set a placeholder
    // for any player we don't have a real secret for — the result on that
    // ec_mul path is discarded by the in-circuit ternary, so the value is
    // irrelevant as long as it's a valid scalar.
    const PLACEHOLDER_SECRET = 1n;
    const PLACEHOLDER_SEED = new Uint8Array(32); // all zeros
    for (const pid of [1, 2] as const) {
      if (!entries.some(e => e.playerId === pid)) {
        session.witnessState.set(gameIdHex, pid, PLACEHOLDER_SECRET, PLACEHOLDER_SEED);
      }
    }

    for (const { playerId, secret, seed } of entries) {
      session.witnessState.set(gameIdHex, playerId, secret, seed);
      console.log(`\n── P${playerId} hand reads (witness loaded) ──`);

      // The 3 specific indices the user flagged
      const targets = [4, 11, 18] as const;
      for (const i of targets) {
        const r = await read<boolean>(
          "doesPlayerHaveSpecificCard",
          gameId,
          BigInt(playerId),
          BigInt(i),
        );
        console.log(
          `  doesPlayerHaveSpecificCard(P${playerId}, ${i}=${cardName(i)}): ${r.value === null ? "(error: " + r.error + ")" : r.value}`,
        );
      }

      // Full 21-card enumeration → reconstruct the hand
      const held: number[] = [];
      const errors: number[] = [];
      for (let i = 0; i < 21; i++) {
        const r = await read<boolean>(
          "doesPlayerHaveSpecificCard",
          gameId,
          BigInt(playerId),
          BigInt(i),
        );
        if (r.value === true) held.push(i);
        else if (r.value === null) errors.push(i);
      }
      console.log(
        `  Full hand (${held.length} cards): ${held.length ? held.map(cardName).join(" ") : "(empty)"}`,
      );
      console.log(`  By rank:`);
      const byRank = new Map<number, number[]>();
      for (const idx of held) {
        const rk = idx % 7;
        (byRank.get(rk) ?? byRank.set(rk, []).get(rk)!).push(idx);
      }
      for (let rk = 0; rk < 7; rk++) {
        const idxs = byRank.get(rk) ?? [];
        const flag = idxs.length >= 3 ? "  ⚠ THREE-OF-A-KIND" : "";
        console.log(
          `    rank ${rk} (${RANKS[rk]}): ${idxs.length} card${idxs.length === 1 ? "" : "s"}` +
          (idxs.length ? ` [${idxs.map(cardName).join(",")}]` : "") + flag,
        );
      }
      if (errors.length) {
        console.log(`  Errors on indices: ${errors.join(",")}`);
      }
    }
  }
}

console.log(`\n══ done ══`);
Deno.exit(0);

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

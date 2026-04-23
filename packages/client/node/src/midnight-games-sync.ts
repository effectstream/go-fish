/**
 * Project Midnight ledger diffs into the `midnight_games` table.
 * Ledger-only: no EVM cross-reference. `evm_id` is the ASCII decode of
 * `midnight_id` (both forms come from the same Bytes<32> key).
 */

import { World } from "@paimaexample/coroutine";
import {
  insertMidnightGame,
  setMidnightGameHostPubkey,
  setMidnightGameJoinerPubkey,
  setMidnightGameWinner,
  getMidnightGame,
  upsertLeaderboardScore,
  markMidnightGameScored,
  finishLobby,
} from "@go-fish/database";
import type { Diff } from "./ledger-diff.ts";

/** Re-encode an ASCII game-id back to its Bytes<32> hex form (zero-padded to 32). */
function evmIdToMidnightId(evmId: string): string {
  const buf = new Uint8Array(32);
  new TextEncoder().encodeInto(evmId, buf);
  return "0x" + Array.from(buf).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Map the contract's winner value (1/2/0) to a state string. */
function winnerToState(winner: unknown): string | null {
  const n = typeof winner === "bigint" ? Number(winner) : Number(winner);
  if (n === 1) return "host-win";
  if (n === 2) return "joiner-win";
  if (n === 0) return "tie";
  return null;
}

const POINTS_WIN = 100;
const POINTS_LOSS = 10;

/** Drive midnight_games upserts from a diff batch. Yields `World.resolve` updates
 *  that the caller `yield*`s into an STF generator.
 *
 *  Two-pass approach: first upsert all game rows and pubkeys, then process
 *  winners and scoring. This guarantees pubkeys are in the DB before we try
 *  to attribute leaderboard points, regardless of diff ordering within a batch. */
export function* projectMidnightGamesFromDiff(diffs: Diff[], blockHeight: number) {
  const winnerDiffs: { evmId: string; midnightId: string; winnerVal: number }[] = [];

  // Pass 1: project game rows, pubkeys, and collect winner diffs
  for (const d of diffs) {
    if (d.op === "remove") continue;

    // New game appears — go_fish_gameExists.<evmId> = true
    if (d.path.startsWith("go_fish_gameExists.") && d.op === "add" && d.new === true) {
      const evmId = d.path.slice("go_fish_gameExists.".length);
      const midnightId = evmIdToMidnightId(evmId);
      yield* World.resolve(insertMidnightGame, { midnightId, evmId });
      continue;
    }

    // Host pubkey — go_fish_playerPubKey1.<evmId> = "0x..."
    if (d.path.startsWith("go_fish_playerPubKey1.")) {
      const evmId = d.path.slice("go_fish_playerPubKey1.".length);
      const midnightId = evmIdToMidnightId(evmId);
      const pk = typeof d.new === "string" ? d.new : String(d.new);
      yield* World.resolve(insertMidnightGame, { midnightId, evmId });
      yield* World.resolve(setMidnightGameHostPubkey, { midnightId, hostPubkey: pk });
      continue;
    }

    // Joiner pubkey — go_fish_playerPubKey2.<evmId> = "0x..."
    if (d.path.startsWith("go_fish_playerPubKey2.")) {
      const evmId = d.path.slice("go_fish_playerPubKey2.".length);
      const midnightId = evmIdToMidnightId(evmId);
      const pk = typeof d.new === "string" ? d.new : String(d.new);
      yield* World.resolve(insertMidnightGame, { midnightId, evmId });
      yield* World.resolve(setMidnightGameJoinerPubkey, { midnightId, joinerPubkey: pk });
      continue;
    }

    // Winner — defer to pass 2
    if (d.path.startsWith("go_fish_winner.")) {
      const evmId = d.path.slice("go_fish_winner.".length);
      const midnightId = evmIdToMidnightId(evmId);
      const winnerVal = typeof d.new === "bigint" ? Number(d.new) : Number(d.new);
      winnerDiffs.push({ evmId, midnightId, winnerVal });
    }
  }

  // Pass 2: set winners and score leaderboard (pubkeys are guaranteed in DB)
  for (const { evmId, midnightId, winnerVal } of winnerDiffs) {
    const state = winnerToState(winnerVal);
    if (state) {
      yield* World.resolve(setMidnightGameWinner, { midnightId, state });
    }

    // Mark the EVM lobby as finished
    yield* World.resolve(finishLobby, { lobbyId: evmId });

    const gameRows = yield* World.resolve(getMidnightGame, { midnightId });
    const game = gameRows?.[0];
    if (game && !game.scored && game.host_pubkey && game.joiner_pubkey) {
      const hostWon = winnerVal === 1;
      const joinerWon = winnerVal === 2;
      const isTie = winnerVal === 0;

      yield* World.resolve(upsertLeaderboardScore, {
        address: game.host_pubkey,
        points: hostWon ? POINTS_WIN : POINTS_LOSS,
        won: hostWon ? 1 : 0,
        blockHeight,
      });
      yield* World.resolve(upsertLeaderboardScore, {
        address: game.joiner_pubkey,
        points: joinerWon ? POINTS_WIN : POINTS_LOSS,
        won: joinerWon ? 1 : 0,
        blockHeight,
      });
      yield* World.resolve(markMidnightGameScored, { midnightId });

      const outcome = isTie ? "tie" : hostWon ? "host wins" : "joiner wins";
      console.log(`🏆 [leaderboard] Scored game ${evmId}: ${outcome}`);
    }
  }
}

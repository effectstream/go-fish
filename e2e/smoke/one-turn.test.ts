/**
 * Step 9 smoke test — one full turn after setup.
 *
 * Flow:
 *   1. Full setup (applyMask×2 + dealCards×2) → phase=TurnStart, hands=4/4
 *   2. Read P1's hand via doesPlayerHaveSpecificCard loop (21 reads)
 *   3. Read P2's hand (debug-only — logs both, consistent with plan §1)
 *   4. Pick the first rank in P1's hand, askForCard(gameId, 1, rank, now)
 *   5. Wait for phase==WaitForResponse, currentTurn==2
 *   6. respondToAsk(gameId, 2, now)
 *   7. Branch on result phase:
 *        TurnStart      → P2 had cards, transferred
 *        WaitForDrawCheck → Go Fish, call afterGoFish(gameId, 1, now),
 *                           wait for phase to return to TurnStart
 *   8. Read both players' final hands and log the delta
 *
 * PREREQS: same as setup test.
 *
 * Run: bun run --filter @go-fish/e2e smoke:one-turn
 */

import { test, expect } from "bun:test";
import {
  callDelegated,
  cardName,
  clearAllSecrets,
  createSmokeSession,
  handRanks,
  isMissing,
  nowSeconds,
  PHASE,
  readHand,
  runFullSetup,
  waitFor,
} from "./_helpers.ts";

test("turn: askForCard → respondToAsk → (optional) afterGoFish", async () => {
    const session = await createSmokeSession("smoke-one-turn");
    const { contract, walletProvider, read } = session;

    const setup = await runFullSetup(session);
    const { gameId, gameIdHex } = setup;

    try {
      // ─── Read starting hands ───────────────────────────────────────
      console.log("\n── reading hands ──");
      const p1HandBefore = await readHand(session, gameId, 1);
      const p2HandBefore = await readHand(session, gameId, 2);
      console.log(`  P1 hand: ${p1HandBefore.map(cardName).join(" ")}`);
      console.log(`  P2 hand: ${p2HandBefore.map(cardName).join(" ")}`);

      expect(p1HandBefore.length).toBe(4);
      expect(p2HandBefore.length).toBe(4);

      const currentTurnBefore = Number(await read<number | bigint>("getCurrentTurn", gameId));
      console.log(`  currentTurn before ask: ${currentTurnBefore}`);
      expect(currentTurnBefore).toBe(1);

      // ─── P1 asks for the first rank in their hand ──────────────────
      const askRank = handRanks(p1HandBefore)[0]!;
      const rankLabel = ["A", "2", "3", "4", "5", "6", "7"][askRank];
      const p2HasRank = p2HandBefore.some(c => c % 7 === askRank);
      console.log(`\n── P1 asks P2 for ${rankLabel} (P2 actually has it? ${p2HasRank}) ──`);

      const askTime = nowSeconds();
      await callDelegated(
        walletProvider,
        "askForCard",
        () => contract.callTx.askForCard(gameId, 1n, BigInt(askRank), askTime),
        { playerId: 1 },
      );

      // Phase should flip to WaitForResponse. currentTurn STAYS with the
      // asker (P1) throughout the ask→respond cycle — the opponent is
      // identified inside respondToAsk as "not the last asking player",
      // not by being currentTurn. So we only check the phase here.
      await waitFor(
        "phase == WaitForResponse",
        120_000,
        () => read<number | bigint>("getGamePhase", gameId),
        v => !isMissing(v) && Number(v) === PHASE.WaitForResponse,
      );
      const turnAfterAsk = Number(await read<number | bigint>("getCurrentTurn", gameId));
      console.log(`  currentTurn after ask: ${turnAfterAsk} (unchanged from asker)`);
      expect(turnAfterAsk).toBe(1);

      // ─── P2 responds ───────────────────────────────────────────────
      console.log("\n── P2 responds to ask ──");
      const respondTime = nowSeconds();
      await callDelegated(
        walletProvider,
        "respondToAsk",
        () => contract.callTx.respondToAsk(gameId, 2n, respondTime),
        { playerId: 2 },
      );

      // After respondToAsk, the contract's phase will be either:
      //   - TurnStart       (P2 had the rank → cards transferred)
      //   - WaitForDrawCheck (Go Fish, deck non-empty → asker drew a card)
      //   - (if deck empty and Go Fish → switchTurn, phase becomes TurnStart)
      console.log("  waiting for phase to leave WaitForResponse...");
      const postRespondPhase = await waitFor(
        "phase != WaitForResponse",
        120_000,
        () => read<number | bigint>("getGamePhase", gameId),
        v => !isMissing(v) && Number(v) !== PHASE.WaitForResponse,
      );
      const phaseAfterRespond = Number(postRespondPhase);
      console.log(`  phase after respond: ${phaseAfterRespond}`);

      if (phaseAfterRespond === PHASE.WaitForDrawCheck) {
        // Go Fish! P1 drew a card from the deck. Must call afterGoFish to
        // verify the drawn card and transition to TurnStart (or switchTurn).
        console.log("\n── Go Fish: P1 calls afterGoFish ──");
        const drawTime = nowSeconds();
        await callDelegated(
          walletProvider,
          "afterGoFish",
          () => contract.callTx.afterGoFish(gameId, 1n, drawTime),
          { playerId: 1 },
        );
        await waitFor(
          "phase == TurnStart after afterGoFish",
          120_000,
          () => read<number | bigint>("getGamePhase", gameId),
          v => !isMissing(v) && Number(v) === PHASE.TurnStart,
        );
      } else if (phaseAfterRespond === PHASE.TurnStart) {
        console.log("  ✓ P2 had cards — direct transfer, no draw needed");
      } else {
        throw new Error(
          `unexpected phase after respondToAsk: ${phaseAfterRespond}`,
        );
      }

      // ─── Read final hands ──────────────────────────────────────────
      console.log("\n── final hands ──");
      const p1HandAfter = await readHand(session, gameId, 1);
      const p2HandAfter = await readHand(session, gameId, 2);
      console.log(`  P1 hand: ${p1HandAfter.map(cardName).join(" ")}  (${p1HandAfter.length})`);
      console.log(`  P2 hand: ${p2HandAfter.map(cardName).join(" ")}  (${p2HandAfter.length})`);

      // Sanity: total cards visible to each player should add up the same
      // way. If P2 had the rank, cards moved from P2 to P1 (P1 grew by N,
      // P2 shrank by N). If Go Fish, P1 grew by 1 (drew from deck), P2
      // stayed the same.
      const p1Delta = p1HandAfter.length - p1HandBefore.length;
      const p2Delta = p2HandAfter.length - p2HandBefore.length;
      console.log(`  Δ P1=${p1Delta >= 0 ? "+" : ""}${p1Delta}, P2=${p2Delta >= 0 ? "+" : ""}${p2Delta}`);

      const finalPhase = Number(await read<number | bigint>("getGamePhase", gameId));
      console.log(`\n  ✓ turn complete, phase=${finalPhase} (TurnStart)`);
      expect(finalPhase).toBe(PHASE.TurnStart);
    } finally {
      await clearAllSecrets(gameIdHex);
    }
}, { timeout: 600_000 });

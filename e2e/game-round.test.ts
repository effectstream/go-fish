/**
 * E2E test — full Go Fish game via real prover + batcher.
 *
 * Reference implementation for the frontend: drives the entire lifecycle
 * through the SAME pipeline the frontend will use once `preferBatchedMode`
 * flips in `frontend/src/effectstreamBridge.ts`.
 *
 * Pipeline (Contract V4.2):
 *   1. Lobby (EVM via batcher /send-input → effectstreaml2 target):
 *        createdLobby → joinedLobby (auto-starts the game)
 *   2. Midnight deploy-time one-shots (via `runFullSetup`):
 *        - init_deck (idempotent, only submits if not already set)
 *        - initialize (V4 owner bootstrap — captures h_hashField(TEST_ADMIN_SECRET)
 *          into the contract `owner` ledger; safe to skip if already init'd
 *          with the same secret)
 *   3. Per-game setup: applyMask ×2 → dealCards ×2 → startGame → phase=TurnStart.
 *      V4.3 split the phase transition out of dealCards (so both players can
 *      deal in parallel); we still submit in canonical P1→P2 order for
 *      reproducibility and then call startGame once to flip the phase.
 *      `scoreInitialBooks` is NOT mandatory
 *      (V3.3) — `askForCard` no longer gates on it. Callers that want to
 *      claim an opening book invoke `runInitialBookScoring(...)` explicitly;
 *      this test skips it.
 *   4. Turn loop — three-way branch per turn, depending on hand/deck state:
 *        - Hand non-empty:
 *            askForCard → respondToAsk
 *            ├─ phase=WaitForDrawCheck: afterGoFish  (auto-books drawn rank)
 *            └─ phase=TurnStart:        checkAndScoreBook if triple formed
 *              (V3.1: asker-side book scoring can't be inlined in respondToAsk
 *              because the responder's circuit context has a dummy asker-secret.
 *              V4.2 FIX: respondToAsk's unmasked-transfer branch now actually
 *              moves unmasked cards — prior bug left complete books stuck
 *              un-scored in the asker's hand.)
 *        - Hand empty + deck has cards:
 *            requestToDrawCard → drawCard (no afterGoFish; 0→1 hand can't book)
 *        - Hand empty + deck empty:
 *            skipTurn → checkAndEndGame (stalemate detection)
 *      Exit on GameOver / scores==7 / MAX_TURNS.
 *   5. Final reconcile: `runFullGame` calls one last `checkAndEndGame` before
 *      reading the final phase snapshot. V4.2 caveat: the contract's inline
 *      scoring paths do not reliably flip phase=GameOver on the 7th book,
 *      so the client must do it.
 *   6. Optional (V4): set RUN_CLEANUP=1 to call cleanupGame(owner) at the
 *      end, verifying the per-game ledger entries are purged.
 *
 * All the mechanics live in `smoke/_helpers.ts`, which doubles as the
 * reference module the frontend will port from. This file is just the
 * orchestration shell.
 *
 * Prereqs (full stack, see GAME_ROUND_PLAN.md):
 *   - Hardhat (:8545), Paima node (:9996), batcher (:3336)
 *   - Midnight node + indexer (:8088) + proof server (:6300)
 *   - go-fish contract deployed (address in go-fish-contract.undeployed.json)
 *
 * Run: bun run test:e2e
 */

import { test } from "bun:test";
import { ethers } from "ethers";
import {
  clearAllSecrets,
  createSmokeSession,
  EVM_RPC_URL,
  formatBookedRanks,
  HARDHAT_KEYS,
  lobbyIdToGameId,
  PHASE,
  runCleanupGame,
  runFullGame,
  runFullSetup,
  runLobbyFlow,
} from "./smoke/_helpers.ts";

test("e2e: full Go Fish game via batcher (lobby + Midnight)", async () => {
    // Two EVM wallets sign lobby transactions for the batcher.
    const provider = new ethers.providers.JsonRpcProvider(EVM_RPC_URL);
    const p1Wallet = new ethers.Wallet(HARDHAT_KEYS[1], provider);
    const p2Wallet = new ethers.Wallet(HARDHAT_KEYS[2], provider);

    // 1. Lobby flow — create, join, ready ×2, start. Returns Paima lobbyId.
    const lobbyId = await runLobbyFlow(p1Wallet, p2Wallet, `E2E-${Date.now()}`);
    const gameId = lobbyIdToGameId(lobbyId);

    // 2. Midnight session + per-game setup.
    //    V4: runFullSetup also calls initialize() as a one-shot owner
    //    bootstrap (using TEST_ADMIN_SECRET). V3.3: scoreInitialBooks is
    //    optional and skipped here; askForCard no longer gates on it.
    const session = await createSmokeSession(`e2e-${lobbyId}`);
    const setup = await runFullSetup(session, { gameId });

    try {
      // 3. Turn loop until GameOver / sum==7 / MAX_TURNS.
      // 30 turns gives headroom for shuffles where books form late —
      // with the early-win threshold correctly at 4 (not the old
      // double-increment 3), some games need 22–25 turns.
      const result = await runFullGame(session, gameId, 30);

      console.log(`\n══════════════════════════════════`);
      console.log(`  E2E result`);
      console.log(`══════════════════════════════════`);
      console.log(`  exitReason:      ${result.exitReason}`);
      console.log(`  turnsPlayed:     ${result.turnsPlayed}`);
      console.log(`  finalScores:     P1=${result.finalScores[0]} P2=${result.finalScores[1]}`);
      console.log(`  finalHandSizes:  P1=${result.finalHandSizes[0]} P2=${result.finalHandSizes[1]}`);
      console.log(`  totalBooks:      ${result.totalBooksScored}/7`);
      console.log(`  booksP1:         ${formatBookedRanks(result.finalBookedRanks[0])}`);
      console.log(`  booksP2:         ${formatBookedRanks(result.finalBookedRanks[1])}`);
      console.log(`  finalPhase:      ${result.finalPhase} (GameOver=${PHASE.GameOver})`);
      console.log(`  winner:          ${result.winner ?? "(not set)"}`);

      // With the early-win fix (addScore ≥ 4) and the rule-5 relaxation in
      // askForCard, every finished game must exit in GameOver with a real
      // winner. Ties are unreachable via the early-win path.
      if (result.finalPhase !== PHASE.GameOver) {
        throw new Error(
          `expected finalPhase == GameOver (${PHASE.GameOver}), got ${result.finalPhase}. exitReason: ${result.exitReason}`,
        );
      }
      if (result.winner !== 1 && result.winner !== 2) {
        throw new Error(
          `expected winner in {1, 2}, got ${result.winner ?? "null"}. scores: ${result.finalScores[0]}-${result.finalScores[1]}`,
        );
      }

      // V4 optional: clean up per-game ledger entries. Gated by env flag
      // to keep the default run cheap (~2-min additional tx). Uses the
      // owner path (callerPlayerId=0n), which requires the session's
      // TEST_ADMIN_SECRET to match the stored contract owner — set
      // automatically by runFullSetup's ensureOwnerInitialized step.
      if (process.env.RUN_CLEANUP === "1") {
        await runCleanupGame(session, gameId, 0n);
      }
    } finally {
      clearAllSecrets(session, setup.gameIdHex);
    }
}, { timeout: 600_000 });

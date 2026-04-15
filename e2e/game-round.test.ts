/**
 * E2E test — full Go Fish game via real prover + batcher.
 *
 * Reference implementation for the frontend: drives the entire lifecycle
 * through the SAME pipeline the frontend will use once `preferBatchedMode`
 * flips in `frontend/src/effectstreamBridge.ts`.
 *
 * Pipeline:
 *   1. Lobby (EVM via batcher /send-input → effectstreaml2 target):
 *        createdLobby → joinedLobby (auto-starts the game)
 *   2. Midnight setup (batcher /send-input → midnight_balancing target):
 *        applyMask ×2 → dealCards ×2  (init_deck only on first deploy)
 *   3. Turn loop until phase == GameOver, scores sum == 7, or MAX_TURNS:
 *        askForCard → respondToAsk → (afterGoFish if Go Fish) → autoScoreBooks
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
 * Run: deno task test:e2e
 */

import { ethers } from "ethers";
import {
  clearAllSecrets,
  createSmokeSession,
  EVM_RPC_URL,
  HARDHAT_KEYS,
  lobbyIdToGameId,
  PHASE,
  runFullGame,
  runFullSetup,
  runLobbyFlow,
} from "./smoke/_helpers.ts";

Deno.test({
  name: "e2e: full Go Fish game via batcher (lobby + Midnight)",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // Two EVM wallets sign lobby transactions for the batcher.
    const provider = new ethers.providers.JsonRpcProvider(EVM_RPC_URL);
    const p1Wallet = new ethers.Wallet(HARDHAT_KEYS[1], provider);
    const p2Wallet = new ethers.Wallet(HARDHAT_KEYS[2], provider);

    // 1. Lobby flow — create, join, ready ×2, start. Returns Paima lobbyId.
    const lobbyId = await runLobbyFlow(p1Wallet, p2Wallet, `E2E-${Date.now()}`);
    const gameId = lobbyIdToGameId(lobbyId);

    // 2. Midnight session + per-game setup (applyMask ×2, dealCards ×2).
    const session = await createSmokeSession(`e2e-${lobbyId}`);
    const setup = await runFullSetup(session, { gameId });

    try {
      // 3. Turn loop until GameOver / sum==7 / MAX_TURNS (20).
      const result = await runFullGame(session, gameId, 20);

      console.log(`\n══════════════════════════════════`);
      console.log(`  E2E result`);
      console.log(`══════════════════════════════════`);
      console.log(`  exitReason:      ${result.exitReason}`);
      console.log(`  turnsPlayed:     ${result.turnsPlayed}`);
      console.log(`  finalScores:     P1=${result.finalScores[0]} P2=${result.finalScores[1]}`);
      console.log(`  finalHandSizes:  P1=${result.finalHandSizes[0]} P2=${result.finalHandSizes[1]}`);
      console.log(`  totalBooks:      ${result.totalBooksScored}/7`);
      console.log(`  divergences:     ${result.divergenceCount}`);
      console.log(`  finalPhase:      ${result.finalPhase} (GameOver=${PHASE.GameOver})`);
      console.log(`  winner:          ${result.winner ?? "(not set)"}`);
    } finally {
      clearAllSecrets(session, setup.gameIdHex);
    }
  },
});

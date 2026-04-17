/**
 * Batcher Midnight Service — helper utilities only
 *
 * Circuit calls (initDeck, applyMask, dealCards, askForCard, respondToAsk,
 * goFish, afterGoFish, switchTurn, claimTimeoutWin) have been moved to
 * GoFishContractService.ts, which proves circuits locally in the browser via
 * @paima/midnight-wasm-prover and delegates the proven tx to the
 * midnight_balancing batcher target.
 *
 * This module retains:
 *  - registerSecret()          — push player secrets to the backend for opponent-side queries
 *  - registerMidnightAddress() — associate a Midnight shielded address with a lobby player
 *  - queryHandFromBatcher()    — read real on-chain hand state via the batcher query server
 */

import { PlayerKeyManager } from './PlayerKeyManager';
import { API_BASE_URL } from '../apiConfig';

// Batcher query server URL (direct connection, no proxy).
const BATCHER_QUERY_URL = import.meta.env.VITE_BATCHER_QUERY_URL || "http://localhost:9997";

// ============================================================================
// Secret Registration
// ============================================================================

// registerSecret and registerMidnightAddress removed — the backend endpoints
// /api/midnight/register_secret and /api/midnight/register_address don't exist.
// Player secrets are managed in-browser via PlayerKeyManager and the shared
// witness module. No backend registration is needed.
export async function registerSecret(_lobbyId: string, _playerId: 1 | 2): Promise<void> {}
export async function registerMidnightAddress(_lobbyId: string, _playerId: 1 | 2, _addr: string): Promise<void> {}

// ============================================================================
// Hand Query
// ============================================================================

/**
 * Query the player's current hand directly from the Midnight indexer via the
 * batcher's secondary query server (POST /batcher-query/query-hand).
 *
 * Unlike the backend's getPlayerHandWithSecret (which uses a local simulation
 * that only knows the post-deal state), this reflects REAL on-chain ownership
 * after every respondToAsk/goFish card transfer.
 *
 * Returns null if the batcher query server is unavailable or errors.
 */
export async function queryHandFromBatcher(
  lobbyId: string,
  playerId: 1 | 2,
): Promise<Array<{ rank: number; suit: number }> | null> {
  const playerSecret = PlayerKeyManager.getPlayerSecret(lobbyId, playerId);
  const playerSecretHex = playerSecret.toString(16).padStart(64, "0");
  const shuffleSeed = PlayerKeyManager.getShuffleSeed(lobbyId, playerId);
  const shuffleSeedHex = Array.from(shuffleSeed).map(b => b.toString(16).padStart(2, "0")).join("");

  const opponentId = (playerId === 1 ? 2 : 1) as 1 | 2;
  let opponentSecretHex: string | undefined;
  let opponentShuffleSeedHex: string | undefined;
  if (PlayerKeyManager.hasExistingKeys(lobbyId, opponentId)) {
    try {
      const opponentSecret = PlayerKeyManager.getPlayerSecret(lobbyId, opponentId);
      opponentSecretHex = opponentSecret.toString(16).padStart(64, "0");
      const opponentSeed = PlayerKeyManager.getShuffleSeed(lobbyId, opponentId);
      opponentShuffleSeedHex = Array.from(opponentSeed).map(b => b.toString(16).padStart(2, "0")).join("");
    } catch {
      // Ignore — opponent keys unavailable
    }
  }

  try {
    const response = await fetch(`${BATCHER_QUERY_URL}/query-hand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lobbyId,
        playerId,
        playerSecretHex,
        shuffleSeedHex,
        opponentSecretHex,
        opponentShuffleSeedHex,
      }),
    });
    if (!response.ok) {
      console.warn(`[BatcherMidnight] queryHandFromBatcher: server returned ${response.status}`);
      return null;
    }
    const data = await response.json() as { hand: Array<{ rank: number; suit: number }> };
    return data.hand;
  } catch (err) {
    console.warn("[BatcherMidnight] queryHandFromBatcher: fetch failed:", err);
    return null;
  }
}

export const BatcherMidnightService = {
  registerSecret,
  registerMidnightAddress,
  queryHandFromBatcher,
};

export default BatcherMidnightService;

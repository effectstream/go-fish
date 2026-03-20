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

// Batcher query server (proxied via /batcher-query prefix to avoid CORS).
const BATCHER_QUERY_URL = import.meta.env.VITE_BATCHER_QUERY_URL || "";

// ============================================================================
// Secret Registration
// ============================================================================

/**
 * Register (or refresh) this player's secret with the backend node.
 * Call this on game entry / page reload so the backend always has the latest
 * secrets for opponent-secret lookups, even after a node restart.
 */
export async function registerSecret(lobbyId: string, playerId: 1 | 2): Promise<void> {
  try {
    const playerSecret = PlayerKeyManager.getPlayerSecret(lobbyId, playerId);
    const shuffleSeed = PlayerKeyManager.getShuffleSeed(lobbyId, playerId);
    const playerSecretHex = playerSecret.toString(16).padStart(64, '0');
    const shuffleSeedHex = Array.from(shuffleSeed).map(b => b.toString(16).padStart(2, '0')).join('');

    const response = await fetch(`${API_BASE_URL}/api/midnight/register_secret`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lobby_id: lobbyId,
        player_id: playerId,
        player_secret: playerSecretHex,
        shuffle_seed: shuffleSeedHex,
      }),
    });
    if (response.ok) {
      console.log(`[BatcherMidnight] registerSecret: secret registered for lobby=${lobbyId} player=${playerId}`);
    } else {
      console.warn(`[BatcherMidnight] registerSecret: backend returned ${response.status}`);
    }
  } catch (err) {
    console.warn(`[BatcherMidnight] registerSecret failed:`, err);
  }
}

/**
 * Register the player's Midnight shielded address with the backend so scores
 * can be attributed to them at game end.
 */
export async function registerMidnightAddress(
  lobbyId: string,
  playerId: 1 | 2,
  midnightAddress: string,
): Promise<void> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/midnight/register_address`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lobby_id: lobbyId,
        player_id: playerId,
        midnight_address: midnightAddress,
      }),
    });
    if (response.ok) {
      console.log(`[BatcherMidnight] registerMidnightAddress: registered for lobby=${lobbyId} player=${playerId}`);
    } else {
      console.warn(`[BatcherMidnight] registerMidnightAddress: backend returned ${response.status}`);
    }
  } catch (err) {
    console.warn('[BatcherMidnight] registerMidnightAddress failed:', err);
  }
}

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
    const response = await fetch(`${BATCHER_QUERY_URL}/batcher-query/query-hand`, {
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

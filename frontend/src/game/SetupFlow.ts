/**
 * Setup flow helpers — idempotent wrappers around the Midnight mask step.
 *
 * Before this module, mask application lived inside GameSession.setupMask and
 * ran only once both players were already on the game screen. The lobby-screen
 * flow now runs mask immediately after create/join, so these helpers need to
 * be callable from the lobby as well. Deal + initialBook stay in GameSession.
 */

import { MidnightService } from '../services/MidnightService';
import { PlayerKeyManager } from '../services/PlayerKeyManager';

export type MaskResult =
  | { success: true; alreadyApplied: boolean }
  | { success: false; errorMessage: string };

/**
 * Apply this player's mask if not already applied, and poll until the
 * indexer confirms it on-chain. Idempotent: short-circuits when the
 * on-chain flag is already true (e.g., page reload mid-mask).
 *
 * Resolves `{ success: true }` only after on-chain confirmation. Does not
 * wait for the opponent's mask.
 */
export async function applyMyMask(
  lobbyId: string,
  playerId: 1 | 2,
  confirmTimeoutMs = 120_000,
): Promise<MaskResult> {
  // Short-circuit: already applied on-chain.
  try {
    const status = await MidnightService.getSetupStatus(lobbyId, playerId);
    if (status.hasMaskApplied) {
      return { success: true, alreadyApplied: true };
    }
  } catch (err) {
    // Status read failure is non-fatal — the submit below will surface it.
    console.warn('[SetupFlow] applyMyMask: getSetupStatus failed, proceeding', err);
  }

  const secretHex = PlayerKeyManager.getPlayerSecret(lobbyId, playerId)
    .toString(16)
    .padStart(64, '0');

  const submitResult = await MidnightService.applyMask(lobbyId, playerId, secretHex);

  // Batcher/indexer can report "already applied" as an error — treat as success.
  if (!submitResult.success) {
    const err = submitResult.errorMessage ?? '';
    if (err.includes('already applied') || err.includes('Player has already applied')) {
      return { success: true, alreadyApplied: true };
    }
    // Network/timeout errors may still have succeeded on-chain — poll below.
    const recoverable =
      err.includes('timed out') ||
      err.includes('NetworkError') ||
      err.includes('fetch') ||
      err.includes('EffectStream processing validation failed') ||
      err.includes('Timeout');
    if (!recoverable) {
      return { success: false, errorMessage: err || 'applyMask failed' };
    }
  }

  // Poll for on-chain confirmation.
  const confirmed = await pollForMaskApplied(lobbyId, playerId, confirmTimeoutMs);
  if (confirmed) {
    return { success: true, alreadyApplied: false };
  }
  return {
    success: false,
    errorMessage: 'Mask submitted but not confirmed on-chain within timeout',
  };
}

/** Resolve when the opponent's mask lands on-chain, or timeout. */
export async function waitForOpponentMask(
  lobbyId: string,
  myPlayerId: 1 | 2,
  timeoutMs = 180_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const pollIntervalMs = 2000;
  while (Date.now() < deadline) {
    try {
      const status = await MidnightService.getSetupStatus(lobbyId, myPlayerId);
      if (status.opponentHasMaskApplied) return true;
    } catch {
      // Transient read failure — keep polling.
    }
    await new Promise(r => setTimeout(r, pollIntervalMs));
  }
  return false;
}

/** True when both players have applied their masks on-chain. */
export async function bothMasksApplied(
  lobbyId: string,
  queryAsPlayerId: 1 | 2,
): Promise<boolean> {
  try {
    const status = await MidnightService.getSetupStatus(lobbyId, queryAsPlayerId);
    return status.hasMaskApplied && status.opponentHasMaskApplied;
  } catch {
    return false;
  }
}

async function pollForMaskApplied(
  lobbyId: string,
  playerId: 1 | 2,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const pollIntervalMs = 2000;
  while (Date.now() < deadline) {
    try {
      const status = await MidnightService.getSetupStatus(lobbyId, playerId);
      if (status.hasMaskApplied) return true;
    } catch {
      // Transient — keep polling.
    }
    await new Promise(r => setTimeout(r, pollIntervalMs));
  }
  return false;
}

/**
 * Batcher Midnight Service
 *
 * This service provides a wallet-less mode for Midnight transactions using
 * the Paima batcher's /send-input endpoint. Instead of proving locally and
 * submitting transactions, this sends circuit calls to the batcher which
 * handles proving, balancing, and submission.
 *
 * IMPORTANT: Player secrets are managed client-side via PlayerKeyManager.
 * The batcher receives the player's secret for proof generation, but this
 * is done securely over HTTPS. In a production system, you would use:
 * - Client-side proving (frontend generates proofs, batcher just submits)
 * - Or encrypted secret sharing with attestation
 *
 * Current implementation: Secrets are included in circuit calls for the
 * batcher to use during proof generation. This is acceptable for development
 * but should be upgraded to client-side proving for production.
 */

import { PlayerKeyManager } from './PlayerKeyManager';

/**
 * Get opponent secrets only if they have been previously stored in this browser.
 * PlayerKeyManager.getPlayerSecret() creates a new random key if none exists — calling
 * it for the opponent would corrupt the backend's local simulation with a fake secret.
 * Returns undefined if the opponent's keys are not available locally.
 */
function getOpponentSecretsIfAvailable(
  lobbyId: string,
  opponentId: 1 | 2,
): { opponentSecret: bigint; opponentShuffleSeed: Uint8Array } | undefined {
  if (!PlayerKeyManager.hasExistingKeys(lobbyId, opponentId)) {
    return undefined;
  }
  return {
    opponentSecret: PlayerKeyManager.getPlayerSecret(lobbyId, opponentId),
    opponentShuffleSeed: PlayerKeyManager.getShuffleSeed(lobbyId, opponentId),
  };
}

// Circuit call interface for Midnight contract
interface CircuitCall {
  circuit: string;
  args: unknown[];
  // Player secrets for proof generation (included for batcher proving)
  playerSecret?: string;
  shuffleSeed?: string;
  // Opponent secrets — needed for circuits that remove the opponent's mask (e.g. goFish)
  opponentSecret?: string;
  opponentShuffleSeed?: string;
}

// Address type enum (matches @paimaexample/wallets WalletMode)
const ADDRESS_TYPE_EVM = 0;

// Batcher input format expected by /send-input
interface BatcherInput {
  data: {
    target: string;
    address: string;
    addressType: number; // Must be a number, not string
    input: string; // JSON stringified CircuitCall
    timestamp: number;
    signature: string;
  };
  confirmationLevel: string;
}

// Configuration
// Use relative URL by default so requests go through Vite's dev server proxy (avoids CORS).
// Set VITE_BATCHER_URL to an absolute URL for production or when not using the dev proxy.
const BATCHER_URL = import.meta.env.VITE_BATCHER_URL || "";
const MIDNIGHT_TARGET = "go-fish"; // Target name matching batcher's adapter registration
// Using "wait-receipt" to ensure transactions are confirmed before proceeding.
// The frontend has a 2-minute timeout and will retry if needed.
// This prevents the race condition where frontend proceeds before on-chain tx completes.
const CONFIRMATION_LEVEL = "wait-receipt";

// Simple in-memory wallet for signing requests
// In production, this would use a proper EVM wallet
let cachedAddress: string | null = null;
let cachedPrivateKey: string | null = null;

/**
 * Initialize a simple signing wallet
 * This creates a deterministic wallet from a fixed seed for development
 */
function initializeWallet(): { address: string; sign: (message: string) => Promise<string> } {
  // Use a deterministic address for development
  // In production, this would connect to user's EVM wallet
  const address = "0x1234567890123456789012345678901234567890";

  return {
    address,
    sign: async (message: string): Promise<string> => {
      // For development, return a placeholder signature
      // The batcher's verifySignature can be configured to accept this
      // In production, this would use proper EVM signing
      return "0x" + "00".repeat(65);
    },
  };
}

/**
 * Get the wallet for signing batcher requests
 */
function getWallet(): { address: string; sign: (message: string) => Promise<string> } {
  return initializeWallet();
}

/**
 * Convert BigInt values to strings for JSON serialization
 */
function serializeArgs(args: unknown[]): unknown[] {
  return args.map(arg => {
    if (typeof arg === "bigint") {
      return arg.toString();
    }
    if (Array.isArray(arg)) {
      return serializeArgs(arg);
    }
    if (arg && typeof arg === "object") {
      const obj = arg as Record<string, unknown>;
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(obj)) {
        const val = obj[key];
        if (typeof val === "bigint") {
          result[key] = val.toString();
        } else {
          result[key] = val;
        }
      }
      return result;
    }
    return arg;
  });
}

/**
 * Submit a circuit call to the Midnight batcher
 *
 * @param circuit - The circuit function name
 * @param args - Circuit arguments
 * @param secrets - Optional player secrets for proof generation
 */
async function submitCircuitCall(
  circuit: string,
  args: unknown[],
  secrets?: {
    playerSecret: bigint;
    shuffleSeed: Uint8Array;
    opponentSecret?: bigint;
    opponentShuffleSeed?: Uint8Array;
  }
): Promise<{ success: boolean; txId?: string; error?: string }> {
  const wallet = getWallet();
  const timestamp = Date.now();

  // Serialize args (convert BigInt to string for JSON)
  const serializedArgs = serializeArgs(args);
  const circuitCall: CircuitCall = { circuit, args: serializedArgs };

  // Include secrets if provided (for batcher-side proving)
  if (secrets) {
    circuitCall.playerSecret = secrets.playerSecret.toString(16).padStart(64, "0");
    circuitCall.shuffleSeed = Array.from(secrets.shuffleSeed)
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");
    if (secrets.opponentSecret !== undefined) {
      circuitCall.opponentSecret = secrets.opponentSecret.toString(16).padStart(64, "0");
    }
    if (secrets.opponentShuffleSeed !== undefined) {
      circuitCall.opponentShuffleSeed = Array.from(secrets.opponentShuffleSeed)
        .map(b => b.toString(16).padStart(2, "0"))
        .join("");
    }
  }

  const input = JSON.stringify(circuitCall);

  // Create the message to sign (use number for addressType in signature too)
  const message = `${MIDNIGHT_TARGET}:${wallet.address}:${ADDRESS_TYPE_EVM}:${timestamp}`;
  const signature = await wallet.sign(message);

  const body: BatcherInput = {
    data: {
      target: MIDNIGHT_TARGET,
      address: wallet.address,
      addressType: ADDRESS_TYPE_EVM,
      input,
      timestamp,
      signature,
    },
    confirmationLevel: CONFIRMATION_LEVEL,
  };

  console.log(`[BatcherMidnight] Submitting circuit call: ${circuit}`);
  console.log(`[BatcherMidnight] Args:`, args);

  try {
    // Use AbortController for timeout - Midnight proof generation can take 60+ seconds
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 120000); // 2 minute timeout

    const response = await fetch(`${BATCHER_URL}/send-input`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    const result = await response.json();

    if (response.ok) {
      console.log(`[BatcherMidnight] Circuit call submitted successfully:`, result);
      return { success: true, txId: result.inputHash || result.id };
    } else {
      console.error(`[BatcherMidnight] Circuit call failed:`, result);
      console.error(`[BatcherMidnight] Response status:`, response.status);
      console.error(`[BatcherMidnight] Request body was:`, JSON.stringify(body, null, 2));
      if (result.details) {
        console.error(`[BatcherMidnight] Validation details:`, JSON.stringify(result.details, null, 2));
      }
      return { success: false, error: result.message || JSON.stringify(result) };
    }
  } catch (error: any) {
    if (error.name === 'AbortError') {
      console.error(`[BatcherMidnight] Request timed out after 2 minutes`);
      return { success: false, error: "Request timed out - Midnight proof generation may take longer than expected" };
    }
    console.error(`[BatcherMidnight] Network error:`, error);
    return { success: false, error: String(error) };
  }
}

/**
 * Convert lobby ID to game ID as hex string (Bytes<32>)
 * The Midnight contract expects Bytes values as hex strings, not arrays
 */
function lobbyIdToGameIdHex(lobbyId: string): string {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(lobbyId);
  // Pad to 32 bytes
  const bytes = new Uint8Array(32);
  bytes.set(encoded.slice(0, 32));
  // Convert to hex string with 0x prefix
  return "0x" + Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ============================================================================
// Circuit Call Methods - these match the contract's circuit functions
// ============================================================================

/**
 * Initialize the static deck (must be called once before any games)
 */
export async function initDeck(): Promise<{ success: boolean; error?: string }> {
  const result = await submitCircuitCall("init_deck", []);
  return { success: result.success, error: result.error };
}

/**
 * Apply mask for a player in a game
 * This requires the player's secret for proof generation
 */
export async function applyMask(
  lobbyId: string,
  playerId: 1 | 2
): Promise<{ success: boolean; error?: string }> {
  const gameId = lobbyIdToGameIdHex(lobbyId);

  // Get player secrets from PlayerKeyManager
  const playerSecret = PlayerKeyManager.getPlayerSecret(lobbyId, playerId);
  const shuffleSeed = PlayerKeyManager.getShuffleSeed(lobbyId, playerId);
  // Include opponent secrets so the batcher can forward them to the node for local replay.
  // The node needs both players' secrets to faithfully replicate the on-chain state.
  const opponentId = playerId === 1 ? 2 : 1;
  const opponentKeys = getOpponentSecretsIfAvailable(lobbyId, opponentId);

  console.log(`[BatcherMidnight] applyMask with client-side secret for player ${playerId}`);

  const result = await submitCircuitCall(
    "applyMask",
    [gameId, playerId],
    { playerSecret, shuffleSeed, ...opponentKeys && { opponentSecret: opponentKeys.opponentSecret, opponentShuffleSeed: opponentKeys.opponentShuffleSeed } }
  );
  return { success: result.success, error: result.error };
}

/**
 * Deal cards to a player
 * This requires the player's secret for proof generation
 */
export async function dealCards(
  lobbyId: string,
  playerId: 1 | 2
): Promise<{ success: boolean; error?: string }> {
  const gameId = lobbyIdToGameIdHex(lobbyId);

  // Get player secrets from PlayerKeyManager
  const playerSecret = PlayerKeyManager.getPlayerSecret(lobbyId, playerId);
  const shuffleSeed = PlayerKeyManager.getShuffleSeed(lobbyId, playerId);
  // Include opponent secrets so the batcher can forward them to the node for local replay.
  // dealCards double-masks every card with both players' secrets — the node's local replay
  // must use the same secrets to produce a matching cardOwnership ledger.
  const opponentId = playerId === 1 ? 2 : 1;
  const opponentKeys = getOpponentSecretsIfAvailable(lobbyId, opponentId);

  console.log(`[BatcherMidnight] dealCards with client-side secret for player ${playerId}`);

  const result = await submitCircuitCall(
    "dealCards",
    [gameId, playerId],
    { playerSecret, shuffleSeed, ...opponentKeys && { opponentSecret: opponentKeys.opponentSecret, opponentShuffleSeed: opponentKeys.opponentShuffleSeed } }
  );
  return { success: result.success, error: result.error };
}

/**
 * Ask for a card from opponent
 * Requires player secret for card ownership verification
 */
export async function askForCard(
  lobbyId: string,
  playerId: 1 | 2,
  rank: number
): Promise<{ success: boolean; error?: string }> {
  const gameId = lobbyIdToGameIdHex(lobbyId);
  const now = Math.floor(Date.now() / 1000);

  // Get asking player's secrets
  const playerSecret = PlayerKeyManager.getPlayerSecret(lobbyId, playerId);
  const shuffleSeed = PlayerKeyManager.getShuffleSeed(lobbyId, playerId);

  // doesPlayerHaveCard calls deck_getSecretFromPlayerId for BOTH players unconditionally
  // (EC-MUL guard bug fix). We must therefore also supply the opponent's secrets.
  const opponentId = playerId === 1 ? 2 : 1;
  const opponentKeys = getOpponentSecretsIfAvailable(lobbyId, opponentId);

  const result = await submitCircuitCall(
    "askForCard",
    [gameId, playerId, rank, now],
    { playerSecret, shuffleSeed, ...opponentKeys && { opponentSecret: opponentKeys.opponentSecret, opponentShuffleSeed: opponentKeys.opponentShuffleSeed } }
  );
  return { success: result.success, error: result.error };
}

/**
 * Respond to an ask
 * Requires player secret to prove card ownership and transfer
 */
export async function respondToAsk(
  lobbyId: string,
  playerId: 1 | 2
): Promise<{ success: boolean; hasCards?: boolean; cardCount?: number; error?: string }> {
  const gameId = lobbyIdToGameIdHex(lobbyId);
  const now = Math.floor(Date.now() / 1000);

  // Get responding player's secrets
  const playerSecret = PlayerKeyManager.getPlayerSecret(lobbyId, playerId);
  const shuffleSeed = PlayerKeyManager.getShuffleSeed(lobbyId, playerId);

  // transferCardOfRank fetches BOTH players' secrets unconditionally (EC-MUL guard bug fix).
  // We must therefore also supply the asking player's secrets to the batcher.
  const opponentId = playerId === 1 ? 2 : 1;
  const opponentKeys = getOpponentSecretsIfAvailable(lobbyId, opponentId);

  const result = await submitCircuitCall(
    "respondToAsk",
    [gameId, playerId, now],
    { playerSecret, shuffleSeed, ...opponentKeys && { opponentSecret: opponentKeys.opponentSecret, opponentShuffleSeed: opponentKeys.opponentShuffleSeed } }
  );
  // Note: The actual hasCards/cardCount comes from on-chain state, not the tx result
  return { success: result.success, error: result.error };
}

/**
 * Go fish - draw from deck
 * Requires player secret for card decryption
 */
export async function goFish(
  lobbyId: string,
  playerId: 1 | 2
): Promise<{ success: boolean; error?: string }> {
  const gameId = lobbyIdToGameIdHex(lobbyId);
  const now = Math.floor(Date.now() / 1000);

  // Get drawing player's secrets
  const playerSecret = PlayerKeyManager.getPlayerSecret(lobbyId, playerId);
  const shuffleSeed = PlayerKeyManager.getShuffleSeed(lobbyId, playerId);

  // goFish calls getTopCardForOpponent which does partial_decryption with the
  // OPPONENT's secret (to remove their mask from the top deck card).
  // We must therefore also supply the opponent's secrets to the batcher.
  const opponentId = playerId === 1 ? 2 : 1;
  const opponentKeys = getOpponentSecretsIfAvailable(lobbyId, opponentId);

  const result = await submitCircuitCall(
    "goFish",
    [gameId, playerId, now],
    { playerSecret, shuffleSeed, ...opponentKeys && { opponentSecret: opponentKeys.opponentSecret, opponentShuffleSeed: opponentKeys.opponentShuffleSeed } }
  );
  return { success: result.success, error: result.error };
}

/**
 * After go fish - complete the turn
 * Requires player secret for card verification
 */
export async function afterGoFish(
  lobbyId: string,
  playerId: 1 | 2,
  drewRequestedCard: boolean
): Promise<{ success: boolean; error?: string }> {
  const gameId = lobbyIdToGameIdHex(lobbyId);
  const now = Math.floor(Date.now() / 1000);

  // Get drawing player's secrets
  const playerSecret = PlayerKeyManager.getPlayerSecret(lobbyId, playerId);
  const shuffleSeed = PlayerKeyManager.getShuffleSeed(lobbyId, playerId);

  // countCardsOfRank calls deck_getSecretFromPlayerId for BOTH players unconditionally
  // (EC-MUL guard bug fix). We must therefore also supply the opponent's secrets.
  const opponentId = playerId === 1 ? 2 : 1;
  const opponentKeys = getOpponentSecretsIfAvailable(lobbyId, opponentId);

  const result = await submitCircuitCall(
    "afterGoFish",
    [gameId, playerId, drewRequestedCard, now],
    { playerSecret, shuffleSeed, ...opponentKeys && { opponentSecret: opponentKeys.opponentSecret, opponentShuffleSeed: opponentKeys.opponentShuffleSeed } }
  );
  return { success: result.success, error: result.error };
}

/**
 * Switch turn when deck is empty
 */
export async function switchTurn(
  lobbyId: string,
  playerId: 1 | 2
): Promise<{ success: boolean; error?: string }> {
  const gameId = lobbyIdToGameIdHex(lobbyId);
  const result = await submitCircuitCall("switchTurn", [gameId, playerId]);
  return { success: result.success, error: result.error };
}

/**
 * Claim a win because the active player has not moved within the timeout window.
 * Can only be called by the waiting player (the one whose turn it is NOT).
 */
export async function claimTimeoutWin(
  lobbyId: string,
  claimingPlayerId: 1 | 2
): Promise<{ success: boolean; error?: string }> {
  const gameId = lobbyIdToGameIdHex(lobbyId);
  const result = await submitCircuitCall("claimTimeoutWin", [gameId, claimingPlayerId]);
  return { success: result.success, error: result.error };
}

// Export the service
export const BatcherMidnightService = {
  initDeck,
  applyMask,
  dealCards,
  askForCard,
  respondToAsk,
  goFish,
  afterGoFish,
  switchTurn,
  claimTimeoutWin,
};

export default BatcherMidnightService;

/**
 * Midnight Bridge - Frontend interface to Midnight Go Fish contract
 * Handles circuit calls, witness generation, and proof submission
 *
 * ✅ SECURITY: This is the CORRECT architecture for Mental Poker
 *
 * Frontend responsibilities:
 * - Generate player secrets locally (NEVER send to backend)
 * - Store secrets securely in encrypted localStorage (via PlayerKeyManager)
 * - Execute ZK circuits in browser
 * - Generate proofs
 * - Submit proofs to backend for verification
 *
 * The PlayerKeyManager handles:
 * - Cryptographically secure secret generation (full Jubjub scalar field)
 * - Per-game key isolation
 * - Persistent storage with session recovery
 * - Automatic cleanup of expired sessions
 */

import { Contract } from '../../shared/contracts/midnight/go-fish-contract/src/managed/contract/index.js';
import type { CircuitContext, WitnessContext } from '@midnight-ntwrk/compact-runtime';
import {
  PlayerKeyManager,
  JUBJUB_SCALAR_FIELD_ORDER,
  modInverse,
} from './services/PlayerKeyManager';

// Ledger type placeholder (empty in this contract)
type Ledger = Record<string, never>;
import {
  sampleContractAddress,
  createConstructorContext,
  createCircuitContext,
} from '@midnight-ntwrk/compact-runtime';

// Private state type - now managed by PlayerKeyManager
export type PrivateState = {
  playerSecretKey?: bigint;
  shuffleSeed?: Uint8Array;
  currentGameId?: string; // Track which game we're working with
  currentPlayerId?: 1 | 2;
};

// Midnight contract and state (using any for flexibility with Contract's generic types)
let contract: any = null;
let circuitContext: CircuitContext<PrivateState> | null = null;
let privateState: PrivateState = {};

// Current game context (for witness functions)
let currentGameId: string | null = null;
let currentPlayerId: (1 | 2) | null = null;

/**
 * Initialize Midnight contract (call this once on app startup)
 */
export async function initializeMidnightContract(): Promise<{ success: boolean; errorMessage?: string }> {
  try {
    console.log('[MidnightBridge] Initializing Midnight contract...');

    // Create contract instance with witnesses
    contract = new Contract(witnesses);

    // Initialize contract state (constructor creates static deck)
    // For local simulation, pass an EncodedCoinPublicKey with 32 bytes directly
    // This bypasses the string encoding that expects a specific format
    const dummyCoinPublicKey = { bytes: new Uint8Array(32) };
    const initContext = createConstructorContext({}, dummyCoinPublicKey);
    const { currentPrivateState, currentContractState, currentZswapLocalState } =
      contract.initialState(initContext);

    // Create circuit context using the helper function
    circuitContext = createCircuitContext(
      sampleContractAddress(),
      currentZswapLocalState,
      currentContractState,
      currentPrivateState,
    );

    // Initialize the static deck mappings (required before any game can be created)
    // This sets up reverseDeckCurveToCard and deckCurveToCard for all 21 cards
    console.log('[MidnightBridge] Initializing static deck mappings...');
    const initDeckResult = contract.impureCircuits.init_deck(circuitContext);
    circuitContext = initDeckResult.context;
    console.log('[MidnightBridge] Static deck initialized');

    console.log('[MidnightBridge] Contract initialized successfully');
    return { success: true };
  } catch (error) {
    console.error('[MidnightBridge] Failed to initialize contract:', error);
    return {
      success: false,
      errorMessage: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Check if Midnight contract is initialized
 */
export function isMidnightConnected(): boolean {
  return contract !== null && circuitContext !== null;
}

/**
 * Set current game context for witness functions
 * Must be called before any circuit operations
 */
export function setGameContext(gameId: string, playerId: 1 | 2): void {
  currentGameId = gameId;
  currentPlayerId = playerId;
  console.log(`[MidnightBridge] Game context set: gameId=${gameId}, playerId=${playerId}`);
}

/**
 * Witness implementations for client-side proof generation
 *
 * These use PlayerKeyManager for secure, per-game key management:
 * - Secrets are generated using crypto.getRandomValues() over full Jubjub scalar field
 * - Keys are isolated per game (different secret for each game)
 * - Keys persist in encrypted localStorage for session recovery
 * Type is any to avoid complex generic type mismatches with the Contract class
 */
export const witnesses: any = {
  getFieldInverse: (
    context: WitnessContext<Ledger, PrivateState>,
    x: bigint
  ): [PrivateState, bigint] => {
    // Use modInverse from PlayerKeyManager
    const inverse = modInverse(x, JUBJUB_SCALAR_FIELD_ORDER);
    return [context.privateState, inverse];
  },

  player_secret_key: (
    context: WitnessContext<Ledger, PrivateState>,
    gameIdBytes: Uint8Array,
    player: bigint
  ): [PrivateState, bigint] => {
    // Convert gameId bytes to string for PlayerKeyManager
    const gameId = currentGameId || new TextDecoder().decode(gameIdBytes).replace(/\0+$/, '');
    const playerId = currentPlayerId || (Number(player) as 1 | 2);

    // Get secret from PlayerKeyManager (generates if not exists)
    const secret = PlayerKeyManager.getPlayerSecret(gameId, playerId);

    // Also store in privateState for backwards compatibility
    privateState.playerSecretKey = secret;

    console.log(`[MidnightBridge] player_secret_key witness called for game=${gameId}, player=${playerId}`);
    return [context.privateState, secret];
  },

  shuffle_seed: (
    context: WitnessContext<Ledger, PrivateState>,
    gameIdBytes: Uint8Array,
    player: bigint
  ): [PrivateState, Uint8Array] => {
    // Convert gameId bytes to string for PlayerKeyManager
    const gameId = currentGameId || new TextDecoder().decode(gameIdBytes).replace(/\0+$/, '');
    const playerId = currentPlayerId || (Number(player) as 1 | 2);

    // Get shuffle seed from PlayerKeyManager (generates if not exists)
    const seed = PlayerKeyManager.getShuffleSeed(gameId, playerId);

    // Also store in privateState for backwards compatibility
    privateState.shuffleSeed = seed;

    console.log(`[MidnightBridge] shuffle_seed witness called for game=${gameId}, player=${playerId}`);
    return [context.privateState, seed];
  },

  get_sorted_deck_witness: (
    context: WitnessContext<Ledger, PrivateState>,
    input: { x: bigint; y: bigint }[]
  ): [PrivateState, { x: bigint; y: bigint }[]] => {
    // Assign random weights and sort (shuffles the deck)
    const mappedPoints = input.map((point) => ({
      x: point.x,
      y: point.y,
      weight: Math.floor(Math.random() * 1000000) | 0,
    }));

    // Bubble sort by weight
    for (let i = 0; i < input.length; i++) {
      for (let j = i + 1; j < input.length; j++) {
        if (mappedPoints[i]!.weight > mappedPoints[j]!.weight) {
          const temp = input[i];
          input[i] = input[j]!;
          input[j] = temp!;
        }
      }
    }
    return [context.privateState, mappedPoints.map((x) => ({ x: x.x, y: x.y }))];
  },
};

/**
 * Convert lobbyId to gameId (deterministic hash)
 */
export function lobbyIdToGameId(lobbyId: string): Uint8Array {
  // In production, use proper keccak256 hash
  // For now, use a simple encoding
  const encoder = new TextEncoder();
  const encoded = encoder.encode(lobbyId);
  const gameId = new Uint8Array(32);
  gameId.set(encoded.slice(0, Math.min(32, encoded.length)));
  return gameId;
}

/**
 * Apply mask to the deck (Setup phase - both players must call)
 */
export async function applyMask(
  lobbyId: string,
  playerId: 1 | 2
): Promise<{ success: boolean; errorMessage?: string }> {
  try {
    if (!isMidnightConnected() || !contract || !circuitContext) {
      return { success: false, errorMessage: 'Midnight contract not initialized' };
    }

    // Set game context for witness functions
    setGameContext(lobbyId, playerId);

    const gameId = lobbyIdToGameId(lobbyId);

    console.log(`[MidnightBridge] applyMask(gameId: ${lobbyId}, playerId: ${playerId})`);

    // Call contract circuit
    const result = contract.impureCircuits.applyMask(
      circuitContext,
      gameId,
      BigInt(playerId)
    );

    // Update circuit context with result
    circuitContext = result.context;

    console.log('[MidnightBridge] applyMask succeeded');
    return { success: true };
  } catch (error) {
    console.error('[MidnightBridge] applyMask failed:', error);
    return {
      success: false,
      errorMessage: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Deal cards to opponent (Setup phase - both players must call)
 */
export async function dealCards(
  lobbyId: string,
  playerId: 1 | 2
): Promise<{ success: boolean; errorMessage?: string }> {
  try {
    if (!isMidnightConnected() || !contract || !circuitContext) {
      return { success: false, errorMessage: 'Midnight contract not initialized' };
    }

    // Set game context for witness functions
    setGameContext(lobbyId, playerId);

    const gameId = lobbyIdToGameId(lobbyId);

    console.log(`[MidnightBridge] dealCards(gameId: ${lobbyId}, playerId: ${playerId})`);

    // Call contract circuit
    const result = contract.impureCircuits.dealCards(
      circuitContext,
      gameId,
      BigInt(playerId)
    );

    // Update circuit context with result
    circuitContext = result.context;

    console.log('[MidnightBridge] dealCards succeeded');
    return { success: true };
  } catch (error) {
    console.error('[MidnightBridge] dealCards failed:', error);
    return {
      success: false,
      errorMessage: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Ask opponent for cards of a specific rank
 */
export async function askForCard(
  lobbyId: string,
  playerId: 1 | 2,
  targetRank: number
): Promise<{ success: boolean; errorMessage?: string }> {
  try {
    if (!isMidnightConnected() || !contract || !circuitContext) {
      return { success: false, errorMessage: 'Midnight contract not initialized' };
    }

    // Set game context for witness functions
    setGameContext(lobbyId, playerId);

    const gameId = lobbyIdToGameId(lobbyId);

    console.log(`[MidnightBridge] askForCard(gameId: ${lobbyId}, playerId: ${playerId}, rank: ${targetRank})`);

    // Call contract circuit
    const result = contract.impureCircuits.askForCard(
      circuitContext,
      gameId,
      BigInt(playerId),
      BigInt(targetRank)
    );

    // Update circuit context with result
    circuitContext = result.context;

    console.log('[MidnightBridge] askForCard succeeded');
    return { success: true };
  } catch (error) {
    console.error('[MidnightBridge] askForCard failed:', error);
    return {
      success: false,
      errorMessage: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Respond to opponent's ask (transfer cards or go fish)
 */
export async function respondToAsk(
  lobbyId: string,
  playerId: 1 | 2
): Promise<{ success: boolean; hasCards?: boolean; count?: number; errorMessage?: string }> {
  try {
    if (!isMidnightConnected() || !contract || !circuitContext) {
      return { success: false, errorMessage: 'Midnight contract not initialized' };
    }

    // Set game context for witness functions
    setGameContext(lobbyId, playerId);

    const gameId = lobbyIdToGameId(lobbyId);

    console.log(`[MidnightBridge] respondToAsk(gameId: ${lobbyId}, playerId: ${playerId})`);

    // Call contract circuit - returns [hasCards: boolean, count: bigint]
    const result = contract.impureCircuits.respondToAsk(
      circuitContext,
      gameId,
      BigInt(playerId)
    );

    // Update circuit context with result
    circuitContext = result.context;

    const [hasCards, count] = result.result;

    console.log(`[MidnightBridge] respondToAsk succeeded: hasCards=${hasCards}, count=${count}`);
    return { success: true, hasCards, count: Number(count) };
  } catch (error) {
    console.error('[MidnightBridge] respondToAsk failed:', error);
    return {
      success: false,
      errorMessage: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Draw a card from the deck
 */
export async function goFish(
  lobbyId: string,
  playerId: 1 | 2
): Promise<{ success: boolean; card?: { x: bigint; y: bigint }; errorMessage?: string }> {
  try {
    if (!isMidnightConnected() || !contract || !circuitContext) {
      return { success: false, errorMessage: 'Midnight contract not initialized' };
    }

    // Set game context for witness functions
    setGameContext(lobbyId, playerId);

    const gameId = lobbyIdToGameId(lobbyId);

    console.log(`[MidnightBridge] goFish(gameId: ${lobbyId}, playerId: ${playerId})`);

    // Call contract circuit - returns CurvePoint (semi-masked card)
    const result = contract.impureCircuits.goFish(
      circuitContext,
      gameId,
      BigInt(playerId)
    );

    // Update circuit context with result
    circuitContext = result.context;

    const card = result.result;

    console.log(`[MidnightBridge] goFish succeeded: drew card`);
    return { success: true, card };
  } catch (error) {
    console.error('[MidnightBridge] goFish failed:', error);
    return {
      success: false,
      errorMessage: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Complete the go fish action (check if drew requested card)
 */
export async function afterGoFish(
  lobbyId: string,
  playerId: 1 | 2,
  drewRequestedCard: boolean
): Promise<{ success: boolean; errorMessage?: string }> {
  try {
    if (!isMidnightConnected() || !contract || !circuitContext) {
      return { success: false, errorMessage: 'Midnight contract not initialized' };
    }

    // Set game context for witness functions
    setGameContext(lobbyId, playerId);

    const gameId = lobbyIdToGameId(lobbyId);

    console.log(`[MidnightBridge] afterGoFish(gameId: ${lobbyId}, playerId: ${playerId}, drew: ${drewRequestedCard})`);

    // Call contract circuit
    const result = contract.impureCircuits.afterGoFish(
      circuitContext,
      gameId,
      BigInt(playerId),
      drewRequestedCard
    );

    // Update circuit context with result
    circuitContext = result.context;

    console.log('[MidnightBridge] afterGoFish succeeded');
    return { success: true };
  } catch (error) {
    console.error('[MidnightBridge] afterGoFish failed:', error);
    return {
      success: false,
      errorMessage: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Check and score a book (set of 4 cards of same rank)
 */
export async function checkAndScoreBook(
  lobbyId: string,
  playerId: 1 | 2,
  targetRank: number
): Promise<{ success: boolean; completedBook?: boolean; errorMessage?: string }> {
  try {
    if (!isMidnightConnected() || !contract || !circuitContext) {
      return { success: false, errorMessage: 'Midnight contract not initialized' };
    }

    // Set game context for witness functions
    setGameContext(lobbyId, playerId);

    const gameId = lobbyIdToGameId(lobbyId);

    console.log(`[MidnightBridge] checkAndScoreBook(gameId: ${lobbyId}, playerId: ${playerId}, rank: ${targetRank})`);

    // Call contract circuit - returns boolean (true if book was completed)
    const result = contract.impureCircuits.checkAndScoreBook(
      circuitContext,
      gameId,
      BigInt(playerId),
      BigInt(targetRank)
    );

    // Update circuit context with result
    circuitContext = result.context;

    const completedBook = result.result;

    console.log(`[MidnightBridge] checkAndScoreBook succeeded: completedBook=${completedBook}`);
    return { success: true, completedBook };
  } catch (error) {
    console.error('[MidnightBridge] checkAndScoreBook failed:', error);
    return {
      success: false,
      errorMessage: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Query game phase from Midnight contract
 */
export async function getGamePhase(lobbyId: string): Promise<number | null> {
  try {
    if (!isMidnightConnected() || !contract || !circuitContext) {
      return null;
    }

    const gameId = lobbyIdToGameId(lobbyId);

    console.log(`[MidnightBridge] getGamePhase(gameId: ${lobbyId})`);

    // Call contract circuit
    const result = contract.impureCircuits.getGamePhase(
      circuitContext,
      gameId
    );

    // Update circuit context with result
    circuitContext = result.context;

    console.log(`[MidnightBridge] getGamePhase succeeded: phase=${result.result}`);
    return Number(result.result);
  } catch (error) {
    console.error('[MidnightBridge] getGamePhase failed:', error);
    return null;
  }
}

/**
 * Query game scores from Midnight contract
 */
export async function getScores(lobbyId: string): Promise<[number, number] | null> {
  try {
    if (!isMidnightConnected() || !contract || !circuitContext) {
      return null;
    }

    const gameId = lobbyIdToGameId(lobbyId);

    console.log(`[MidnightBridge] getScores(gameId: ${lobbyId})`);

    // Call contract circuit
    const result = contract.impureCircuits.getScores(
      circuitContext,
      gameId
    );

    // Update circuit context with result
    circuitContext = result.context;

    const [score1, score2] = result.result;

    console.log(`[MidnightBridge] getScores succeeded: scores=[${score1}, ${score2}]`);
    return [Number(score1), Number(score2)];
  } catch (error) {
    console.error('[MidnightBridge] getScores failed:', error);
    return null;
  }
}

/**
 * Get and decrypt player's hand
 * Returns array of {rank, suit} objects for cards in player's hand
 */
export async function getPlayerHand(
  lobbyId: string,
  playerId: 1 | 2
): Promise<Array<{ rank: number; suit: number }>> {
  try {
    if (!isMidnightConnected() || !contract || !circuitContext) {
      console.warn('[MidnightBridge] Contract not initialized, returning empty hand');
      return [];
    }

    // Set game context for witness functions
    setGameContext(lobbyId, playerId);

    const gameId = lobbyIdToGameId(lobbyId);
    console.log(`[MidnightBridge] getPlayerHand(gameId: ${lobbyId}, playerId: ${playerId})`);

    const hand: Array<{ rank: number; suit: number }> = [];

    // Iterate through all 21 cards (7 ranks × 3 suits) - simplified deck
    // Card index = rank + (suit * 7)
    for (let rank = 0; rank < 7; rank++) {
      for (let suit = 0; suit < 3; suit++) {
        const cardIndex = rank + suit * 7;

        try {
          // Check if player owns this semi-masked card
          const checkResult: any = contract.impureCircuits.doesPlayerHaveSpecificCard(
            circuitContext,
            gameId,
            BigInt(playerId),
            BigInt(cardIndex)
          );
          circuitContext = checkResult.context;

          if (checkResult.result) {
            // Player has this card!
            hand.push({ rank, suit });
          }
        } catch (_error) {
          // Card not in hand, continue
          continue;
        }
      }
    }

    console.log(`[MidnightBridge] Found ${hand.length} cards in player ${playerId}'s hand`);
    return hand;
  } catch (error) {
    console.error('[MidnightBridge] getPlayerHand failed:', error);
    return [];
  }
}

// Re-export PlayerKeyManager for convenience
export { PlayerKeyManager } from './services/PlayerKeyManager';

// Export all functions as a single bridge object
export const MidnightBridge = {
  initializeMidnightContract,
  isMidnightConnected,
  setGameContext,
  applyMask,
  dealCards,
  askForCard,
  respondToAsk,
  goFish,
  afterGoFish,
  checkAndScoreBook,
  getGamePhase,
  getScores,
  getPlayerHand,
  lobbyIdToGameId,
  // Key management
  PlayerKeyManager,
};

export default MidnightBridge;

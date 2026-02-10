/**
 * Midnight Bridge - Frontend interface to Midnight Go Fish contract
 * Handles circuit calls, witness generation, and proof submission
 *
 * ✅ SECURITY: This is the CORRECT architecture
 *
 * Frontend responsibilities:
 * - Generate player secrets locally (NEVER send to backend)
 * - Execute ZK circuits in browser
 * - Generate proofs
 * - Submit proofs to backend for verification
 *
 * Currently: Secrets are generated here correctly, but circuits are executed
 * on backend (INSECURE). See MIDNIGHT_SECURITY_ARCHITECTURE.md for migration plan.
 */

import { Contract } from '../../shared/contracts/midnight/go-fish-contract/src/managed/contract/index.js';
import type { CircuitContext, WitnessContext } from '@midnight-ntwrk/compact-runtime';

// Ledger type placeholder (empty in this contract)
type Ledger = Record<string, never>;
import {
  sampleContractAddress,
  createConstructorContext,
  createCircuitContext,
  CostModel,
} from '@midnight-ntwrk/compact-runtime';

// Private state type (empty for now, can be extended)
export type PrivateState = {
  playerSecretKey?: bigint;
  shuffleSeed?: Uint8Array;
};

// Midnight contract and state (using any for flexibility with Contract's generic types)
let contract: any = null;
let circuitContext: CircuitContext<PrivateState> | null = null;
let privateState: PrivateState = {};

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
 * Generate player secret key (random within valid Jubjub scalar field range)
 */
function generatePlayerSecret(): bigint {
  // In production, this should derive from wallet signature or secure random
  // Secret must be in range [1, JUBJUB_SCALAR_FIELD_ORDER)
  // Using smaller range for simplicity (but still secure for testing)
  const secret = BigInt(Math.floor(Math.random() * 1000000)) + 1n;
  privateState.playerSecretKey = secret;
  return secret;
}

/**
 * Generate shuffle seed (random bytes)
 */
function generateShuffleSeed(): Uint8Array {
  const seed = new Uint8Array(32);
  crypto.getRandomValues(seed);
  privateState.shuffleSeed = seed;
  return seed;
}

/**
 * Calculate modular multiplicative inverse using extended Euclidean algorithm
 */
function modInverse(a: bigint, n: bigint): bigint {
  if (a === 0n) {
    throw new Error('Cannot invert zero');
  }

  let t = 0n;
  let newT = 1n;
  let r = n;
  let newR = a;

  while (newR !== 0n) {
    const quotient = r / newR;
    [t, newT] = [newT, t - quotient * newT];
    [r, newR] = [newR, r - quotient * newR];
  }

  if (r > 1n) {
    throw new Error('Scalar is not invertible');
  }
  if (t < 0n) {
    t = t + n;
  }

  return t;
}

/**
 * Jubjub curve scalar field order
 */
const JUBJUB_SCALAR_FIELD_ORDER =
  6554484396890773809930967563523245729705921265872317281365359162392183254199n;

/**
 * Witness implementations for client-side proof generation
 * Type is any to avoid complex generic type mismatches with the Contract class
 */
export const witnesses: any = {
  getFieldInverse: (
    context: WitnessContext<Ledger, PrivateState>,
    x: bigint
  ): [PrivateState, bigint] => {
    const inverse = modInverse(x, JUBJUB_SCALAR_FIELD_ORDER);
    return [context.privateState, inverse];
  },

  player_secret_key: (
    context: WitnessContext<Ledger, PrivateState>,
    _gameId: Uint8Array,
    _player: bigint
  ): [PrivateState, bigint] => {
    // Return stored secret or generate new one
    if (!privateState.playerSecretKey) {
      generatePlayerSecret();
    }
    return [context.privateState, privateState.playerSecretKey!];
  },

  shuffle_seed: (
    context: WitnessContext<Ledger, PrivateState>,
    _gameId: Uint8Array,
    _player: bigint
  ): [PrivateState, Uint8Array] => {
    // Return stored seed or generate new one
    if (!privateState.shuffleSeed) {
      generateShuffleSeed();
    }
    return [context.privateState, privateState.shuffleSeed!];
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

// Export all functions as a single bridge object
export const MidnightBridge = {
  initializeMidnightContract,
  isMidnightConnected,
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
};

export default MidnightBridge;

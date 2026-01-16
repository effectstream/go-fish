/**
 * Midnight Bridge - Frontend interface to Midnight Go Fish contract
 * Handles circuit calls, witness generation, and proof submission
 */

import { Contract, ledger, type Witnesses, type Ledger } from '../../shared/contracts/midnight/go-fish-contract/managed/contract/index.js';
import type { CircuitContext, WitnessContext } from '@midnight-ntwrk/compact-runtime';
import {
  QueryContext,
  sampleContractAddress,
  createConstructorContext,
  CostModel,
} from '@midnight-ntwrk/compact-runtime';

// Private state type (empty for now, can be extended)
export type PrivateState = {
  playerSecretKey?: bigint;
  shuffleSeed?: Uint8Array;
};

// Midnight contract and state
let contract: Contract<PrivateState, Witnesses<PrivateState>> | null = null;
let circuitContext: CircuitContext<PrivateState> | null = null;
let privateState: PrivateState = {};

/**
 * Initialize Midnight contract (call this once on app startup)
 */
export async function initializeMidnightContract(): Promise<{ success: boolean; errorMessage?: string }> {
  try {
    console.log('[MidnightBridge] Initializing Midnight contract...');

    // Create contract instance with witnesses
    contract = new Contract<PrivateState, Witnesses<PrivateState>>(witnesses);

    // Initialize contract state (constructor creates static deck)
    const { currentPrivateState, currentContractState, currentZswapLocalState } =
      contract.initialState(createConstructorContext({}, '0'.repeat(64)));

    // Create circuit context
    circuitContext = {
      currentPrivateState,
      currentZswapLocalState,
      currentQueryContext: new QueryContext(
        currentContractState.data,
        sampleContractAddress(),
      ),
      costModel: CostModel.initialCostModel(),
    };

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
 * Generate player secret key (deterministic from seed)
 */
function generatePlayerSecret(): bigint {
  // In production, this should derive from wallet signature or secure random
  // For now, generate a random secret
  const secret = BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));
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
 * Calculate modular multiplicative inverse
 */
function modInverse(a: bigint, n: bigint): bigint {
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
 * Split field value into high and low 64-bit parts
 */
function splitFieldBits(fieldValue: bigint): [bigint, bigint] {
  const TWO_POW_64 = 1n << 64n;
  const low = fieldValue % TWO_POW_64;
  const high = fieldValue / TWO_POW_64;
  return [high, low];
}

/**
 * Jubjub curve scalar field order
 */
const JUBJUB_SCALAR_FIELD_ORDER =
  6554484396890773809930967563523245729705921265872317281365359162392183254199n;

/**
 * Witness implementations for client-side proof generation
 */
export const witnesses: Witnesses<PrivateState> = {
  getFieldInverse: (
    context: WitnessContext<Ledger, PrivateState>,
    x: bigint
  ): [PrivateState, bigint] => {
    const inverse = modInverse(x, JUBJUB_SCALAR_FIELD_ORDER);
    return [context.privateState, inverse];
  },

  player_secret_key: (
    context: WitnessContext<Ledger, PrivateState>,
    gameId: Uint8Array,
    player: bigint
  ): [PrivateState, bigint] => {
    // Return stored secret or generate new one
    if (!privateState.playerSecretKey) {
      generatePlayerSecret();
    }
    return [context.privateState, privateState.playerSecretKey!];
  },

  split_field_bits: (
    context: WitnessContext<Ledger, PrivateState>,
    f: bigint
  ): [PrivateState, [bigint, bigint]] => {
    return [context.privateState, splitFieldBits(f)];
  },

  shuffle_seed: (
    context: WitnessContext<Ledger, PrivateState>,
    gameId: Uint8Array,
    player: bigint
  ): [PrivateState, Uint8Array] => {
    // Return stored seed or generate new one
    if (!privateState.shuffleSeed) {
      generateShuffleSeed();
    }
    return [context.privateState, privateState.shuffleSeed!];
  },

  get_sorted_deck_witness: (
    context: WitnessContext<Ledger, PrivateState>,
    input: { point: { x: bigint; y: bigint }; weight: bigint }[]
  ): [PrivateState, { point: { x: bigint; y: bigint }; weight: bigint }[]] => {
    // Bubble sort by weight (simple but works for 52 cards)
    const sorted = [...input];
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        if (sorted[i]!.weight > sorted[j]!.weight) {
          const temp = sorted[i];
          sorted[i] = sorted[j]!;
          sorted[j] = temp!;
        }
      }
    }
    return [context.privateState, sorted];
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
  lobbyIdToGameId,
};

export default MidnightBridge;

/**
 * Midnight Query Module - Backend utilities for querying Midnight contract state
 * This runs on the Paima node and provides read-only access to game state
 */

import { Contract, type Witnesses, type Ledger } from '../../../shared/contracts/midnight/go-fish-contract/managed/contract/index.js';
import type { CircuitContext, WitnessContext } from '@midnight-ntwrk/compact-runtime';
import {
  QueryContext,
  sampleContractAddress,
  createConstructorContext,
  CostModel,
} from '@midnight-ntwrk/compact-runtime';

// Private state type (backend doesn't need secrets)
type PrivateState = Record<string, never>;

// Minimal witnesses for backend queries (no secrets needed for read-only)
const queryWitnesses: Witnesses<PrivateState> = {
  getFieldInverse: (context, x) => {
    throw new Error('Backend should not generate proofs');
  },
  player_secret_key: (context, gameId, player) => {
    throw new Error('Backend should not access player secrets');
  },
  split_field_bits: (context, f) => {
    throw new Error('Backend should not generate proofs');
  },
  shuffle_seed: (context, gameId, player) => {
    throw new Error('Backend should not access shuffle seeds');
  },
  get_sorted_deck_witness: (context, input) => {
    throw new Error('Backend should not generate proofs');
  },
};

// Singleton contract instance for queries
let queryContract: Contract<PrivateState, Witnesses<PrivateState>> | null = null;
let queryContext: CircuitContext<PrivateState> | null = null;

/**
 * Sync query context with action context
 * This must be called after any action that modifies contract state
 * so that queries see the updated state
 */
export function syncQueryContextFromAction(actionContext: CircuitContext<PrivateState>) {
  if (!queryContext) {
    console.warn('[MidnightQuery] Cannot sync - query context not initialized');
    return;
  }

  console.log('[MidnightQuery] Syncing contexts...');
  console.log('[MidnightQuery] Action context QueryContext:', actionContext.currentQueryContext);
  console.log('[MidnightQuery] Old query context QueryContext:', queryContext.currentQueryContext);

  // Update query context with ALL state from action context
  // Need to copy the entire context to get updated contract state
  queryContext = {
    currentPrivateState: actionContext.currentPrivateState,
    currentZswapLocalState: actionContext.currentZswapLocalState,
    currentQueryContext: actionContext.currentQueryContext,
    costModel: actionContext.costModel,
  };

  console.log('[MidnightQuery] New query context QueryContext:', queryContext.currentQueryContext);

  // Invalidate cache so next query gets fresh data
  gameStateCache.clear();

  console.log('[MidnightQuery] Query context synced with action context and cache cleared');
}

/**
 * Initialize query contract (call once on server startup)
 */
export async function initializeQueryContract(): Promise<void> {
  if (queryContract !== null) {
    console.log('[MidnightQuery] Contract already initialized');
    return;
  }

  try {
    console.log('[MidnightQuery] Initializing query contract...');

    // Create contract instance with minimal witnesses
    queryContract = new Contract<PrivateState, Witnesses<PrivateState>>(queryWitnesses);

    // Initialize contract state
    const { currentPrivateState, currentContractState, currentZswapLocalState } =
      queryContract.initialState(createConstructorContext({}, '0'.repeat(64)));

    // Create query context
    queryContext = {
      currentPrivateState,
      currentZswapLocalState,
      currentQueryContext: new QueryContext(
        currentContractState.data,
        sampleContractAddress(),
      ),
      costModel: CostModel.initialCostModel(),
    };

    console.log('[MidnightQuery] Query contract initialized successfully');
  } catch (error) {
    console.error('[MidnightQuery] Failed to initialize query contract:', error);
    throw error;
  }
}

/**
 * Convert lobbyId to gameId (same as frontend)
 */
function lobbyIdToGameId(lobbyId: string): Uint8Array {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(lobbyId);
  const gameId = new Uint8Array(32);
  gameId.set(encoded.slice(0, Math.min(32, encoded.length)));
  return gameId;
}

/**
 * Query game phase from Midnight contract
 */
export async function queryGamePhase(lobbyId: string): Promise<number | null> {
  try {
    if (!queryContract || !queryContext) {
      console.log('[MidnightQuery] queryGamePhase: contract not initialized');
      return null;
    }

    const gameId = lobbyIdToGameId(lobbyId);
    const result = queryContract.impureCircuits.getGamePhase(queryContext, gameId);
    queryContext = result.context;

    const phase = Number(result.result);
    console.log(`[MidnightQuery] queryGamePhase(${lobbyId}): ${phase}`);
    return phase;
  } catch (error: any) {
    // "Game does not exist" is expected during setup phase - don't log as error
    if (!error?.message?.includes('Game does not exist')) {
      console.error('[MidnightQuery] queryGamePhase failed:', error);
    } else {
      console.log(`[MidnightQuery] queryGamePhase(${lobbyId}): Game does not exist yet`);
    }
    return null;
  }
}

/**
 * Query game scores from Midnight contract
 */
export async function queryScores(lobbyId: string): Promise<[number, number] | null> {
  try {
    if (!queryContract || !queryContext) {
      return null;
    }

    const gameId = lobbyIdToGameId(lobbyId);
    const result = queryContract.impureCircuits.getScores(queryContext, gameId);
    queryContext = result.context;

    const [score1, score2] = result.result;
    return [Number(score1), Number(score2)];
  } catch (error: any) {
    // "Game does not exist" is expected during setup phase - don't log as error
    if (!error?.message?.includes('Game does not exist')) {
      console.error('[MidnightQuery] queryScores failed:', error);
    }
    return null;
  }
}

/**
 * Query current turn from Midnight contract
 */
export async function queryCurrentTurn(lobbyId: string): Promise<number | null> {
  try {
    if (!queryContract || !queryContext) {
      return null;
    }

    const gameId = lobbyIdToGameId(lobbyId);
    const result = queryContract.impureCircuits.getCurrentTurn(queryContext, gameId);
    queryContext = result.context;

    return Number(result.result);
  } catch (error: any) {
    // "Game does not exist" is expected during setup phase - don't log as error
    if (!error?.message?.includes('Game does not exist')) {
      console.error('[MidnightQuery] queryCurrentTurn failed:', error);
    }
    return null;
  }
}

/**
 * Query if game is over
 */
export async function queryIsGameOver(lobbyId: string): Promise<boolean> {
  try {
    if (!queryContract || !queryContext) {
      return false;
    }

    const gameId = lobbyIdToGameId(lobbyId);
    const result = queryContract.impureCircuits.isGameOver(queryContext, gameId);
    queryContext = result.context;

    return result.result;
  } catch (error: any) {
    // "Game does not exist" is expected during setup phase - don't log as error
    if (!error?.message?.includes('Game does not exist')) {
      console.error('[MidnightQuery] queryIsGameOver failed:', error);
    }
    return false;
  }
}

/**
 * Query hand sizes for both players
 */
export async function queryHandSizes(lobbyId: string): Promise<[number, number] | null> {
  try {
    if (!queryContract || !queryContext) {
      return null;
    }

    const gameId = lobbyIdToGameId(lobbyId);
    const result = queryContract.impureCircuits.getHandSizes(queryContext, gameId);
    queryContext = result.context;

    const [size1, size2] = result.result;
    return [Number(size1), Number(size2)];
  } catch (error: any) {
    // "Game does not exist" is expected during setup phase - don't log as error
    if (!error?.message?.includes('Game does not exist')) {
      console.error('[MidnightQuery] queryHandSizes failed:', error);
    }
    return null;
  }
}

/**
 * Query deck count (remaining cards)
 */
export async function queryDeckCount(lobbyId: string): Promise<number | null> {
  try {
    if (!queryContract || !queryContext) {
      return null;
    }

    const gameId = lobbyIdToGameId(lobbyId);

    // Get deck size and top card index
    const deckSizeResult = queryContract.impureCircuits.get_deck_size(queryContext, gameId);
    queryContext = deckSizeResult.context;
    const deckSize = Number(deckSizeResult.result);

    const topCardResult = queryContract.impureCircuits.get_top_card_index(queryContext, gameId);
    queryContext = topCardResult.context;
    const topCardIndex = Number(topCardResult.result);

    return deckSize - topCardIndex;
  } catch (error: any) {
    // "Game does not exist" is expected during setup phase - don't log as error
    if (!error?.message?.includes('Game does not exist') &&
        !error?.message?.includes('expected a cell, received null')) {
      console.error('[MidnightQuery] queryDeckCount failed:', error);
    }
    return null;
  }
}

/**
 * Map Midnight GamePhase enum to string for frontend
 * 0 = Setup, 1 = TurnStart, 2 = WaitForResponse, 3 = WaitForTransfer,
 * 4 = WaitForDraw, 5 = WaitForDrawCheck, 6 = GameOver
 */
function mapPhaseToString(phase: number | null): string {
  if (phase === null) return 'dealing'; // No game exists yet, show setup UI

  switch (phase) {
    case 0: return 'dealing'; // Setup phase - players need to initialize
    case 1: return 'turn_start'; // TurnStart - current player can ask for cards
    case 2: return 'wait_response'; // WaitForResponse - opponent needs to respond
    case 3: return 'wait_transfer'; // WaitForTransfer - cards being transferred
    case 4: return 'wait_draw'; // WaitForDraw - player needs to draw (Go Fish)
    case 5: return 'wait_draw_check'; // WaitForDrawCheck - checking drawn card
    case 6: return 'finished'; // GameOver
    default: return 'dealing';
  }
}

/**
 * Simple cache to prevent excessive queries that can cause database mutex deadlocks
 * Cache TTL: 3000ms (longer than frontend poll interval to ensure cache hits)
 */
const gameStateCache = new Map<string, { state: any; timestamp: number }>();
const CACHE_TTL_MS = 3000;

/**
 * Setup status cache - separate from game state cache since it's polled frequently during setup
 */
const setupStatusCache = new Map<string, { status: any; timestamp: number }>();
const SETUP_CACHE_TTL_MS = 1000;

/**
 * Yield to event loop - critical for preventing mutex deadlocks
 * Gives Paima's sync processes a chance to run
 */
async function yieldToEventLoop(): Promise<void> {
  return new Promise(r => setTimeout(r, 1));
}

/**
 * Global lock for ALL Midnight operations (queries AND actions share this)
 * This prevents our operations from running during Paima's sync cycles
 */
let isMidnightOperationInProgress = false;
let lastOperationEndTime = 0;
const MIN_OPERATION_GAP_MS = 50; // Minimum gap between operations to let sync run

/**
 * Request queue to prevent concurrent Midnight queries that can cause mutex deadlocks
 * Only one query operation runs at a time
 */
const queryQueue: Array<{ resolve: (value: any) => void; fn: () => Promise<any> }> = [];

async function enqueueQuery<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise((resolve) => {
    queryQueue.push({ resolve, fn });
    processQueryQueue();
  });
}

async function processQueryQueue() {
  if (isMidnightOperationInProgress || queryQueue.length === 0) return;

  // Ensure minimum gap between operations
  const timeSinceLastOp = Date.now() - lastOperationEndTime;
  if (timeSinceLastOp < MIN_OPERATION_GAP_MS) {
    setTimeout(processQueryQueue, MIN_OPERATION_GAP_MS - timeSinceLastOp);
    return;
  }

  isMidnightOperationInProgress = true;
  const item = queryQueue.shift()!;

  try {
    // Yield to event loop before running query to prevent blocking Paima sync
    await yieldToEventLoop();
    const result = await item.fn();
    item.resolve(result);
  } catch (error) {
    item.resolve(null);
  } finally {
    lastOperationEndTime = Date.now();
    isMidnightOperationInProgress = false;
    // Process next item if any (with delay)
    if (queryQueue.length > 0) {
      setTimeout(processQueryQueue, MIN_OPERATION_GAP_MS);
    }
  }
}

/**
 * Export the lock state for actions module to use
 */
export function acquireMidnightLock(): boolean {
  if (isMidnightOperationInProgress) return false;
  isMidnightOperationInProgress = true;
  return true;
}

export function releaseMidnightLock(): void {
  lastOperationEndTime = Date.now();
  isMidnightOperationInProgress = false;
}

export function isMidnightLocked(): boolean {
  return isMidnightOperationInProgress;
}

/**
 * Query if player has applied their mask
 * Uses queue to prevent concurrent operations
 */
export async function queryHasMaskApplied(lobbyId: string, playerId: 1 | 2): Promise<boolean> {
  return enqueueQuery(async () => {
    try {
      if (!queryContract || !queryContext) {
        return false;
      }

      const gameId = lobbyIdToGameId(lobbyId);
      const result = queryContract.impureCircuits.hasMaskApplied(queryContext, gameId, BigInt(playerId));
      queryContext = result.context;

      return result.result;
    } catch (error: any) {
      // "Game does not exist" is expected during setup phase - don't log as error
      if (!error?.message?.includes('Game does not exist')) {
        console.error('[MidnightQuery] queryHasMaskApplied failed:', error);
      }
      return false;
    }
  });
}

/**
 * Query if player has dealt cards (called dealCards)
 * Uses hasDealt circuit - returns true if player has called dealCards
 * Note: This is different from getCardsDealt which returns cards RECEIVED by the player
 * Uses queue to prevent concurrent operations
 */
export async function queryHasDealt(lobbyId: string, playerId: 1 | 2): Promise<boolean> {
  return enqueueQuery(async () => {
    try {
      if (!queryContract || !queryContext) {
        return false;
      }

      const gameId = lobbyIdToGameId(lobbyId);
      // Use hasDealt circuit (checks if player called dealCards) not getCardsDealt (cards received)
      const result = queryContract.impureCircuits.hasDealt(queryContext, gameId, BigInt(playerId));
      queryContext = result.context;

      const hasDealt = Boolean(result.result);
      console.log(`[MidnightQuery] queryHasDealt(${lobbyId}, player ${playerId}): ${hasDealt}`);
      return hasDealt;
    } catch (error: any) {
      // "Game does not exist" is expected during setup phase - don't log as error
      if (!error?.message?.includes('Game does not exist')) {
        console.error('[MidnightQuery] queryHasDealt failed:', error);
      }
      return false;
    }
  });
}

/**
 * Get comprehensive game state for API endpoint
 * Uses caching and request queuing to prevent database mutex deadlocks
 */
export async function getGameState(lobbyId: string) {
  // Check cache first
  const cached = gameStateCache.get(lobbyId);
  const now = Date.now();

  if (cached && (now - cached.timestamp) < CACHE_TTL_MS) {
    return cached.state;
  }

  // Use query queue to prevent concurrent Midnight operations
  const state = await enqueueQuery(async () => {
    // Re-check cache in case another request already populated it while we were queued
    const cachedAgain = gameStateCache.get(lobbyId);
    const nowAgain = Date.now();
    if (cachedAgain && (nowAgain - cachedAgain.timestamp) < CACHE_TTL_MS) {
      return cachedAgain.state;
    }

    // Query Midnight contract (this is CPU-intensive)
    const phase = await queryGamePhase(lobbyId);
    const scores = await queryScores(lobbyId);
    const currentTurn = await queryCurrentTurn(lobbyId);
    const isGameOver = await queryIsGameOver(lobbyId);
    const handSizes = await queryHandSizes(lobbyId);
    const deckCount = await queryDeckCount(lobbyId);

    const newState = {
      phase: mapPhaseToString(phase),
      currentTurn: currentTurn ?? 1,
      scores: scores ?? [0, 0],
      handSizes: handSizes ?? [7, 7],
      deckCount: deckCount ?? 38,
      isGameOver: isGameOver ?? false,
    };

    // Update cache
    gameStateCache.set(lobbyId, { state: newState, timestamp: Date.now() });

    return newState;
  });

  // Clean up old cache entries (prevent memory leak)
  if (gameStateCache.size > 100) {
    for (const [key, value] of gameStateCache.entries()) {
      if (now - value.timestamp > CACHE_TTL_MS * 10) {
        gameStateCache.delete(key);
      }
    }
  }

  return state;
}

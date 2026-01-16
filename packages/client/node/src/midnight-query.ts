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

  // Update query context with ALL state from action context
  // Need to copy the entire context to get updated contract state
  queryContext = {
    currentPrivateState: actionContext.currentPrivateState,
    currentZswapLocalState: actionContext.currentZswapLocalState,
    currentQueryContext: actionContext.currentQueryContext,
    costModel: actionContext.costModel,
  };

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
    case 1: return 'playing'; // TurnStart - gameplay active
    case 2: return 'playing'; // WaitForResponse
    case 3: return 'playing'; // WaitForTransfer
    case 4: return 'playing'; // WaitForDraw
    case 5: return 'playing'; // WaitForDrawCheck
    case 6: return 'finished'; // GameOver
    default: return 'dealing';
  }
}

/**
 * Simple cache to prevent excessive queries that can cause database mutex deadlocks
 * Cache TTL: 1000ms (frontend polls every 2000ms)
 */
const gameStateCache = new Map<string, { state: any; timestamp: number }>();
const CACHE_TTL_MS = 1000;

/**
 * Query if player has applied their mask
 */
export async function queryHasMaskApplied(lobbyId: string, playerId: 1 | 2): Promise<boolean> {
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
}

/**
 * Query if player has dealt cards
 * Uses getCardsDealt circuit - if result > 0, player has dealt
 */
export async function queryHasDealt(lobbyId: string, playerId: 1 | 2): Promise<boolean> {
  try {
    if (!queryContract || !queryContext) {
      return false;
    }

    const gameId = lobbyIdToGameId(lobbyId);
    const result = queryContract.impureCircuits.getCardsDealt(queryContext, gameId, BigInt(playerId));
    queryContext = result.context;

    // If getCardsDealt returns > 0, the player has dealt cards
    return Number(result.result) > 0;
  } catch (error: any) {
    // "Game does not exist" is expected during setup phase - don't log as error
    if (!error?.message?.includes('Game does not exist')) {
      console.error('[MidnightQuery] queryHasDealt failed:', error);
    }
    return false;
  }
}

/**
 * Get comprehensive game state for API endpoint
 * Uses caching to prevent database mutex deadlocks from excessive queries
 */
export async function getGameState(lobbyId: string) {
  // Check cache first
  const cached = gameStateCache.get(lobbyId);
  const now = Date.now();

  if (cached && (now - cached.timestamp) < CACHE_TTL_MS) {
    return cached.state;
  }

  // Query Midnight contract (this is CPU-intensive and can cause mutex issues)
  const phase = await queryGamePhase(lobbyId);
  const scores = await queryScores(lobbyId);
  const currentTurn = await queryCurrentTurn(lobbyId);
  const isGameOver = await queryIsGameOver(lobbyId);
  const handSizes = await queryHandSizes(lobbyId);
  const deckCount = await queryDeckCount(lobbyId);

  const state = {
    phase: mapPhaseToString(phase),
    currentTurn: currentTurn ?? 1,
    scores: scores ?? [0, 0],
    handSizes: handSizes ?? [7, 7],
    deckCount: deckCount ?? 38,
    isGameOver: isGameOver ?? false,
  };

  // Update cache
  gameStateCache.set(lobbyId, { state, timestamp: now });

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

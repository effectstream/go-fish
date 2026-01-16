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
      console.warn('[MidnightQuery] Contract not initialized, returning null');
      return null;
    }

    const gameId = lobbyIdToGameId(lobbyId);
    const result = queryContract.impureCircuits.getGamePhase(queryContext, gameId);
    queryContext = result.context;

    return Number(result.result);
  } catch (error) {
    console.error('[MidnightQuery] queryGamePhase failed:', error);
    return null;
  }
}

/**
 * Query game scores from Midnight contract
 */
export async function queryScores(lobbyId: string): Promise<[number, number] | null> {
  try {
    if (!queryContract || !queryContext) {
      console.warn('[MidnightQuery] Contract not initialized, returning null');
      return null;
    }

    const gameId = lobbyIdToGameId(lobbyId);
    const result = queryContract.impureCircuits.getScores(queryContext, gameId);
    queryContext = result.context;

    const [score1, score2] = result.result;
    return [Number(score1), Number(score2)];
  } catch (error) {
    console.error('[MidnightQuery] queryScores failed:', error);
    return null;
  }
}

/**
 * Query current turn from Midnight contract
 */
export async function queryCurrentTurn(lobbyId: string): Promise<number | null> {
  try {
    if (!queryContract || !queryContext) {
      console.warn('[MidnightQuery] Contract not initialized, returning null');
      return null;
    }

    const gameId = lobbyIdToGameId(lobbyId);
    const result = queryContract.impureCircuits.getCurrentTurn(queryContext, gameId);
    queryContext = result.context;

    return Number(result.result);
  } catch (error) {
    console.error('[MidnightQuery] queryCurrentTurn failed:', error);
    return null;
  }
}

/**
 * Query if game is over
 */
export async function queryIsGameOver(lobbyId: string): Promise<boolean> {
  try {
    if (!queryContract || !queryContext) {
      console.warn('[MidnightQuery] Contract not initialized, returning false');
      return false;
    }

    const gameId = lobbyIdToGameId(lobbyId);
    const result = queryContract.impureCircuits.isGameOver(queryContext, gameId);
    queryContext = result.context;

    return result.result;
  } catch (error) {
    console.error('[MidnightQuery] queryIsGameOver failed:', error);
    return false;
  }
}

/**
 * Query hand sizes for both players
 */
export async function queryHandSizes(lobbyId: string): Promise<[number, number] | null> {
  try {
    if (!queryContract || !queryContext) {
      console.warn('[MidnightQuery] Contract not initialized, returning null');
      return null;
    }

    const gameId = lobbyIdToGameId(lobbyId);
    const result = queryContract.impureCircuits.getHandSizes(queryContext, gameId);
    queryContext = result.context;

    const [size1, size2] = result.result;
    return [Number(size1), Number(size2)];
  } catch (error) {
    console.error('[MidnightQuery] queryHandSizes failed:', error);
    return null;
  }
}

/**
 * Query deck count (remaining cards)
 */
export async function queryDeckCount(lobbyId: string): Promise<number | null> {
  try {
    if (!queryContract || !queryContext) {
      console.warn('[MidnightQuery] Contract not initialized, returning null');
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
  } catch (error) {
    console.error('[MidnightQuery] queryDeckCount failed:', error);
    return null;
  }
}

/**
 * Get comprehensive game state for API endpoint
 */
export async function getGameState(lobbyId: string) {
  const phase = await queryGamePhase(lobbyId);
  const scores = await queryScores(lobbyId);
  const currentTurn = await queryCurrentTurn(lobbyId);
  const isGameOver = await queryIsGameOver(lobbyId);
  const handSizes = await queryHandSizes(lobbyId);
  const deckCount = await queryDeckCount(lobbyId);

  return {
    phase: phase ?? 'Setup',
    currentTurn: currentTurn ?? 1,
    scores: scores ?? [0, 0],
    handSizes: handSizes ?? [7, 7],
    deckCount: deckCount ?? 38,
    isGameOver: isGameOver ?? false,
  };
}

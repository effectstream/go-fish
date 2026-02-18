/**
 * Midnight Query Module - Backend utilities for querying Midnight contract state
 * This runs on the Paima node and provides read-only access to game state
 *
 * In batcher mode, queries are routed to the on-chain service which queries
 * the Midnight indexer directly. In local mode, queries use a local simulation.
 */

import { Contract } from '../../../shared/contracts/midnight/go-fish-contract/src/managed/contract/index.js';
import type { CircuitContext, WitnessContext } from '@midnight-ntwrk/compact-runtime';
import {
  QueryContext,
  sampleContractAddress,
  createConstructorContext,
  CostModel,
} from '@midnight-ntwrk/compact-runtime';
import {
  queryOnChainSetupStatus,
  queryOnChainGameState,
  queryOnChainGamePhase,
  queryGameExists,
  initializeOnChainService,
  isOnChainServiceAvailable,
} from './midnight-onchain.ts';

// Check if running in batcher mode (queries should use on-chain indexer)
function isInBatcherMode(): boolean {
  // Check environment variable first
  const envBatcherMode = Deno.env.get("USE_BATCHER_MODE");
  if (envBatcherMode === "true") {
    console.log("[MidnightQuery] Batcher mode enabled via USE_BATCHER_MODE env");
    return true;
  }
  // Check runtime config file
  try {
    const configPath = new URL("../runtime-config.json", import.meta.url);
    console.log(`[MidnightQuery] Looking for config at: ${configPath.pathname}`);
    const configText = Deno.readTextFileSync(configPath);
    const config = JSON.parse(configText);
    console.log(`[MidnightQuery] runtime-config.json: ${JSON.stringify(config)}`);
    if (config.useBatcherMode === true) {
      console.log("[MidnightQuery] Batcher mode enabled via runtime-config.json");
      return true;
    }
  } catch (error) {
    console.log(`[MidnightQuery] Could not read runtime-config.json: ${error}`);
  }
  console.log("[MidnightQuery] Batcher mode NOT enabled");
  return false;
}

const USE_BATCHER_MODE = isInBatcherMode();
console.log(`[MidnightQuery] === Final batcher mode setting: ${USE_BATCHER_MODE} ===`);

// Private state type (backend doesn't need secrets)
type PrivateState = Record<string, never>;

// Minimal witnesses for backend queries (no secrets needed for read-only)
// Type is any to avoid complex generic type mismatches with the Contract class
const queryWitnesses: any = {
  getFieldInverse: (_context: any, _x: any) => {
    throw new Error('Backend should not generate proofs');
  },
  player_secret_key: (_context: any, _gameId: any, _player: any) => {
    throw new Error('Backend should not access player secrets');
  },
  shuffle_seed: (_context: any, _gameId: any, _player: any) => {
    throw new Error('Backend should not access shuffle seeds');
  },
  get_sorted_deck_witness: (_context: any, _input: any) => {
    throw new Error('Backend should not generate proofs');
  },
};

// Singleton contract instance for queries (using any for flexibility)
let queryContract: any = null;
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
 * In batcher mode, initializes the on-chain service for indexer queries.
 * In local mode, initializes a local circuit simulation.
 */
export async function initializeQueryContract(): Promise<void> {
  // In batcher mode, initialize the on-chain service instead
  if (USE_BATCHER_MODE) {
    console.log('[MidnightQuery] Batcher mode - initializing on-chain service...');
    await initializeOnChainService();
    console.log('[MidnightQuery] On-chain service initialized for batcher mode');
    return;
  }

  if (queryContract !== null) {
    console.log('[MidnightQuery] Contract already initialized');
    return;
  }

  try {
    console.log('[MidnightQuery] Initializing local query contract...');

    // Create contract instance with minimal witnesses
    queryContract = new Contract(queryWitnesses);

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

    console.log('[MidnightQuery] Local query contract initialized successfully');
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
 * In batcher mode, queries the Midnight indexer directly.
 */
export async function queryGamePhase(lobbyId: string): Promise<number | null> {
  // In batcher mode, query the on-chain state via indexer
  if (USE_BATCHER_MODE) {
    try {
      const phase = await queryOnChainGamePhase(lobbyId);
      console.log(`[MidnightQuery] On-chain queryGamePhase(${lobbyId}): ${phase}`);
      return phase;
    } catch (error) {
      console.error('[MidnightQuery] On-chain queryGamePhase failed:', error);
      return null;
    }
  }

  // Local mode
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
 * Cache TTL: 5000ms - longer to reduce query frequency
 */
const gameStateCache = new Map<string, { state: any; timestamp: number }>();
const CACHE_TTL_MS = 5000;

/**
 * Setup status cache - separate from game state cache since it's polled frequently during setup
 */
const setupStatusCache = new Map<string, { status: any; timestamp: number }>();
const SETUP_CACHE_TTL_MS = 2000;

/**
 * Yield to event loop - critical for preventing mutex deadlocks
 * Gives Paima's sync processes a chance to run
 * Uses 10ms delay to give sync processes real time to execute
 */
async function yieldToEventLoop(): Promise<void> {
  return new Promise(r => setTimeout(r, 10));
}

/**
 * Global lock for ALL Midnight operations (queries AND actions share this)
 * This prevents our operations from running during Paima's sync cycles
 */
let isMidnightOperationInProgress = false;
let lastOperationEndTime = 0;
const MIN_OPERATION_GAP_MS = 200; // Increased gap between operations to let sync run

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
 * Query the last asked rank (for game log display)
 * Returns 255 if no pending request, otherwise 0-12 for rank
 */
export async function queryLastAskedRank(lobbyId: string): Promise<number | null> {
  try {
    if (!queryContract || !queryContext) {
      return null;
    }

    const gameId = lobbyIdToGameId(lobbyId);
    const result = queryContract.impureCircuits.getLastAskedRank(queryContext, gameId);
    queryContext = result.context;

    return Number(result.result);
  } catch (error: any) {
    if (!error?.message?.includes('Game does not exist')) {
      console.error('[MidnightQuery] queryLastAskedRank failed:', error);
    }
    return null;
  }
}

/**
 * Query the last asking player (for game log display)
 * Returns 1 or 2 for the player who last asked for cards
 */
export async function queryLastAskingPlayer(lobbyId: string): Promise<number | null> {
  try {
    if (!queryContract || !queryContext) {
      return null;
    }

    const gameId = lobbyIdToGameId(lobbyId);
    const result = queryContract.impureCircuits.getLastAskingPlayer(queryContext, gameId);
    queryContext = result.context;

    return Number(result.result);
  } catch (error: any) {
    if (!error?.message?.includes('Game does not exist')) {
      console.error('[MidnightQuery] queryLastAskingPlayer failed:', error);
    }
    return null;
  }
}

/**
 * Query if player has applied their mask
 * In batcher mode, queries the Midnight indexer directly.
 * In local mode, uses the local circuit simulation.
 */
export async function queryHasMaskApplied(lobbyId: string, playerId: 1 | 2): Promise<boolean> {
  // In batcher mode, query the on-chain state via indexer
  if (USE_BATCHER_MODE) {
    try {
      const status = await queryOnChainSetupStatus(lobbyId, playerId);
      return status.hasMaskApplied;
    } catch (error) {
      console.error('[MidnightQuery] On-chain queryHasMaskApplied failed:', error);
      return false;
    }
  }

  // Local mode: use circuit simulation
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
 * In batcher mode, queries the Midnight indexer directly.
 * In local mode, uses the local circuit simulation.
 */
export async function queryHasDealt(lobbyId: string, playerId: 1 | 2): Promise<boolean> {
  // In batcher mode, query the on-chain state via indexer
  if (USE_BATCHER_MODE) {
    try {
      const status = await queryOnChainSetupStatus(lobbyId, playerId);
      return status.hasDealt;
    } catch (error) {
      console.error('[MidnightQuery] On-chain queryHasDealt failed:', error);
      return false;
    }
  }

  // Local mode: use circuit simulation
  return enqueueQuery(async () => {
    try {
      if (!queryContract || !queryContext) {
        return false;
      }

      const gameId = lobbyIdToGameId(lobbyId);

      // Try hasDealt circuit first (checks if player called dealCards)
      if (queryContract.impureCircuits.hasDealt) {
        const result = queryContract.impureCircuits.hasDealt(queryContext, gameId, BigInt(playerId));
        queryContext = result.context;
        const hasDealt = Boolean(result.result);
        console.log(`[MidnightQuery] queryHasDealt(${lobbyId}, player ${playerId}): ${hasDealt}`);
        return hasDealt;
      }

      // Fallback: Check if opponent has received cards (player deals to opponent)
      // Player 1 deals to Player 2, Player 2 deals to Player 1
      const opponentId = playerId === 1 ? 2 : 1;
      const cardsDealtResult = queryContract.impureCircuits.getCardsDealt(queryContext, gameId, BigInt(opponentId));
      queryContext = cardsDealtResult.context;
      const cardsDealt = Number(cardsDealtResult.result);
      const hasDealt = cardsDealt > 0;
      console.log(`[MidnightQuery] queryHasDealt(${lobbyId}, player ${playerId}): ${hasDealt} (via getCardsDealt to opponent: ${cardsDealt})`);
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
 * In batcher mode, queries the Midnight indexer directly.
 * In local mode, uses caching and request queuing to prevent database mutex deadlocks.
 */
export async function getGameState(lobbyId: string) {
  // In batcher mode, query the on-chain state via indexer
  if (USE_BATCHER_MODE) {
    try {
      const state = await queryOnChainGameState(lobbyId);
      return state;
    } catch (error) {
      console.error('[MidnightQuery] On-chain getGameState failed:', error);
      // Return fallback state
      return {
        phase: "dealing",
        currentTurn: 1,
        scores: [0, 0],
        handSizes: [7, 7],
        deckCount: 38,
        isGameOver: false,
        lastAskedRank: null,
        lastAskingPlayer: null,
      };
    }
  }

  // Local mode: Check cache first
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
    const lastAskedRank = await queryLastAskedRank(lobbyId);
    const lastAskingPlayer = await queryLastAskingPlayer(lobbyId);

    const newState = {
      phase: mapPhaseToString(phase),
      currentTurn: currentTurn ?? 1,
      scores: scores ?? [0, 0],
      handSizes: handSizes ?? [7, 7],
      deckCount: deckCount ?? 38,
      isGameOver: isGameOver ?? false,
      lastAskedRank: lastAskedRank !== null && lastAskedRank !== 255 ? lastAskedRank : null,
      lastAskingPlayer: lastAskingPlayer ?? null,
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

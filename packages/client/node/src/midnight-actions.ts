/**
 * Midnight Actions - Backend utilities for executing Midnight contract actions
 * This runs on the Paima node and provides write access to the contract
 */

import { Contract } from '../../../shared/contracts/midnight/go-fish-contract/src/managed/contract/index.js';
import type { CircuitContext } from '@midnight-ntwrk/compact-runtime';
import {
  createConstructorContext,
  CostModel,
  QueryContext,
  sampleContractAddress,
} from '@midnight-ntwrk/compact-runtime';
import {
  syncQueryContextFromAction,
  acquireMidnightLock,
  releaseMidnightLock,
  isMidnightLocked,
} from './midnight-query.ts';

// Private state type
type PrivateState = Record<string, never>;

/**
 * Minimum gap between operations to let Paima sync processes run
 * Increased to 200ms to give sync processes more time between our CPU-intensive operations
 */
const MIN_OPERATION_GAP_MS = 200;
let lastActionEndTime = 0;

/**
 * Yield to event loop - critical for preventing mutex deadlocks
 * Uses a longer delay (10ms) to give Paima sync a real chance to run
 */
async function yieldToEventLoop(): Promise<void> {
  return new Promise(r => setTimeout(r, 10));
}

/**
 * Action queue to prevent concurrent Midnight operations that can cause mutex deadlocks
 * Uses shared lock with query module to prevent actions and queries from running simultaneously
 */
let isActionInProgress = false;
const actionQueue: Array<{ resolve: (value: any) => void; fn: () => Promise<any> }> = [];

async function enqueueAction<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise((resolve) => {
    actionQueue.push({ resolve, fn });
    processActionQueue();
  });
}

async function processActionQueue() {
  if (isActionInProgress || actionQueue.length === 0) return;

  // Check if query module has the lock
  if (isMidnightLocked()) {
    // Wait and retry
    setTimeout(processActionQueue, MIN_OPERATION_GAP_MS);
    return;
  }

  // Ensure minimum gap between operations
  const timeSinceLastOp = Date.now() - lastActionEndTime;
  if (timeSinceLastOp < MIN_OPERATION_GAP_MS) {
    setTimeout(processActionQueue, MIN_OPERATION_GAP_MS - timeSinceLastOp);
    return;
  }

  // Try to acquire global lock
  if (!acquireMidnightLock()) {
    setTimeout(processActionQueue, MIN_OPERATION_GAP_MS);
    return;
  }

  isActionInProgress = true;
  const item = actionQueue.shift()!;

  try {
    // Yield to event loop before running action to prevent blocking Paima sync
    await yieldToEventLoop();
    const result = await item.fn();
    item.resolve(result);
  } catch (error: any) {
    item.resolve({ success: false, errorMessage: error.message });
  } finally {
    lastActionEndTime = Date.now();
    isActionInProgress = false;
    releaseMidnightLock();
    // Process next item if any (with delay to let sync run)
    if (actionQueue.length > 0) {
      setTimeout(processActionQueue, MIN_OPERATION_GAP_MS);
    }
  }
}

/**
 * Jubjub curve scalar field order (embedded in BLS12-381)
 * This is the correct modulus for Midnight's elliptic curve operations
 */
const JUBJUB_SCALAR_FIELD_ORDER =
  6554484396890773809930967563523245729705921265872317281365359162392183254199n;

/**
 * ⚠️ SECURITY WARNING ⚠️
 *
 * Backend should NEVER store or generate player secrets in production!
 * This violates the Mental Poker protocol and breaks zero-knowledge properties.
 *
 * Current implementation (TESTING ONLY):
 * - Backend generates secrets for both players
 * - Backend can decrypt both players' hands
 * - Server must be trusted (not truly zero-knowledge)
 *
 * Production implementation must:
 * - Generate all secrets client-side (in browser)
 * - Never send secrets to backend
 * - Backend only handles proof verification and public state
 */
const playerSecrets = new Map<string, bigint>();

// Singleton contract instance (using any for flexibility with Contract's generic types)
let actionContract: any = null;
let actionContext: CircuitContext<PrivateState> | null = null;

/**
 * Witness functions for backend (generates secrets)
 * Type is any to avoid complex generic type mismatches with the Contract class
 */
const actionWitnesses: any = {
  getFieldInverse: (context: any, x: bigint) => {
    // Modular inverse calculation using Jubjub scalar field order
    if (x === 0n) {
      throw new Error('Cannot invert zero');
    }
    return [context.privateState, modInverse(x, JUBJUB_SCALAR_FIELD_ORDER)];
  },

  player_secret_key: (context: any, gameId: Uint8Array, player: bigint) => {
    // ⚠️ INSECURE: Backend should NOT have access to player secrets!
    // Following example.test.ts pattern but this is for TESTING ONLY
    // Convert Uint8Array to hex string for key
    const hexGameId = Array.from(new Uint8Array(gameId)).map(b => b.toString(16).padStart(2, '0')).join('');
    const key = `${hexGameId}-${player}`;

    // Check if we already have a secret for this player/game
    if (playerSecrets.has(key)) {
      return [context.privateState, playerSecrets.get(key)!];
    }

    // Generate a random secret (matches example.test.ts lines 24-28)
    // Secret must be in range [1, JUBJUB_SCALAR_FIELD_ORDER)
    const secret = BigInt(Math.floor(Math.random() * 1000000)) + 1n;
    playerSecrets.set(key, secret);
    console.log(`[MidnightActions] ⚠️  Generated secret for player ${player}: ${secret} (TESTING ONLY - NOT SECURE)`);
    return [context.privateState, secret];
  },

  shuffle_seed: (context: any, gameId: Uint8Array, player: bigint) => {
    // Generate deterministic shuffle seed as Uint8Array(32)
    const seed = new Uint8Array(32);

    // Use gameId and player to generate deterministic seed
    const gameIdBytes = new Uint8Array(gameId);
    for (let i = 0; i < 32; i++) {
      seed[i] = (gameIdBytes[i % gameIdBytes.length] + Number(player) * (i + 1)) % 256;
    }

    return [context.privateState, seed];
  },

  get_sorted_deck_witness: (context: any, input: { x: bigint; y: bigint }[]) => {
    // Assign random weights and sort (shuffles the deck)
    // input is array of { x: bigint, y: bigint } curve points
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
 * Modular inverse using extended Euclidean algorithm
 */
function modInverse(a: bigint, m: bigint): bigint {
  const a_orig = a;
  a = ((a % m) + m) % m;

  let [old_r, r] = [a, m];
  let [old_s, s] = [BigInt(1), BigInt(0)];

  while (r !== BigInt(0)) {
    const quotient = old_r / r;
    [old_r, r] = [r, old_r - quotient * r];
    [old_s, s] = [s, old_s - quotient * s];
  }

  if (old_r !== BigInt(1)) {
    throw new Error(`${a_orig} has no inverse modulo ${m}`);
  }

  return ((old_s % m) + m) % m;
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
 * Initialize action contract (call once on server startup)
 */
export async function initializeActionContract(): Promise<void> {
  if (actionContract !== null) {
    console.log('[MidnightActions] Contract already initialized');
    return;
  }

  try {
    console.log('[MidnightActions] Initializing action contract...');

    // Create contract instance with action witnesses
    actionContract = new Contract(actionWitnesses);

    // Initialize contract state
    const { currentPrivateState, currentContractState, currentZswapLocalState } =
      actionContract.initialState(createConstructorContext({}, '0'.repeat(64)));

    // Create action context
    actionContext = {
      currentPrivateState,
      currentZswapLocalState,
      currentQueryContext: new QueryContext(
        currentContractState.data,
        sampleContractAddress(),
      ),
      costModel: CostModel.initialCostModel(),
    };

    // Initialize the static deck mappings (required before any game can be created)
    // This sets up reverseDeckCurveToCard and deckCurveToCard for all 21 cards
    console.log('[MidnightActions] Initializing static deck mappings...');
    const initDeckResult = actionContract.impureCircuits.init_deck(actionContext);
    actionContext = initDeckResult.context;
    console.log('[MidnightActions] Static deck initialized');

    console.log('[MidnightActions] Action contract initialized successfully');
  } catch (error) {
    console.error('[MidnightActions] Failed to initialize action contract:', error);
    throw error;
  }
}

/**
 * Cache for player hands to reduce circuit calls
 * Key format: `${lobbyId}-${playerId}`
 * Increased TTL to 5 seconds to reduce frequency of expensive hand checks
 */
const playerHandCache = new Map<string, { hand: Array<{ rank: number; suit: number }>; timestamp: number }>();
const HAND_CACHE_TTL_MS = 5000;

/**
 * Get player's decrypted hand
 * Uses action queue to prevent concurrent operations that can cause mutex deadlocks
 * IMPORTANT: This function checks all 52 cards which is very CPU-intensive
 * Uses caching to reduce the frequency of these checks
 */
export async function getPlayerHand(
  lobbyId: string,
  playerId: 1 | 2
): Promise<Array<{ rank: number; suit: number }>> {
  // Check cache first
  const cacheKey = `${lobbyId}-${playerId}`;
  const cached = playerHandCache.get(cacheKey);
  const now = Date.now();

  if (cached && (now - cached.timestamp) < HAND_CACHE_TTL_MS) {
    console.log(`[MidnightActions] getPlayerHand cache hit for ${cacheKey}`);
    return cached.hand;
  }

  return enqueueAction(async () => {
    // Re-check cache in case another request populated it while we were queued
    const cachedAgain = playerHandCache.get(cacheKey);
    const nowAgain = Date.now();
    if (cachedAgain && (nowAgain - cachedAgain.timestamp) < HAND_CACHE_TTL_MS) {
      return cachedAgain.hand;
    }

    if (!actionContract || !actionContext) {
      console.warn('[MidnightActions] Contract not initialized');
      return [];
    }

    const gameId = lobbyIdToGameId(lobbyId);
    console.log(`[MidnightActions] getPlayerHand(gameId: ${lobbyId}, playerId: ${playerId})`);

    const hand: Array<{ rank: number; suit: number }> = [];

    // Iterate through all 21 cards (7 ranks × 3 suits) - simplified deck for Midnight contract
    // Yield to event loop frequently to prevent blocking Paima sync
    // Each circuit call is CPU-intensive WASM, so we yield often
    let cardCount = 0;
    for (let rank = 0; rank < 7; rank++) {
      for (let suit = 0; suit < 3; suit++) {
        // Yield every 4 cards to give sync processes a chance to run
        if (cardCount > 0 && cardCount % 4 === 0) {
          await yieldToEventLoop();
        }
        cardCount++;

        const cardIndex = rank + suit * 7;

        try {
          const checkResult: any = actionContract.impureCircuits.doesPlayerHaveSpecificCard(
            actionContext,
            gameId,
            BigInt(playerId),
            BigInt(cardIndex)
          );
          actionContext = checkResult.context;

          if (checkResult.result) {
            hand.push({ rank, suit });
          }
        } catch (_error) {
          // Card not in hand, continue
          continue;
        }
      }
    }

    console.log(`[MidnightActions] Found ${hand.length} cards in player ${playerId}'s hand`);

    // Update cache
    playerHandCache.set(cacheKey, { hand, timestamp: Date.now() });

    // Clean up old cache entries
    if (playerHandCache.size > 20) {
      for (const [key, value] of playerHandCache.entries()) {
        if (Date.now() - value.timestamp > HAND_CACHE_TTL_MS * 5) {
          playerHandCache.delete(key);
        }
      }
    }

    return hand;
  });
}

/**
 * Invalidate hand cache for a player (call after actions that modify hands)
 */
export function invalidateHandCache(lobbyId: string, playerId?: 1 | 2): void {
  if (playerId) {
    playerHandCache.delete(`${lobbyId}-${playerId}`);
  } else {
    // Invalidate both players
    playerHandCache.delete(`${lobbyId}-1`);
    playerHandCache.delete(`${lobbyId}-2`);
  }
}

/**
 * Execute askForCard action
 */
export async function askForCard(
  lobbyId: string,
  playerId: 1 | 2,
  rank: number
): Promise<{ success: boolean; errorMessage?: string }> {
  return enqueueAction(async () => {
    if (!actionContract || !actionContext) {
      return { success: false, errorMessage: 'Contract not initialized' };
    }

    const gameId = lobbyIdToGameId(lobbyId);
    console.log(`[MidnightActions] askForCard(gameId: ${lobbyId}, playerId: ${playerId}, rank: ${rank})`);

    const result = actionContract.impureCircuits.askForCard(
      actionContext,
      gameId,
      BigInt(playerId),
      BigInt(rank)
    );
    actionContext = result.context;

    // Sync query context so queries see the updated state
    syncQueryContextFromAction(actionContext!);

    console.log('[MidnightActions] askForCard succeeded');
    return { success: true };
  });
}

/**
 * Execute goFish action
 */
export async function goFish(
  lobbyId: string,
  playerId: 1 | 2
): Promise<{ success: boolean; errorMessage?: string }> {
  return enqueueAction(async () => {
    if (!actionContract || !actionContext) {
      return { success: false, errorMessage: 'Contract not initialized' };
    }

    const gameId = lobbyIdToGameId(lobbyId);
    console.log(`[MidnightActions] goFish(gameId: ${lobbyId}, playerId: ${playerId})`);

    const result = actionContract.impureCircuits.goFish(
      actionContext,
      gameId,
      BigInt(playerId)
    );
    actionContext = result.context;

    // Sync query context so queries see the updated state
    syncQueryContextFromAction(actionContext!);

    // Invalidate hand cache since player drew a card
    invalidateHandCache(lobbyId, playerId);

    console.log('[MidnightActions] goFish succeeded');
    return { success: true };
  });
}

/**
 * Execute applyMask action (setup phase)
 */
export async function applyMask(
  lobbyId: string,
  playerId: 1 | 2
): Promise<{ success: boolean; errorMessage?: string }> {
  return enqueueAction(async () => {
    if (!actionContract || !actionContext) {
      return { success: false, errorMessage: 'Contract not initialized' };
    }

    const gameId = lobbyIdToGameId(lobbyId);
    console.log(`[MidnightActions] applyMask(gameId: ${lobbyId}, playerId: ${playerId})`);

    const result = actionContract.impureCircuits.applyMask(
      actionContext,
      gameId,
      BigInt(playerId)
    );
    actionContext = result.context;

    // Sync query context so queries see the updated state
    syncQueryContextFromAction(actionContext!);

    console.log('[MidnightActions] applyMask succeeded');
    return { success: true };
  });
}

/**
 * Execute dealCards action (setup phase)
 */
export async function dealCards(
  lobbyId: string,
  playerId: 1 | 2
): Promise<{ success: boolean; errorMessage?: string }> {
  return enqueueAction(async () => {
    if (!actionContract || !actionContext) {
      return { success: false, errorMessage: 'Contract not initialized' };
    }

    const gameId = lobbyIdToGameId(lobbyId);
    console.log(`[MidnightActions] dealCards(gameId: ${lobbyId}, playerId: ${playerId})`);

    const result = actionContract.impureCircuits.dealCards(
      actionContext,
      gameId,
      BigInt(playerId)
    );
    actionContext = result.context;

    // Query the phase from the action context immediately after dealCards
    // to verify the state was actually updated
    try {
      const phaseCheck = actionContract.impureCircuits.getGamePhase(actionContext, gameId);
      console.log(`[MidnightActions] dealCards - phase in action context BEFORE sync: ${phaseCheck.result}`);
      actionContext = phaseCheck.context;
    } catch (e) {
      console.log('[MidnightActions] dealCards - could not query phase from action context:', e);
    }

    // Sync query context so queries see the updated state
    syncQueryContextFromAction(actionContext!);

    // Invalidate hand cache since cards were dealt
    invalidateHandCache(lobbyId);

    console.log('[MidnightActions] dealCards succeeded');
    return { success: true };
  });
}

/**
 * Execute respondToAsk action (opponent responds to an ask)
 * Returns whether cards were transferred and how many
 */
export async function respondToAsk(
  lobbyId: string,
  playerId: 1 | 2
): Promise<{ success: boolean; hasCards: boolean; cardCount: number; errorMessage?: string }> {
  return enqueueAction(async () => {
    if (!actionContract || !actionContext) {
      return { success: false, hasCards: false, cardCount: 0, errorMessage: 'Contract not initialized' };
    }

    const gameId = lobbyIdToGameId(lobbyId);
    console.log(`[MidnightActions] respondToAsk(gameId: ${lobbyId}, playerId: ${playerId})`);

    // First verify game phase is correct
    try {
      const phaseCheck = actionContract.impureCircuits.getGamePhase(actionContext, gameId);
      actionContext = phaseCheck.context;
      console.log(`[MidnightActions] respondToAsk - current phase: ${phaseCheck.result}`);

      // Phase 2 = WaitForResponse (compare as Number since BigInt comparison can be tricky)
      if (Number(phaseCheck.result) !== 2) {
        return {
          success: false,
          hasCards: false,
          cardCount: 0,
          errorMessage: `Wrong phase for respondToAsk. Expected WaitForResponse (2), got ${phaseCheck.result}`
        };
      }
    } catch (phaseError: any) {
      console.error('[MidnightActions] Failed to check phase before respondToAsk:', phaseError);
      return {
        success: false,
        hasCards: false,
        cardCount: 0,
        errorMessage: `Failed to verify game phase: ${phaseError.message}`
      };
    }

    let result;
    try {
      result = actionContract.impureCircuits.respondToAsk(
        actionContext,
        gameId,
        BigInt(playerId)
      );
      actionContext = result.context;
    } catch (respondError: any) {
      console.error('[MidnightActions] respondToAsk circuit failed:', respondError);
      // Try to provide more context about the error
      let errorDetails = respondError.message;
      if (errorDetails.includes('expected a cell, received null')) {
        errorDetails = 'State lookup failed - a required mapping (card ownership, player secret, or semi-masked mapping) is missing. This may indicate state corruption or a card that was never properly registered.';
      }
      return {
        success: false,
        hasCards: false,
        cardCount: 0,
        errorMessage: `Circuit error: ${errorDetails}`
      };
    }

    // respondToAsk returns [Boolean, Uint<8>] - whether cards transferred and count
    const [hasCards, cardCount] = result.result;

    // If cards were transferred, check if the asking player (not responding player) now has a book
    // The asking player is the opponent of the responding player
    if (hasCards) {
      const askingPlayerId: 1 | 2 = playerId === 1 ? 2 : 1;
      await checkAndScoreBooksInternal(gameId, askingPlayerId);
    }

    // Sync query context so queries see the updated state
    syncQueryContextFromAction(actionContext!);

    // Invalidate hand cache for both players since cards may have been transferred
    invalidateHandCache(lobbyId);

    console.log(`[MidnightActions] respondToAsk succeeded: hasCards=${hasCards}, cardCount=${cardCount}`);
    return { success: true, hasCards: Boolean(hasCards), cardCount: Number(cardCount) };
  });
}

/**
 * Execute afterGoFish action (complete the Go Fish turn)
 * This is called after a player draws from the deck to check if they got the requested card
 * @param drewRequestedCard - whether the drawn card matches what was asked for
 */
export async function afterGoFish(
  lobbyId: string,
  playerId: 1 | 2,
  drewRequestedCard: boolean
): Promise<{ success: boolean; errorMessage?: string }> {
  return enqueueAction(async () => {
    if (!actionContract || !actionContext) {
      return { success: false, errorMessage: 'Contract not initialized' };
    }

    const gameId = lobbyIdToGameId(lobbyId);
    console.log(`[MidnightActions] afterGoFish(gameId: ${lobbyId}, playerId: ${playerId}, drewRequestedCard: ${drewRequestedCard})`);

    const result = actionContract.impureCircuits.afterGoFish(
      actionContext,
      gameId,
      BigInt(playerId),
      drewRequestedCard
    );
    actionContext = result.context;

    // After drawing, check for books (player might have completed a book)
    await checkAndScoreBooksInternal(gameId, playerId);

    // Sync query context so queries see the updated state
    syncQueryContextFromAction(actionContext!);

    // Invalidate hand cache since turn changed
    invalidateHandCache(lobbyId);

    console.log('[MidnightActions] afterGoFish succeeded');
    return { success: true };
  });
}

/**
 * Skip draw when deck is empty - ends turn without drawing
 * Called when a player needs to "Go Fish" but the deck has no cards
 */
export async function skipDrawDeckEmpty(
  lobbyId: string,
  playerId: 1 | 2
): Promise<{ success: boolean; errorMessage?: string }> {
  return enqueueAction(async () => {
    if (!actionContract || !actionContext) {
      return { success: false, errorMessage: 'Contract not initialized' };
    }

    const gameId = lobbyIdToGameId(lobbyId);
    console.log(`[MidnightActions] skipDrawDeckEmpty(gameId: ${lobbyId}, playerId: ${playerId})`);

    try {
      const result = actionContract.impureCircuits.skipDrawDeckEmpty(
        actionContext,
        gameId,
        BigInt(playerId)
      );
      actionContext = result.context;

      // Sync query context so queries see the updated state
      syncQueryContextFromAction(actionContext!);

      // Invalidate hand cache since turn changed
      invalidateHandCache(lobbyId);

      console.log('[MidnightActions] skipDrawDeckEmpty succeeded - turn ended without drawing');
      return { success: true };
    } catch (error: any) {
      console.error('[MidnightActions] skipDrawDeckEmpty failed:', error);
      return { success: false, errorMessage: error.message || String(error) };
    }
  });
}

/**
 * Internal helper to check all ranks for books (called after hand changes)
 * This is NOT queued since it runs inside an already queued action
 */
async function checkAndScoreBooksInternal(gameId: Uint8Array, playerId: 1 | 2): Promise<void> {
  if (!actionContract || !actionContext) return;

  console.log(`[MidnightActions] Checking for books for player ${playerId}...`);
  const rankNames = ['A', '2', '3', '4', '5', '6', '7']; // Simplified deck: 7 ranks
  let booksFound = 0;

  // Check all 7 ranks for possible books (simplified deck)
  for (let rank = 0; rank < 7; rank++) {
    try {
      const result: any = actionContract.impureCircuits.checkAndScoreBook(
        actionContext,
        gameId,
        BigInt(playerId),
        BigInt(rank)
      );
      actionContext = result.context;

      if (result.result) {
        booksFound++;
        console.log(`[MidnightActions] ✓ Player ${playerId} completed a book of ${rankNames[rank]}s!`);
      }
    } catch (error: any) {
      // Log unexpected errors (not just "doesn't have all 4")
      const errorMsg = error?.message || String(error);
      // Only log if it's not a simple "no book" error (contract returns false, not throws)
      if (!errorMsg.includes('assertion') && !errorMsg.includes('Circuit failed')) {
        console.warn(`[MidnightActions] checkAndScoreBook error for rank ${rankNames[rank]}:`, errorMsg);
      }
      continue;
    }

    // Yield occasionally to prevent blocking
    if (rank % 4 === 3) {
      await yieldToEventLoop();
    }
  }

  console.log(`[MidnightActions] Book check complete for player ${playerId}: ${booksFound} books scored`);
}

/**
 * Check and score books for a player (public API)
 * Called after actions that might result in a book
 */
export async function checkAndScoreBooks(
  lobbyId: string,
  playerId: 1 | 2
): Promise<{ success: boolean; booksScored: number; errorMessage?: string }> {
  return enqueueAction(async () => {
    if (!actionContract || !actionContext) {
      return { success: false, booksScored: 0, errorMessage: 'Contract not initialized' };
    }

    const gameId = lobbyIdToGameId(lobbyId);
    console.log(`[MidnightActions] checkAndScoreBooks(gameId: ${lobbyId}, playerId: ${playerId})`);

    let booksScored = 0;
    const rankNames = ['A', '2', '3', '4', '5', '6', '7']; // Simplified deck: 7 ranks

    // Check all 7 ranks for possible books (simplified deck)
    for (let rank = 0; rank < 7; rank++) {
      try {
        const result: any = actionContract.impureCircuits.checkAndScoreBook(
          actionContext,
          gameId,
          BigInt(playerId),
          BigInt(rank)
        );
        actionContext = result.context;

        if (result.result) {
          booksScored++;
          console.log(`[MidnightActions] Player ${playerId} completed a book of ${rankNames[rank]}s!`);
        }
      } catch (_error) {
        // Errors are expected for ranks the player doesn't have all 3 of
        continue;
      }

      // Yield occasionally to prevent blocking
      if (rank % 3 === 2) {
        await yieldToEventLoop();
      }
    }

    // Sync query context so queries see the updated state
    syncQueryContextFromAction(actionContext!);

    // Invalidate hand cache since cards may have been removed for books
    if (booksScored > 0) {
      invalidateHandCache(lobbyId, playerId);
    }

    console.log(`[MidnightActions] checkAndScoreBooks completed: ${booksScored} books scored`);
    return { success: true, booksScored };
  });
}

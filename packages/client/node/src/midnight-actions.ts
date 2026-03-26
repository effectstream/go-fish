/**
 * Midnight Actions - Backend utilities for executing Midnight contract actions
 * This runs on the Paima node and provides write access to the contract
 */

// Debug: Log import.meta.url at module load time
console.log(`[MidnightActions] Module loaded from: ${import.meta.url}`);

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
import { USE_BATCHER_MODE, MIN_OPERATION_GAP_MS } from './batcher-config.ts';
import { INDEX_TO_RANK } from '@go-fish/data-types';

// Private state type
type PrivateState = Record<string, never>;

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
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    item.resolve({ success: false, errorMessage });
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
 * Jubjub embedded curve scalar field order (EmbeddedFr) — the modulus for ecMul scalars.
 * Hex: 0x0e7db4ea6533afa906673b0101343b00a6682093ccc81082d0970e5ed6f72cb7
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
// Shuffle seeds injected from the batcher notification (real seeds used during dealCards on-chain)
const playerShuffleSeeds = new Map<string, Uint8Array>();

/**
 * Last shuffle seed captured by the shuffle_seed witness.
 * Used by get_sorted_deck_witness to produce a deterministic permutation that
 * matches what the batcher's witnesses.ts produces for the same seed.
 * The contract always calls shuffle_seed immediately before get_sorted_deck_witness.
 */
let lastActionShuffleSeed: Uint8Array | null = null;

/**
 * Generate deterministic pseudo-random weights using xorshift32 PRNG seeded
 * from the first 4 bytes of the shuffle seed. Must match the implementation
 * in witnesses.ts so both the batcher and backend produce the same permutation.
 */
function deterministicActionWeights(seed: Uint8Array, count: number): number[] {
  let state =
    ((seed[0]! | 0) |
     ((seed[1]! | 0) << 8) |
     ((seed[2]! | 0) << 16) |
     ((seed[3]! | 0) << 24)) >>> 0;
  if (state === 0) state = 0xdeadbeef;
  const weights: number[] = [];
  for (let i = 0; i < count; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state = state >>> 0;
    weights.push(state % 1000000);
  }
  return weights;
}

/**
 * Long-term secret store — populated during setup replay and never cleared by hand queries.
 * Used by the batcher adapter to look up the opponent's secret when running game-phase
 * circuits (askForCard, respondToAsk, goFish, afterGoFish) that require both players' secrets.
 * Key format: `${hexGameId}-${playerId}` (same as playerSecrets, but persists across hand queries).
 */
const persistentSecrets = new Map<string, bigint>();
const persistentShuffleSeeds = new Map<string, Uint8Array>();

// ---------------------------------------------------------------------------
// Disk persistence for persistentSecrets / persistentShuffleSeeds
// These Maps survive node restarts so that game-phase circuits (askForCard,
// respondToAsk, etc.) can still retrieve the opponent's secret via
// fetchSecretFromBackend even if the node was restarted between setup and play.
// ---------------------------------------------------------------------------
const SECRETS_FILE = './data/player-secrets.json';

function loadPersistedSecrets(): void {
  try {
    const text = Deno.readTextFileSync(SECRETS_FILE);
    const data = JSON.parse(text) as { secrets?: Record<string, string>; seeds?: Record<string, string> };
    for (const [key, value] of Object.entries(data.secrets ?? {})) {
      persistentSecrets.set(key, BigInt('0x' + value));
    }
    for (const [key, value] of Object.entries(data.seeds ?? {})) {
      const seed = new Uint8Array(value.length / 2);
      for (let i = 0; i < seed.length; i++) seed[i] = parseInt(value.substr(i * 2, 2), 16);
      persistentShuffleSeeds.set(key, seed);
    }
    console.log(`[MidnightActions] Loaded ${persistentSecrets.size} persisted secrets, ${persistentShuffleSeeds.size} persisted seeds`);
  } catch {
    // File doesn't exist yet — first run
  }
}

function persistSecrets(): void {
  try {
    Deno.mkdirSync('./data', { recursive: true });
    const secrets: Record<string, string> = {};
    const seeds: Record<string, string> = {};
    for (const [k, v] of persistentSecrets.entries()) {
      secrets[k] = v.toString(16).padStart(64, '0');
    }
    for (const [k, v] of persistentShuffleSeeds.entries()) {
      seeds[k] = Array.from(v).map(b => b.toString(16).padStart(2, '0')).join('');
    }
    Deno.writeTextFileSync(SECRETS_FILE, JSON.stringify({ secrets, seeds }, null, 2));
  } catch (err) {
    console.warn('[MidnightActions] Failed to persist secrets:', err);
  }
}

// Load persisted data on module init
loadPersistedSecrets();

/**
 * Set of game IDs (hex-encoded) that have been correctly replayed with real seeds.
 * A game is added here once ensureGameReplayedIfNeeded completes a full replay using
 * actual shuffle seeds (not the deterministic fallback). This prevents short-circuiting
 * on phase >= 1 when the initial replay used wrong seeds (e.g. from notify_setup).
 */
const gamesReplayedWithSeeds = new Set<string>();

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
      const s = playerSecrets.get(key)!;
      return [context.privateState, s];
    }

    // Generate a random secret (matches example.test.ts lines 24-28)
    // Secret must be in range [1, JUBJUB_SCALAR_FIELD_ORDER)
    const secret = BigInt(Math.floor(Math.random() * 1000000)) + 1n;
    playerSecrets.set(key, secret);
    console.warn(`[MidnightActions] player_secret_key: MISS (fallback) key="${key}" — using random secret. Pass playerSecretHex via API to avoid mismatch.`);
    return [context.privateState, secret];
  },

  shuffle_seed: (context: any, gameId: Uint8Array, player: bigint) => {
    const hexGameId = Array.from(new Uint8Array(gameId)).map(b => b.toString(16).padStart(2, '0')).join('');
    const key = `${hexGameId}-${player}`;

    // Use injected shuffle seed if available (set before replay via injectShuffleSeed)
    if (playerShuffleSeeds.has(key)) {
      const seed = playerShuffleSeeds.get(key)!;
      console.log(`[MidnightActions] shuffle_seed: HIT key="${key}"`);
      // Capture so get_sorted_deck_witness can generate deterministic weights
      lastActionShuffleSeed = seed;
      return [context.privateState, seed];
    }

    // Fallback: deterministic seed (only used when no real seed was provided)
    console.warn(`[MidnightActions] shuffle_seed: MISS key="${key}" — using deterministic fallback`);
    const seed = new Uint8Array(32);
    const gameIdBytes = new Uint8Array(gameId);
    for (let i = 0; i < 32; i++) {
      seed[i] = (gameIdBytes[i % gameIdBytes.length] + Number(player) * (i + 1)) % 256;
    }
    lastActionShuffleSeed = seed;
    return [context.privateState, seed];
  },

  get_sorted_deck_witness: (context: any, input: { x: bigint; y: bigint }[]) => {
    // Use deterministic weights from the last shuffle seed so the backend replay
    // produces the same card permutation as the batcher's on-chain transaction.
    // shuffle_seed is always called immediately before this witness within shuffle_deck.
    const weights = lastActionShuffleSeed
      ? deterministicActionWeights(lastActionShuffleSeed, input.length)
      : input.map(() => Math.floor(Math.random() * 1000000) | 0);

    const mappedPoints = input.map((point, i) => ({
      x: point.x,
      y: point.y,
      weight: weights[i]!,
    }));

    // Bubble sort by weight (sort mappedPoints in-place, keeping x/y/weight together)
    for (let i = 0; i < mappedPoints.length; i++) {
      for (let j = i + 1; j < mappedPoints.length; j++) {
        if (mappedPoints[i]!.weight > mappedPoints[j]!.weight) {
          const temp = mappedPoints[i]!;
          mappedPoints[i] = mappedPoints[j]!;
          mappedPoints[j] = temp;
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
    const initDeckResult = actionContract.provableCircuits.init_deck(actionContext);
    actionContext = initDeckResult.context;
    console.log('[MidnightActions] Static deck initialized');

    console.log('[MidnightActions] Action contract initialized successfully');
  } catch (error) {
    console.error('[MidnightActions] Failed to initialize action contract:', error);
    throw error;
  }
}


/**
 * Generate a deterministic mock hand for batcher mode
 * Since we can't decrypt real cards without player secrets, we generate
 * a consistent hand based on lobby and player ID for demo purposes.
 *
 * Each player gets 7 cards from our 21-card deck (7 ranks × 3 suits).
 * We use a simple deterministic algorithm based on player ID.
 */
function generateMockHand(lobbyId: string, playerId: 1 | 2): Array<{ rank: number; suit: number }> {
  const hand: Array<{ rank: number; suit: number }> = [];

  // Use lobby ID hash as a seed for consistency
  let seed = 0;
  for (let i = 0; i < lobbyId.length; i++) {
    seed = ((seed << 5) - seed + lobbyId.charCodeAt(i)) | 0;
  }
  seed = Math.abs(seed);

  // Generate 7 cards for this player
  // Player 1 gets cards from first half of deck, Player 2 from second half
  // This ensures no overlap
  const usedCards = new Set<number>();
  const startOffset = playerId === 1 ? 0 : 11; // 21 cards total, split roughly in half

  for (let i = 0; i < 7; i++) {
    // Deterministic card selection
    const cardIndex = (startOffset + (seed + i * 3) % 10) % 21;

    // Avoid duplicates by finding next available card
    let actualIndex = cardIndex;
    while (usedCards.has(actualIndex)) {
      actualIndex = (actualIndex + 1) % 21;
    }
    usedCards.add(actualIndex);

    const rank = actualIndex % 7;  // 7 ranks (Ace through 7)
    const suit = Math.floor(actualIndex / 7);  // 3 suits
    hand.push({ rank, suit });
  }

  console.log(`[MidnightActions] Generated mock hand for player ${playerId}: ${hand.length} cards`);
  return hand;
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
 *
 * In batcher mode, returns mock hands since real card decryption requires
 * player private keys which only wallets have.
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

  // In batcher mode, return mock hands since we can't decrypt real cards
  console.log(`[MidnightActions] getPlayerHand - USE_BATCHER_MODE = ${USE_BATCHER_MODE}`);
  if (USE_BATCHER_MODE) {
    console.log(`[MidnightActions] Using mock hand for batcher mode`);
    const mockHand = generateMockHand(lobbyId, playerId);
    playerHandCache.set(cacheKey, { hand: mockHand, timestamp: now });
    return mockHand;
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
          const checkResult: any = actionContract.provableCircuits.doesPlayerHaveSpecificCard(
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
 * Get a stored player secret for a specific game.
 * Returns the hex-encoded secret if it's in the persistent secret store
 * (populated during dealCards setup replay from notify_setup), or null if not available.
 *
 * Used by the batcher adapter to look up the opponent secret before running circuits
 * that require both players' secrets (askForCard, respondToAsk, goFish, afterGoFish).
 * Uses `persistentSecrets` (not `playerSecrets`) so hand queries don't evict it.
 */
export function getStoredPlayerSecret(lobbyId: string, playerId: 1 | 2): string | null {
  const gameId = lobbyIdToGameId(lobbyId);
  const hexGameId = Array.from(gameId).map((b: number) => b.toString(16).padStart(2, '0')).join('');
  const key = `${hexGameId}-${playerId}`;
  const secret = persistentSecrets.get(key);
  if (secret === undefined) return null;
  return secret.toString(16).padStart(64, '0');
}

/**
 * Get a stored shuffle seed for a specific game.
 * Returns the hex-encoded seed if it's in the persistent seed store,
 * or null if not available.
 */
export function getStoredShuffleSeed(lobbyId: string, playerId: 1 | 2): string | null {
  const gameId = lobbyIdToGameId(lobbyId);
  const hexGameId = Array.from(gameId).map((b: number) => b.toString(16).padStart(2, '0')).join('');
  const key = `${hexGameId}-${playerId}`;
  const seed = persistentShuffleSeeds.get(key);
  if (seed === undefined) return null;
  return Array.from(seed).map(b => b.toString(16).padStart(2, '0')).join('');
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
 * Store (or refresh) a player secret without running any circuit.
 * Called by the /api/midnight/register_secret endpoint so the frontend can
 * push its secret to the backend at any time (reconnect, page load, etc.).
 * This ensures fetchSecretFromBackend in the batcher always finds a valid secret
 * even if the node was restarted after setup completed.
 */
export function storePlayerSecret(
  lobbyId: string,
  playerId: 1 | 2,
  playerSecretHex: string,
  shuffleSeedHex?: string,
): void {
  const gameId = lobbyIdToGameId(lobbyId);
  const hexGameId = Array.from(gameId).map((b: number) => b.toString(16).padStart(2, '0')).join('');
  const secretKey = `${hexGameId}-${playerId}`;

  const s = BigInt('0x' + playerSecretHex);
  playerSecrets.set(secretKey, s);
  persistentSecrets.set(secretKey, s);
  console.log(`[MidnightActions] storePlayerSecret: key="${secretKey}" secret=0x${s.toString(16).padStart(16, '0')}...`);

  if (shuffleSeedHex) {
    const seed = new Uint8Array(shuffleSeedHex.length / 2);
    for (let i = 0; i < seed.length; i++) seed[i] = parseInt(shuffleSeedHex.substr(i * 2, 2), 16);
    playerShuffleSeeds.set(secretKey, seed);
    persistentShuffleSeeds.set(secretKey, seed);
  }

  persistSecrets();
}

/**
 * Check whether the local actionContext already has this game initialized.
 * If not, replay the setup sequence using the provided secrets so that
 * getPlayerHandWithSecret can query cards correctly.
 *
 * Called before getPlayerHandWithSecret when all secrets are available.
 * Safe to call even if the game is already in context (no-op in that case).
 */
export async function ensureGameReplayedIfNeeded(
  lobbyId: string,
  playerId: 1 | 2,
  playerSecretHex: string,
  shuffleSeedHex?: string,
  opponentSecretHex?: string,
  opponentShuffleSeedHex?: string,
): Promise<void> {
  return enqueueAction(async () => {
    if (!actionContract || !actionContext) return;

    const gameId = lobbyIdToGameId(lobbyId);

    // Check if the game is fully set up in the local sim.
    // Phase 0 = Setup (applyMask done but dealCards not yet replayed locally).
    // Phase >= 1 = TurnStart or later (dealCards replayed, hand queries will work).
    // If phase is 0 we must still replay dealCards even though the game "exists".
    let currentPhase = -1; // -1 = game not in context at all
    try {
      const phaseResult = actionContract.provableCircuits.getGamePhase(actionContext, gameId);
      actionContext = phaseResult.context;
      currentPhase = Number(phaseResult.result);
      console.log(`[MidnightActions] ensureGameReplayedIfNeeded: game in context with phase=${currentPhase}`);
    } catch {
      console.log(`[MidnightActions] ensureGameReplayedIfNeeded: game not in context, replaying setup for ${lobbyId}`);
    }

    const hexGameId = Array.from(gameId).map((b: number) => b.toString(16).padStart(2, '0')).join('');

    // If the game was already replayed with correct seeds, nothing more to do.
    if (gamesReplayedWithSeeds.has(hexGameId)) {
      console.log(`[MidnightActions] ensureGameReplayedIfNeeded: game already correctly replayed for ${lobbyId}`);
      return;
    }

    // Fill in missing seeds/secrets from the persistent store (populated by notify_setup).
    // The frontend may not have the opponent's seed (different browser session), but the
    // backend stored it during the setup replay triggered by notify_setup.
    const opponentId = (playerId === 1 ? 2 : 1) as 1 | 2;
    const myKey = `${hexGameId}-${playerId}`;
    const opponentKey = `${hexGameId}-${opponentId}`;

    const resolvedShuffleSeedHex = shuffleSeedHex
      ?? (() => {
        const s = persistentShuffleSeeds.get(myKey);
        if (s) {
          console.log(`[MidnightActions] ensureGameReplayedIfNeeded: filled my shuffleSeed from persistent store`);
          return Array.from(s).map(b => b.toString(16).padStart(2, '0')).join('');
        }
        return undefined;
      })();

    const resolvedOpponentSecretHex = opponentSecretHex
      ?? (() => {
        const s = persistentSecrets.get(opponentKey);
        if (s) {
          console.log(`[MidnightActions] ensureGameReplayedIfNeeded: filled opponent secret from persistent store`);
          return s.toString(16).padStart(64, '0');
        }
        return undefined;
      })();

    const resolvedOpponentShuffleSeedHex = opponentShuffleSeedHex
      ?? (() => {
        const s = persistentShuffleSeeds.get(opponentKey);
        if (s) {
          console.log(`[MidnightActions] ensureGameReplayedIfNeeded: filled opponent shuffleSeed from persistent store`);
          return Array.from(s).map(b => b.toString(16).padStart(2, '0')).join('');
        }
        return undefined;
      })();

    // Use resolved values for the rest of this function
    shuffleSeedHex = resolvedShuffleSeedHex;
    opponentSecretHex = resolvedOpponentSecretHex;
    opponentShuffleSeedHex = resolvedOpponentShuffleSeedHex;

    // Determine whether we have both shuffle seeds for a correct replay.
    const hasRealSeeds = !!(shuffleSeedHex && opponentShuffleSeedHex);

    // If game is in context with phase >= 1 but was NOT correctly replayed yet,
    // and we now have the real seeds, we must reset actionContext and redo from scratch
    // so the shuffle uses the real seeds and cardOwnership matches on-chain.
    if (currentPhase >= 1 && hasRealSeeds) {
      console.log(`[MidnightActions] ensureGameReplayedIfNeeded: phase=${currentPhase} but seeds now available — resetting context for fresh replay`);
      // Reset actionContext to the initial post-constructor state (deck mappings only).
      // This discards all in-memory game state, which is fine since the local sim is
      // only used for hand queries and is rebuilt on demand.
      const { currentPrivateState, currentContractState, currentZswapLocalState } =
        actionContract.initialState(createConstructorContext({}, '0'.repeat(64)));
      actionContext = {
        currentPrivateState,
        currentZswapLocalState,
        currentQueryContext: new QueryContext(
          currentContractState.data,
          sampleContractAddress(),
        ),
        costModel: CostModel.initialCostModel(),
      };
      const initDeckResult = actionContract.provableCircuits.init_deck(actionContext);
      actionContext = initDeckResult.context;
      // Clear the "correctly replayed" set since we just reset all game state
      gamesReplayedWithSeeds.clear();
      currentPhase = -1; // force full replay below
      console.log(`[MidnightActions] ensureGameReplayedIfNeeded: context reset to initial state`);
    } else if (currentPhase >= 1) {
      // In context but no seeds available yet — can't do a correct replay.
      // Hand queries will use whatever (possibly wrong) cardOwnership is in the local sim.
      console.log(`[MidnightActions] ensureGameReplayedIfNeeded: phase=${currentPhase}, no seeds available — skipping replay`);
      return;
    }

    // The contract requires setup to be replayed in canonical P1→P2 order (player 1 always first).
    // Use named variables that reflect canonical ordering, not "my/opponent" perspective.
    const canonicalP1 = 1 as const;
    const canonicalP2 = 2 as const;
    const mySecretKey = `${hexGameId}-${playerId}`;
    const opponentSecretKey = `${hexGameId}-${opponentId}`;

    // Inject caller's secret under their actual player ID key
    playerSecrets.set(mySecretKey, BigInt('0x' + playerSecretHex));

    if (opponentSecretHex) {
      playerSecrets.set(opponentSecretKey, BigInt('0x' + opponentSecretHex));
    }
    if (shuffleSeedHex) {
      const seed = new Uint8Array(shuffleSeedHex.length / 2);
      for (let i = 0; i < seed.length; i++) seed[i] = parseInt(shuffleSeedHex.substr(i * 2, 2), 16);
      playerShuffleSeeds.set(mySecretKey, seed);
    }
    if (opponentShuffleSeedHex) {
      const seed = new Uint8Array(opponentShuffleSeedHex.length / 2);
      for (let i = 0; i < seed.length; i++) seed[i] = parseInt(opponentShuffleSeedHex.substr(i * 2, 2), 16);
      playerShuffleSeeds.set(opponentSecretKey, seed);
    }

    // Replay in canonical P1→P2 order: applyMask P1, applyMask P2, dealCards P1, dealCards P2.
    // The contract enforces this ordering — replaying out of order produces wrong card ownership.
    // If currentPhase === 0, applyMask is already done in the local sim — skip those steps
    // to avoid "already applied" errors and go straight to dealCards.
    if (currentPhase < 0) {
      // Game not in context at all — replay applyMask for both players first (P1 before P2)
      try {
        const r1 = actionContract.provableCircuits.applyMask(actionContext, gameId, BigInt(canonicalP1));
        actionContext = r1.context;
        console.log(`[MidnightActions] ensureGameReplayedIfNeeded: applyMask P${canonicalP1} replayed`);
      } catch (e: unknown) {
        console.warn(`[MidnightActions] ensureGameReplayedIfNeeded: applyMask P${canonicalP1} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      try {
        const r2 = actionContract.provableCircuits.applyMask(actionContext, gameId, BigInt(canonicalP2));
        actionContext = r2.context;
        console.log(`[MidnightActions] ensureGameReplayedIfNeeded: applyMask P${canonicalP2} replayed`);
      } catch (e: unknown) {
        console.warn(`[MidnightActions] ensureGameReplayedIfNeeded: applyMask P${canonicalP2} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      console.log(`[MidnightActions] ensureGameReplayedIfNeeded: phase=${currentPhase}, skipping applyMask replay`);
    }
    // dealCards P1 before P2 (canonical order)
    try {
      const r3 = actionContract.provableCircuits.dealCards(actionContext, gameId, BigInt(canonicalP1));
      actionContext = r3.context;
      console.log(`[MidnightActions] ensureGameReplayedIfNeeded: dealCards P${canonicalP1} replayed`);
    } catch (e: unknown) {
      console.warn(`[MidnightActions] ensureGameReplayedIfNeeded: dealCards P${canonicalP1} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    try {
      const r4 = actionContract.provableCircuits.dealCards(actionContext, gameId, BigInt(canonicalP2));
      actionContext = r4.context;
      console.log(`[MidnightActions] ensureGameReplayedIfNeeded: dealCards P${canonicalP2} replayed`);
    } catch (e: unknown) {
      console.warn(`[MidnightActions] ensureGameReplayedIfNeeded: dealCards P${canonicalP2} failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Mark this game as correctly replayed if we had real seeds
    if (hasRealSeeds) {
      gamesReplayedWithSeeds.add(hexGameId);
      console.log(`[MidnightActions] ensureGameReplayedIfNeeded: marked ${lobbyId} as correctly replayed with seeds`);
    }

    syncQueryContextFromAction(actionContext!);
    console.log(`[MidnightActions] ensureGameReplayedIfNeeded: setup replay complete for ${lobbyId}`);
  });
}

/**
 * Get player's real hand using their actual secret key.
 * Used in batcher mode where the backend doesn't store player secrets —
 * the frontend passes its secret so the backend can run doesPlayerHaveSpecificCard
 * with the correct witness, then both secrets are immediately removed.
 *
 * IMPORTANT: doesPlayerHaveSpecificCard (via deck_getSecretFromPlayerId) calls
 * player_secret_key for BOTH players unconditionally. The opponent secret must
 * therefore also be injected before any circuit call, otherwise the witness falls
 * back to generating a random key which produces wrong results.
 */
export async function getPlayerHandWithSecret(
  lobbyId: string,
  playerId: 1 | 2,
  playerSecretHex: string,
  opponentSecretHex?: string,
): Promise<Array<{ rank: number; suit: number }>> {
  const gameId = lobbyIdToGameId(lobbyId);
  const hexGameId = Array.from(gameId).map((b: number) => b.toString(16).padStart(2, '0')).join('');
  const secretKey = `${hexGameId}-${playerId}`;
  const opponentId = (playerId === 1 ? 2 : 1) as 1 | 2;
  const opponentSecretKey = `${hexGameId}-${opponentId}`;
  const secret = BigInt('0x' + playerSecretHex);

  // Inject calling player's secret
  playerSecrets.set(secretKey, secret);

  // Inject opponent secret if provided — the circuit always fetches both
  let injectedOpponentSecret = false;
  if (opponentSecretHex) {
    playerSecrets.set(opponentSecretKey, BigInt('0x' + opponentSecretHex));
    injectedOpponentSecret = true;
    console.log(`[MidnightActions] getPlayerHandWithSecret: injected opponent secret for key="${opponentSecretKey}"`);
  } else {
    console.warn(`[MidnightActions] getPlayerHandWithSecret: no opponent secret provided for player ${playerId} — hand check may return 0 cards`);
  }

  console.log(`[MidnightActions] getPlayerHandWithSecret: injected secret for key="${secretKey}", secret=0x${secret.toString(16).padStart(16, '0')}...`);

  try {
    return await enqueueAction(async () => {
      if (!actionContract || !actionContext) {
        console.warn('[MidnightActions] Contract not initialized for getPlayerHandWithSecret');
        return [];
      }

      console.log(`[MidnightActions] getPlayerHandWithSecret: starting 21-card check for player ${playerId}`);
      const hand: Array<{ rank: number; suit: number }> = [];
      let cardCount = 0;
      let errorCount = 0;

      for (let rank = 0; rank < 7; rank++) {
        for (let suit = 0; suit < 3; suit++) {
          if (cardCount > 0 && cardCount % 4 === 0) {
            await yieldToEventLoop();
          }
          cardCount++;
          const cardIndex = rank + suit * 7;
          try {
            const checkResult: any = actionContract.provableCircuits.doesPlayerHaveSpecificCard(
              actionContext,
              gameId,
              BigInt(playerId),
              BigInt(cardIndex),
            );
            actionContext = checkResult.context;
            if (checkResult.result) {
              hand.push({ rank, suit });
              console.log(`[MidnightActions] getPlayerHandWithSecret: card found rank=${rank} suit=${suit} (cardIndex=${cardIndex})`);
            }
          } catch (error: unknown) {
            errorCount++;
            if (errorCount <= 3) {
              console.warn(`[MidnightActions] getPlayerHandWithSecret: error at cardIndex=${cardIndex}: ${error instanceof Error ? error.message : String(error)}`);
            }
            continue;
          }
        }
      }

      console.log(`[MidnightActions] getPlayerHandWithSecret: found ${hand.length} cards, ${errorCount} errors for player ${playerId}`);
      return hand;
    });
  } finally {
    // Always remove injected secrets — never leave them in memory longer than needed
    playerSecrets.delete(secretKey);
    if (injectedOpponentSecret) {
      playerSecrets.delete(opponentSecretKey);
    }
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

    const result = actionContract.provableCircuits.askForCard(
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

    const result = actionContract.provableCircuits.goFish(
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
 * playerSecretHex: hex-encoded player secret from frontend (no 0x prefix).
 * shuffleSeedHex: hex-encoded shuffle seed from frontend (no 0x prefix, 64 hex chars = 32 bytes).
 * Pre-injecting both ensures the local simulation's shuffle matches what was done on-chain.
 */
export async function applyMask(
  lobbyId: string,
  playerId: 1 | 2,
  playerSecretHex?: string,
  shuffleSeedHex?: string,
): Promise<{ success: boolean; errorMessage?: string }> {
  const gameId = lobbyIdToGameId(lobbyId);
  const hexGameId = Array.from(gameId).map((b: number) => b.toString(16).padStart(2, '0')).join('');
  const secretKey = `${hexGameId}-${playerId}`;

  if (playerSecretHex) {
    const s = BigInt('0x' + playerSecretHex);
    playerSecrets.set(secretKey, s);
    persistentSecrets.set(secretKey, s);
    console.log(`[MidnightActions] applyMask: injected frontend secret key="${secretKey}", secret=0x${s.toString(16).padStart(16, '0')}...`);
  } else {
    console.warn(`[MidnightActions] applyMask: NO secret provided for player ${playerId} — will use fallback random secret`);
  }

  if (shuffleSeedHex) {
    const seed = new Uint8Array(shuffleSeedHex.length / 2);
    for (let i = 0; i < seed.length; i++) seed[i] = parseInt(shuffleSeedHex.substr(i * 2, 2), 16);
    playerShuffleSeeds.set(secretKey, seed);
    persistentShuffleSeeds.set(secretKey, seed);
    console.log(`[MidnightActions] applyMask: injected shuffle seed for key="${secretKey}"`);
  } else {
    console.warn(`[MidnightActions] applyMask: NO shuffle seed provided for player ${playerId} — will use deterministic fallback`);
  }

  // Persist to disk so secrets survive node restarts
  if (playerSecretHex || shuffleSeedHex) persistSecrets();

  return enqueueAction(async () => {
    if (!actionContract || !actionContext) {
      return { success: false, errorMessage: 'Contract not initialized' };
    }

    console.log(`[MidnightActions] applyMask(gameId: ${lobbyId}, playerId: ${playerId})`);

    const result = actionContract.provableCircuits.applyMask(
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
 * playerSecretHex: hex-encoded player secret from frontend (no 0x prefix).
 * shuffleSeedHex: hex-encoded shuffle seed from frontend (no 0x prefix, 64 hex chars = 32 bytes).
 * Pre-injecting both ensures the local simulation matches what was done on-chain.
 */
export async function dealCards(
  lobbyId: string,
  playerId: 1 | 2,
  playerSecretHex?: string,
  shuffleSeedHex?: string,
): Promise<{ success: boolean; errorMessage?: string }> {
  const gameId = lobbyIdToGameId(lobbyId);
  const hexGameId = Array.from(gameId).map((b: number) => b.toString(16).padStart(2, '0')).join('');
  const secretKey = `${hexGameId}-${playerId}`;

  if (playerSecretHex) {
    const s = BigInt('0x' + playerSecretHex);
    playerSecrets.set(secretKey, s);
    // Also persist in the long-term store so the batcher can retrieve it later for
    // game-phase circuits that need the opponent's secret (askForCard, respondToAsk, etc.)
    persistentSecrets.set(secretKey, s);
    console.log(`[MidnightActions] dealCards: injected frontend secret key="${secretKey}", secret=0x${s.toString(16).padStart(16, '0')}...`);
  } else {
    console.warn(`[MidnightActions] dealCards: NO secret provided for player ${playerId} — will use fallback random secret`);
  }

  if (shuffleSeedHex) {
    const seed = new Uint8Array(shuffleSeedHex.length / 2);
    for (let i = 0; i < seed.length; i++) {
      seed[i] = parseInt(shuffleSeedHex.substr(i * 2, 2), 16);
    }
    playerShuffleSeeds.set(secretKey, seed);
    persistentShuffleSeeds.set(secretKey, seed);
    console.log(`[MidnightActions] dealCards: injected shuffle seed for key="${secretKey}"`);
  } else {
    console.warn(`[MidnightActions] dealCards: NO shuffle seed provided for player ${playerId} — will use deterministic fallback`);
  }

  // Persist to disk so secrets survive node restarts
  if (playerSecretHex || shuffleSeedHex) persistSecrets();

  return enqueueAction(async () => {
    if (!actionContract || !actionContext) {
      return { success: false, errorMessage: 'Contract not initialized' };
    }

    console.log(`[MidnightActions] dealCards(gameId: ${lobbyId}, playerId: ${playerId})`);

    const result = actionContract.provableCircuits.dealCards(
      actionContext,
      gameId,
      BigInt(playerId)
    );
    actionContext = result.context;

    // Query the phase from the action context immediately after dealCards
    // to verify the state was actually updated
    try {
      const phaseCheck = actionContract.provableCircuits.getGamePhase(actionContext, gameId);
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
      const phaseCheck = actionContract.provableCircuits.getGamePhase(actionContext, gameId);
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
      result = actionContract.provableCircuits.respondToAsk(
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

    const result = actionContract.provableCircuits.afterGoFish(
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
      const result = actionContract.provableCircuits.skipDrawDeckEmpty(
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
    } catch (error: unknown) {
      console.error('[MidnightActions] skipDrawDeckEmpty failed:', error);
      return { success: false, errorMessage: error instanceof Error ? error.message : String(error) };
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
  let booksFound = 0;

  // Check all 7 ranks for possible books (simplified deck)
  for (let rank = 0; rank < 7; rank++) {
    try {
      const result: any = actionContract.provableCircuits.checkAndScoreBook(
        actionContext,
        gameId,
        BigInt(playerId),
        BigInt(rank)
      );
      actionContext = result.context;

      if (result.result) {
        booksFound++;
        console.log(`[MidnightActions] ✓ Player ${playerId} completed a book of ${INDEX_TO_RANK[rank]}s!`);
      }
    } catch (error: unknown) {
      // Log unexpected errors (not just "doesn't have all 4")
      const errorMsg = error instanceof Error ? error.message : String(error);
      // Only log if it's not a simple "no book" error (contract returns false, not throws)
      if (!errorMsg.includes('assertion') && !errorMsg.includes('Circuit failed')) {
        console.warn(`[MidnightActions] checkAndScoreBook error for rank ${INDEX_TO_RANK[rank]}:`, errorMsg);
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

    // Check all 7 ranks for possible books (simplified deck)
    for (let rank = 0; rank < 7; rank++) {
      try {
        const result: any = actionContract.provableCircuits.checkAndScoreBook(
          actionContext,
          gameId,
          BigInt(playerId),
          BigInt(rank)
        );
        actionContext = result.context;

        if (result.result) {
          booksScored++;
          console.log(`[MidnightActions] Player ${playerId} completed a book of ${INDEX_TO_RANK[rank]}s!`);
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

/**
 * Midnight Actions - Backend utilities for executing Midnight contract actions
 * This runs on the Paima node and provides write access to the contract
 */

import { Contract, type Witnesses } from '../../../shared/contracts/midnight/go-fish-contract/managed/contract/index.js';
import type { CircuitContext } from '@midnight-ntwrk/compact-runtime';
import {
  createConstructorContext,
  CostModel,
  QueryContext,
  sampleContractAddress,
} from '@midnight-ntwrk/compact-runtime';
import { syncQueryContextFromAction } from './midnight-query.ts';

// Private state type
type PrivateState = Record<string, never>;

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

// Singleton contract instance
let actionContract: Contract<PrivateState, Witnesses<PrivateState>> | null = null;
let actionContext: CircuitContext<PrivateState> | null = null;

/**
 * Helper: Split a field element into high and low 64-bit parts
 */
function splitFieldBits(fieldValue: bigint): [bigint, bigint] {
  const TWO_POW_64 = BigInt(1) << BigInt(64);
  const low = fieldValue % TWO_POW_64;
  const high = fieldValue / TWO_POW_64;
  return [high, low];
}

/**
 * Witness functions for backend (generates secrets)
 */
const actionWitnesses: Witnesses<PrivateState> = {
  getFieldInverse: (context, x) => {
    // Modular inverse calculation using Jubjub scalar field order
    if (x === 0n) {
      throw new Error('Cannot invert zero');
    }
    return [context.privateState, modInverse(x, JUBJUB_SCALAR_FIELD_ORDER)];
  },

  player_secret_key: (context, gameId, player) => {
    // ⚠️ INSECURE: Backend should NOT have access to player secrets!
    // Following example.test.ts pattern but this is for TESTING ONLY
    const key = `${Buffer.from(gameId).toString('hex')}-${player}`;

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

  split_field_bits: (context, f) => {
    return [context.privateState, splitFieldBits(f)];
  },

  shuffle_seed: (context, gameId, player) => {
    // Generate deterministic shuffle seed as Uint8Array(32)
    const seed = new Uint8Array(32);

    // Use gameId and player to generate deterministic seed
    const gameIdBytes = new Uint8Array(gameId);
    for (let i = 0; i < 32; i++) {
      seed[i] = (gameIdBytes[i % gameIdBytes.length] + Number(player) * (i + 1)) % 256;
    }

    return [context.privateState, seed];
  },

  get_sorted_deck_witness: (context, input) => {
    // Sort the input array by weight (ascending order)
    // input is Vector<52, WeightedCard> where WeightedCard = { point: CurvePoint, weight: bigint }
    const sorted = [...input].sort((a: any, b: any) => {
      const weightA = a.weight;
      const weightB = b.weight;
      if (weightA < weightB) return -1;
      if (weightA > weightB) return 1;
      return 0;
    });
    return [context.privateState, sorted];
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
    actionContract = new Contract<PrivateState, Witnesses<PrivateState>>(actionWitnesses);

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

    console.log('[MidnightActions] Action contract initialized successfully');
  } catch (error) {
    console.error('[MidnightActions] Failed to initialize action contract:', error);
    throw error;
  }
}

/**
 * Get player's decrypted hand
 */
export async function getPlayerHand(
  lobbyId: string,
  playerId: 1 | 2
): Promise<Array<{ rank: number; suit: number }>> {
  try {
    if (!actionContract || !actionContext) {
      console.warn('[MidnightActions] Contract not initialized');
      return [];
    }

    const gameId = lobbyIdToGameId(lobbyId);
    console.log(`[MidnightActions] getPlayerHand(gameId: ${lobbyId}, playerId: ${playerId})`);

    const hand: Array<{ rank: number; suit: number }> = [];

    // Iterate through all 52 cards (13 ranks × 4 suits)
    for (let rank = 0; rank < 13; rank++) {
      for (let suit = 0; suit < 4; suit++) {
        const cardIndex = rank + suit * 13;

        try {
          const checkResult = actionContract.impureCircuits.doesPlayerHaveSpecificCard(
            actionContext,
            gameId,
            BigInt(playerId),
            BigInt(cardIndex)
          );
          actionContext = checkResult.context;

          if (checkResult.result) {
            hand.push({ rank, suit });
          }
        } catch (error) {
          // Card not in hand, continue
          continue;
        }
      }
    }

    console.log(`[MidnightActions] Found ${hand.length} cards in player ${playerId}'s hand`);
    return hand;
  } catch (error) {
    console.error('[MidnightActions] getPlayerHand failed:', error);
    return [];
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
  try {
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
    syncQueryContextFromAction(actionContext);

    console.log('[MidnightActions] askForCard succeeded');
    return { success: true };
  } catch (error: any) {
    console.error('[MidnightActions] askForCard failed:', error);
    return { success: false, errorMessage: error.message };
  }
}

/**
 * Execute goFish action
 */
export async function goFish(
  lobbyId: string,
  playerId: 1 | 2
): Promise<{ success: boolean; errorMessage?: string }> {
  try {
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
    syncQueryContextFromAction(actionContext);

    console.log('[MidnightActions] goFish succeeded');
    return { success: true };
  } catch (error: any) {
    console.error('[MidnightActions] goFish failed:', error);
    return { success: false, errorMessage: error.message };
  }
}

/**
 * Execute applyMask action (setup phase)
 */
export async function applyMask(
  lobbyId: string,
  playerId: 1 | 2
): Promise<{ success: boolean; errorMessage?: string }> {
  try {
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
    syncQueryContextFromAction(actionContext);

    console.log('[MidnightActions] applyMask succeeded');
    return { success: true };
  } catch (error: any) {
    console.error('[MidnightActions] applyMask failed:', error);
    return { success: false, errorMessage: error.message };
  }
}

/**
 * Execute dealCards action (setup phase)
 */
export async function dealCards(
  lobbyId: string,
  playerId: 1 | 2
): Promise<{ success: boolean; errorMessage?: string }> {
  try {
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
    syncQueryContextFromAction(actionContext);

    console.log('[MidnightActions] dealCards succeeded');
    return { success: true };
  } catch (error: any) {
    console.error('[MidnightActions] dealCards failed:', error);
    return { success: false, errorMessage: error.message };
  }
}

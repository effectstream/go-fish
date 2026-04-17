/**
 * Test-owned witness implementation for the Go Fish contract.
 *
 * Replaces the default `@go-fish/midnight-contract` witnesses module for
 * the e2e test path, fixing BACKEND_ISSUES #1 at its root.
 *
 * The default module ships with a silent fallback: if `player_secret_key`
 * or `shuffle_seed` is consulted for an unset gameIdHex/playerId pair, it
 * returns a `Math.random()`-derived static key. Downstream `getSecretFromPlayerId`
 * passes its ec_mul round-trip check (the verification doesn't constrain
 * the secret's *identity*, only that secret × inverse = 1), so the wrong
 * secret silently propagates and produces wrong masked card values. That
 * causes `doesPlayerHaveSpecificCard` and `countCardsOfRank_withSecrets`
 * to return mismatched results from a different witness call.
 *
 * This module:
 *   - Holds explicit per-game secrets in a `WitnessState` instance scoped
 *     per test session (no module-level global mutable state).
 *   - Throws immediately with a descriptive error if the contract asks for
 *     a secret/seed the test hasn't set. Failures are loud and traceable.
 *   - Reimplements every utility witness (modular inverse, deterministic
 *     shuffle, field-bit split, print helpers) from scratch so the test
 *     has zero dependency on the default witness module's state.
 *
 * The same `WitnessState` instance is wired into BOTH:
 *   - The deployed contract used for callTx submissions (via
 *     `CompiledContract.withWitnesses(makeTestWitnesses(state))`)
 *   - The local Contract instance used for read-only impureCircuit calls
 *     (via `new GoFishContract(makeTestWitnesses(state))`)
 * so they share the same witness state and cannot diverge.
 */

import type { WitnessContext } from "@midnight-ntwrk/compact-runtime";

/** Jubjub prime-order subgroup order — secrets must be in [1, r). */
const JUBJUB_R =
  0x0e7db4ea6533afa906673b0101343b00a6682093ccc81082d0970e5ed6f72cb7n;

export interface SecretEntry {
  secret: bigint;
  seed: Uint8Array;
}

/**
 * Per-session secret store. Holds the test's player secrets and shuffle
 * seeds. Reset on every test run; no global state.
 */
export class WitnessState {
  private map = new Map<string, SecretEntry>();
  private lastShuffleSeed: Uint8Array | null = null;

  /** Set both secret and shuffle seed for one player in one game. */
  set(gameIdHex: string, playerId: 1 | 2, secret: bigint, seed: Uint8Array): void {
    this.map.set(`${gameIdHex}-${playerId}`, { secret, seed });
  }

  /** Drop one player's entry. */
  clear(gameIdHex: string, playerId: 1 | 2): void {
    this.map.delete(`${gameIdHex}-${playerId}`);
  }

  /** Drop both players' entries for a game. */
  clearAll(gameIdHex: string): void {
    this.clear(gameIdHex, 1);
    this.clear(gameIdHex, 2);
  }

  /** Wipe everything. Useful between independent test cases. */
  reset(): void {
    this.map.clear();
    this.lastShuffleSeed = null;
  }

  getSecret(gameIdHex: string, playerId: number): bigint {
    const entry = this.map.get(`${gameIdHex}-${playerId}`);
    if (!entry) {
      throw new Error(
        `testWitness: missing secret for game=${gameIdHex.slice(0, 18)}… player=${playerId}`,
      );
    }
    return entry.secret;
  }

  getSeed(gameIdHex: string, playerId: number): Uint8Array {
    const entry = this.map.get(`${gameIdHex}-${playerId}`);
    if (!entry) {
      throw new Error(
        `testWitness: missing seed for game=${gameIdHex.slice(0, 18)}… player=${playerId}`,
      );
    }
    return entry.seed;
  }

  /** shuffle_seed records the seed it returned so get_sorted_deck_witness
   *  can derive deterministic weights from it inside the same circuit call. */
  setLastShuffleSeed(seed: Uint8Array): void {
    this.lastShuffleSeed = seed;
  }
  takeLastShuffleSeed(): Uint8Array | null {
    return this.lastShuffleSeed;
  }
}

// ---------------------------------------------------------------------------
// Pure utility implementations (no shared state)
// ---------------------------------------------------------------------------

function gameIdToHex(gameId: Uint8Array): string {
  return "0x" + Array.from(gameId).map(b => b.toString(16).padStart(2, "0")).join("");
}

/** Extended Euclidean modular inverse over n. Throws if not invertible. */
function modInverse(a: bigint, n: bigint): bigint {
  let t = 0n;
  let newT = 1n;
  let r = n;
  let newR = a;
  while (newR !== 0n) {
    const q = r / newR;
    [t, newT] = [newT, t - q * newT];
    [r, newR] = [newR, r - q * newR];
  }
  if (r > 1n) throw new Error("testWitness: scalar not invertible");
  if (t < 0n) t += n;
  return t;
}

/**
 * xorshift32 seeded from the first 4 bytes of `seed`. Bit-for-bit
 * compatible with the default witness module's `deterministicWeights`,
 * so a deck shuffled by one is reproducible by the other given the
 * same seed.
 */
function deterministicWeights(seed: Uint8Array, count: number): number[] {
  let state =
    ((seed[0]! | 0) |
      ((seed[1]! | 0) << 8) |
      ((seed[2]! | 0) << 16) |
      ((seed[3]! | 0) << 24)) >>> 0;
  if (state === 0) state = 0xdeadbeef;
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state = state >>> 0;
    out.push(state % 1_000_000);
  }
  return out;
}

function splitFieldBits(fieldValue: bigint): [bigint, bigint] {
  const TWO_64 = 1n << 64n;
  return [fieldValue / TWO_64, fieldValue % TWO_64];
}

function noopPrint(ctx: WitnessContext<any, any>, _b: unknown): [any, boolean] {
  return [ctx.privateState, true];
}

// ---------------------------------------------------------------------------
// Witness factory
// ---------------------------------------------------------------------------

/**
 * Build a witnesses object backed by `state`. Pass to BOTH the deployed
 * contract (CompiledContract.withWitnesses) and any local Contract instance
 * used for read-only circuit evaluation, so they share state.
 *
 * Function names and shapes match the default `@go-fish/midnight-contract`
 * witnesses module exactly — drop-in replacement.
 */
export function makeTestWitnesses(state: WitnessState) {
  return {
    print_field: noopPrint,
    print_bytes_32: noopPrint,
    print_vector_2_field: noopPrint,
    print_curve_point: noopPrint,
    print_uint_64: noopPrint,

    split_field_bits: (
      ctx: WitnessContext<any, any>,
      v: bigint,
    ): [any, [bigint, bigint]] => [ctx.privateState, splitFieldBits(v)],

    getFieldInverse: (
      ctx: WitnessContext<any, any>,
      x: bigint,
    ): [any, bigint] => {
      if (x === 0n) throw new Error("testWitness: cannot invert zero");
      if (x >= JUBJUB_R) {
        throw new Error(`testWitness: scalar ${x.toString(16)} >= Jubjub r`);
      }
      return [ctx.privateState, modInverse(x, JUBJUB_R)];
    },

    /**
     * Declared but never called from any .compact file (grep -rn
     * "shuffle_seed(" shows only the declaration at Deck.compact:37). Kept
     * here for completeness of the witness shape — if any future contract
     * change starts calling it, behavior is identical to player_secret_key:
     * it captures the seed for the next get_sorted_deck_witness call.
     */
    shuffle_seed: (
      ctx: WitnessContext<any, any>,
      gameId: Uint8Array,
      playerIndex: bigint,
    ): [any, Uint8Array] => {
      const seed = state.getSeed(gameIdToHex(gameId), Number(playerIndex));
      state.setLastShuffleSeed(seed);
      return [ctx.privateState, seed];
    },

    player_secret_key: (
      ctx: WitnessContext<any, any>,
      gameId: Uint8Array,
      playerIndex: bigint,
    ): [any, bigint] => {
      const gameIdHex = gameIdToHex(gameId);
      const playerIdNum = Number(playerIndex);
      const secret = state.getSecret(gameIdHex, playerIdNum);
      if (secret === 0n) {
        throw new Error("testWitness: zero secret");
      }
      if (secret >= JUBJUB_R) {
        throw new Error(`testWitness: secret >= Jubjub r`);
      }
      // Capture this player's shuffle seed for the *next* call to
      // `get_sorted_deck_witness`. This makes the deck shuffle
      // deterministic PER (game, player): the same player in the same
      // game always gets the same shuffled deck, because the seed is
      // fixed when the user constructed this WitnessState entry.
      //
      // `shuffle_deck` (Deck.compact:230, the only caller of
      // get_sorted_deck_witness in any .compact file) calls
      // player_secret_key *immediately before* get_sorted_deck_witness in
      // the same circuit, so the seed captured here is always the right
      // one for the upcoming shuffle.
      state.setLastShuffleSeed(state.getSeed(gameIdHex, playerIdNum));
      return [ctx.privateState, secret];
    },

    get_sorted_deck_witness: (
      ctx: WitnessContext<any, any>,
      input: { x: bigint; y: bigint }[],
    ): [any, { x: bigint; y: bigint }[]] => {
      // The contract verifies (via grand product on jubjubX) that the
      // returned vector is a permutation of `input`. The witness chooses
      // the ordering — that IS the deck shuffle.
      //
      // Determinism guarantee: `player_secret_key` runs first inside
      // `shuffle_deck` and writes the player's stored shuffle seed to
      // `lastShuffleSeed`. We consume it here. Same (gameId, playerId)
      // → same seed → same xorshift weights → same permutation.
      // Multiple `shuffle_deck` calls for the same (game, player) — e.g.
      // applyMask retried in a re-prove — produce identical results.
      const lastSeed = state.takeLastShuffleSeed();
      if (!lastSeed) {
        throw new Error(
          "testWitness: get_sorted_deck_witness called without a captured " +
            "shuffle seed — player_secret_key must run first inside shuffle_deck",
        );
      }
      const weights = deterministicWeights(lastSeed, input.length);
      const indexed = input.map((p, i) => ({ x: p.x, y: p.y, w: weights[i]! }));
      indexed.sort((a, b) => a.w - b.w);
      return [ctx.privateState, indexed.map(p => ({ x: p.x, y: p.y }))];
    },

    // Contract V3: split a card index (0..20) into [suit, rank] with
    // suit = cardIndex / 7, rank = cardIndex % 7. The circuit re-verifies
    // rank < 7 && suit*7 + rank == cardIndex, so a wrong answer here would
    // fail the reconstruction assert rather than silently corrupt state.
    // Called from `afterGoFish` (via split_card_index) to learn the drawn
    // card's rank and auto-score a book on completion.
    //
    // Return type: `Uint<8>` values cross the witness boundary as `bigint`
    // in compact-runtime 0.15.0 — returning plain `number` triggers a
    // "expected value of type [Uint<0..256>, Uint<0..256>]" type error.
    wit_split_card_index: (
      ctx: WitnessContext<any, any>,
      cardIndex: bigint,
    ): [any, [bigint, bigint]] => {
      if (cardIndex < 0n || cardIndex > 20n) {
        throw new Error(
          `testWitness: wit_split_card_index: cardIndex ${cardIndex} out of range [0, 20]`,
        );
      }
      const n = Number(cardIndex);
      return [ctx.privateState, [BigInt(Math.floor(n / 7)), BigInt(n % 7)]];
    },
  };
}

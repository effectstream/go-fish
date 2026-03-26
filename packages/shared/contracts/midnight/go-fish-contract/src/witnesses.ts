import { type WitnessContext } from "@midnight-ntwrk/compact-runtime";
export type Ledger = {};
export type PrivateState = {};

/**
 * Default keys for testing/development
 * In production, these should be provided by the client via setPlayerSecrets()
 */
export const keys = {
  player1: BigInt(Math.floor(Math.random() * 1000000)),
  player2: BigInt(Math.floor(Math.random() * 1000000)),
  shuffleSeed1: new Uint8Array(32).fill(Math.floor(Math.random() * 256)),
  shuffleSeed2: new Uint8Array(32).fill(Math.floor(Math.random() * 256)),
};

/**
 * Dynamic per-game secrets storage
 * Key format: `${gameId}-${playerId}` where gameId is hex-encoded
 *
 * This allows the batcher to use client-provided secrets instead of
 * the default hardcoded ones. Secrets are set before circuit execution
 * and cleared after.
 *
 * Reference-counted: clearPlayerSecrets only removes the entry when the
 * refcount reaches zero, preventing concurrent queryPlayerHand calls from
 * wiping secrets that submitBatch has already set for a circuit execution.
 */
const dynamicSecrets = new Map<string, { secret: bigint; shuffleSeed: Uint8Array }>();
const secretRefCount = new Map<string, number>();

/**
 * Last shuffle seed provided to the shuffle_seed witness.
 * Written by the shuffle_seed witness so get_sorted_deck_witness can generate
 * deterministic weights from it, making the shuffle reproducible across replays.
 * The contract always calls shuffle_seed before get_sorted_deck_witness within
 * the same shuffle_deck circuit execution.
 */
let lastShuffleSeed: Uint8Array | null = null;

/**
 * Generate deterministic pseudo-random weights from a seed using a simple
 * xorshift32 PRNG seeded from the first 4 bytes of the shuffle seed.
 * Returns `count` non-negative integers in [0, 1000000).
 */
function deterministicWeights(seed: Uint8Array, count: number): number[] {
  // Seed xorshift32 from the first 4 bytes of the shuffle seed
  let state =
    ((seed[0]! | 0) |
     ((seed[1]! | 0) << 8) |
     ((seed[2]! | 0) << 16) |
     ((seed[3]! | 0) << 24)) >>> 0;
  // Ensure non-zero state (xorshift32 breaks at 0)
  if (state === 0) state = 0xdeadbeef;

  const weights: number[] = [];
  for (let i = 0; i < count; i++) {
    // xorshift32
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state = state >>> 0; // keep as uint32
    weights.push(state % 1000000);
  }
  return weights;
}

/**
 * Set player secrets for a specific game.
 * Increments a reference count so concurrent callers (submitBatch + queryPlayerHand)
 * can each hold the secrets without one clearing what the other set.
 * Called by the batcher before executing a circuit call.
 */
export function setPlayerSecrets(
  gameIdHex: string,
  playerId: 1 | 2,
  secret: bigint,
  shuffleSeed: Uint8Array
): void {
  const key = `${gameIdHex}-${playerId}`;
  const prevCount = secretRefCount.get(key) ?? 0;
  dynamicSecrets.set(key, { secret, shuffleSeed });
  secretRefCount.set(key, prevCount + 1);
  console.log(`[Witnesses] setPlayerSecrets: player=${playerId} refCount=${prevCount}->${prevCount + 1} secret=${secret}`);
}

/**
 * Release player secrets after circuit execution.
 * Decrements the reference count; only removes the entry when it reaches zero,
 * so a concurrent setPlayerSecrets from submitBatch is not wiped by queryPlayerHand's cleanup.
 */
export function clearPlayerSecrets(gameIdHex: string, playerId: 1 | 2): void {
  const key = `${gameIdHex}-${playerId}`;
  const count = secretRefCount.get(key) ?? 0;
  if (count <= 1) {
    console.log(`[Witnesses] clearPlayerSecrets: player=${playerId} refCount=${count}->0 (deleting)`);
    dynamicSecrets.delete(key);
    secretRefCount.delete(key);
  } else {
    console.log(`[Witnesses] clearPlayerSecrets: player=${playerId} refCount=${count}->${count - 1} (keeping)`);
    secretRefCount.set(key, count - 1);
  }
}

/**
 * Get secret key - checks dynamic secrets first, falls back to static keys
 */
const getSecretKey = (gameIdHex: string | null, index: number) => {
  // Check dynamic secrets first
  if (gameIdHex) {
    const key = `${gameIdHex}-${index}`;
    const dynamic = dynamicSecrets.get(key);
    if (dynamic) {
      const refCount = secretRefCount.get(key) ?? 0;
      console.log(`[Witnesses] player_secret_key: HIT player=${index} refCount=${refCount} secret=${dynamic.secret}`);
      return dynamic.secret;
    }
    // Log all currently-set keys to help diagnose key mismatch
    const allKeys = [...dynamicSecrets.keys()].join(", ") || "(empty)";
    console.warn(`[Witnesses] player_secret_key: MISS for key="${key}" — current keys: ${allKeys}`);
  }

  // Fall back to static keys — this means the batcher did NOT receive a dynamic secret
  // for this player. This is a bug if it happens during applyMask or dealCards.
  switch (index) {
    case 1:
      console.warn(`[Witnesses] FALLBACK to static key for player 1 (game ${gameIdHex}) — secret=${keys.player1}`);
      return keys.player1;
    case 2:
      console.warn(`[Witnesses] FALLBACK to static key for player 2 (game ${gameIdHex}) — secret=${keys.player2}`);
      return keys.player2;
  }
  throw new Error("Invalid player index");
};

/**
 * Get shuffle seed - checks dynamic secrets first, falls back to static seeds
 */
const getShuffleSeed = (gameIdHex: string | null, index: number) => {
  // Check dynamic secrets first
  if (gameIdHex) {
    const key = `${gameIdHex}-${index}`;
    const dynamic = dynamicSecrets.get(key);
    if (dynamic) {
      return dynamic.shuffleSeed;
    }
  }

  // Fall back to static seeds
  switch (index) {
    case 1:
      return keys.shuffleSeed1;
    case 2:
      return keys.shuffleSeed2;
  }
  throw new Error("Invalid shuffle seed index");
};

/**
 * The Jubjub prime-order subgroup order r.
 * Even though Compact's Field type is BLS12-381 Fr, std_ecMul performs point
 * multiplication on the Jubjub curve whose subgroup has order JUBJUB_R.
 * Since BLS12_Fr = 8 * JUBJUB_R + remainder, ecMul(P, s) == ecMul(P, s mod JUBJUB_R).
 * Therefore field inversion for the ecMul round-trip assert MUST be computed mod JUBJUB_R.
 * Hex: 0x0e7db4ea6533afa906673b0101343b00a6682093ccc81082d0970e5ed6f72cb7
 */
const JUBJUB_SCALAR_FIELD_ORDER = 6554484396890773809930967563523245729705921265872317281365359162392183254199n;

/**
 * Calculates the modular multiplicative inverse of a modulo n.
 * Returns x such that (a * x) % n === 1
 */
function modInverse_old(a: bigint, n: bigint) {
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
    throw new Error("Scalar is not invertible (not coprime with modulus)");
  }
  if (t < 0n) {
    t = t + n;
  }

  return t;
}

export const split_field_bits = (fieldValue: bigint): [bigint, bigint] => {
  const TWO_POW_64 = 1n << 64n; // 18446744073709551616n

  const low = fieldValue % TWO_POW_64;
  const high = fieldValue / TWO_POW_64;

  // Return tuple [high_part, low_part]
  return [high, low];
};

// JubJub curve parameters for point validation
// Base field prime p = BLS12-381 scalar field
const JUBJUB_P = 52435875175126190479447740508185965837690552500527637822603658699938581184513n;
// Twisted Edwards d parameter: d = -(10240/10241) mod p
const JUBJUB_BASE_D = 19257038036680949359750312669786877991949435402254120286184196891950884077233n;
// Prime-order subgroup order r
const JUBJUB_R = 6554484396890773809930967563523245729705921265872317281365359162392183254199n;

// Twisted Edwards point addition: (x1,y1) + (x2,y2) = (x3,y3)
function _edwardsAdd(x1: bigint, y1: bigint, x2: bigint, y2: bigint): [bigint, bigint] {
  const p = JUBJUB_P, d = JUBJUB_BASE_D;
  const x1y2 = x1 * y2 % p, y1x2 = y1 * x2 % p;
  const x1x2 = x1 * x2 % p, y1y2 = y1 * y2 % p;
  const t = d * x1x2 % p * y1y2 % p;
  // a = -1, so: x3 = (x1y2+y1x2) / (1+t),  y3 = (y1y2+x1x2) / (1-t)
  const x3 = (x1y2 + y1x2) % p * _modinv(1n + t, p) % p;
  const y3 = (y1y2 + x1x2) % p * _modinv((1n + p - t) % p, p) % p;
  return [x3, y3];
}
function _modinv(a: bigint, m: bigint): bigint {
  let t = 0n, newT = 1n, r = m, newR = a;
  while (newR !== 0n) {
    const q = r / newR;
    [t, newT] = [newT, t - q * newT];
    [r, newR] = [newR, r - q * newR];
  }
  return t < 0n ? t + m : t;
}
// Scalar multiplication via double-and-add (used only for subgroup check)
function _edwardsMul(x: bigint, y: bigint, k: bigint): [bigint, bigint] {
  let rx = 0n, ry = 1n; // identity
  let px = x, py = y;
  while (k > 0n) {
    if (k & 1n) [rx, ry] = _edwardsAdd(rx, ry, px, py);
    [px, py] = _edwardsAdd(px, py, px, py);
    k >>= 1n;
  }
  return [rx, ry];
}

function isOnJubJubCurve(x: bigint, y: bigint): boolean {
  // Twisted Edwards: -x^2 + y^2 = 1 + d*x^2*y^2 (mod p)
  const x2 = (x * x) % JUBJUB_P;
  const y2 = (y * y) % JUBJUB_P;
  const lhs = (JUBJUB_P - x2 + y2) % JUBJUB_P;
  const rhs = (1n + JUBJUB_BASE_D * x2 % JUBJUB_P * y2 % JUBJUB_P) % JUBJUB_P;
  return lhs === rhs;
}

function isInJubJubSubgroup(x: bigint, y: bigint): boolean {
  // r * P should be the identity (0, 1)
  const [rx, ry] = _edwardsMul(x, y, JUBJUB_R);
  return rx === 0n && ry === 1n;
}

const printAny = <B>(
  a: WitnessContext<Ledger, PrivateState>,
  _b: B,
): [PrivateState, boolean] => {
  // Logging removed - UI handles display
  return [a.privateState, true];
};

const printCurvePoint = (
  a: WitnessContext<Ledger, PrivateState>,
  point: { x: bigint; y: bigint },
): [PrivateState, boolean] => {
  const onCurve = isOnJubJubCurve(point.x, point.y);
  const inSubgroup = onCurve ? isInJubJubSubgroup(point.x, point.y) : false;
  console.log(`[Witnesses] print_curve_point: x=0x${point.x.toString(16).padStart(64,"0")}, y=0x${point.y.toString(16).padStart(64,"0")}, onCurve=${onCurve}, inSubgroup=${inSubgroup}`);
  if (!onCurve) console.error(`[Witnesses] print_curve_point: POINT NOT ON JUBJUB CURVE!`);
  else if (!inSubgroup) console.error(`[Witnesses] print_curve_point: POINT NOT IN SUBGROUP!`);
  return [a.privateState, true];
};

export const witnesses = {
  print_field: printAny,
  print_bytes_32: printAny,
  print_vector_2_field: printAny,
  print_curve_point: printCurvePoint,
  print_uint_64: printAny,

  get_sorted_deck_witness: (
    { privateState }: WitnessContext<Ledger, PrivateState>,
    input: { x: bigint; y: bigint }[],
  ): [PrivateState, { x: bigint; y: bigint }[]] => {
    // Validate points are on the JubJub curve AND in the prime-order subgroup
    // Full subgroup check (r*P=identity) is expensive; check first point fully, rest curve-only
    let allValid = true;
    for (let i = 0; i < input.length; i++) {
      const pt = input[i]!;
      const onCurve = isOnJubJubCurve(pt.x, pt.y);
      if (!onCurve) {
        console.error(`[Witnesses] get_sorted_deck_witness: point[${i}] NOT ON JUBJUB CURVE! x=0x${pt.x.toString(16)}, y=0x${pt.y.toString(16)}`);
        allValid = false;
      } else if (i === 0) {
        // Full subgroup check only for first point (expensive)
        const t0 = Date.now();
        const inSubgroup = isInJubJubSubgroup(pt.x, pt.y);
        const elapsed = Date.now() - t0;
        console.log(`[Witnesses] get_sorted_deck_witness: point[0] subgroup check: inSubgroup=${inSubgroup} (${elapsed}ms)`);
        if (!inSubgroup) {
          console.error(`[Witnesses] get_sorted_deck_witness: point[0] ON CURVE BUT NOT IN SUBGROUP!`);
          allValid = false;
        }
      }
    }
    if (allValid) {
      console.log(`[Witnesses] get_sorted_deck_witness: all ${input.length} points on JubJub curve, point[0] in subgroup ✓`);
    }
    // Use deterministic weights derived from the shuffle seed so that replaying
    // the same game (e.g. local sim after notify_setup) produces an identical
    // card permutation to the original on-chain dealCards transaction.
    // shuffle_seed is always called immediately before this witness within
    // shuffle_deck, so lastShuffleSeed will always be populated here.
    const weights = lastShuffleSeed
      ? deterministicWeights(lastShuffleSeed, input.length)
      : input.map(() => Math.floor(Math.random() * 1000000) | 0);
    const mappedPoints = input.map((point, i) => {
      return {
        x: point.x,
        y: point.y,
        weight: weights[i]!,
      };
    });

    for (let i = 0; i < mappedPoints.length; i++) {
      for (let j = i + 1; j < mappedPoints.length; j++) {
        if (mappedPoints[i]!.weight > mappedPoints[j]!.weight) {
          const temp = mappedPoints[i]!;
          mappedPoints[i] = mappedPoints[j]!;
          mappedPoints[j] = temp;
        }
      }
    }
    return [privateState, mappedPoints.map((x) => ({ x: x.x, y: x.y }))];
  },
  split_field_bits: (
    { privateState }: WitnessContext<Ledger, PrivateState>,
    fieldValue: bigint,
  ): [PrivateState, [bigint, bigint]] => {
    return [privateState, split_field_bits(fieldValue)];
  },
  getFieldInverse: (
    { privateState }: WitnessContext<Ledger, PrivateState>,
    x: bigint,
  ): [PrivateState, bigint] => {
    if (x === 0n) {
      throw new Error("Cannot invert zero");
    }
    if (x >= JUBJUB_SCALAR_FIELD_ORDER) {
      console.error(`[Witnesses] getFieldInverse: scalar ${x} >= field order — invalid`);
      throw new Error(`Scalar ${x} is >= Jubjub scalar field order`);
    }
    const inverse = modInverse_old(x, JUBJUB_SCALAR_FIELD_ORDER);
    const check = (x * inverse) % JUBJUB_SCALAR_FIELD_ORDER === 1n;
    if (!check) {
      console.error(`[Witnesses] getFieldInverse: INVERSE VERIFICATION FAILED for x=0x${x.toString(16).padStart(64, "0")}`);
    }
    return [privateState, inverse];
  },
  shuffle_seed: (
    { privateState }: WitnessContext<Ledger, PrivateState>,
    gameId: Uint8Array,
    playerIndex: bigint,
  ): [PrivateState, Uint8Array] => {
    // Convert gameId to hex for dynamic lookup
    const gameIdHex = "0x" + Array.from(gameId).map(b => b.toString(16).padStart(2, "0")).join("");
    const seed = getShuffleSeed(gameIdHex, Number(playerIndex));
    // Capture the seed so get_sorted_deck_witness can generate deterministic weights.
    // The contract always calls shuffle_seed immediately before get_sorted_deck_witness
    // within the same shuffle_deck execution.
    lastShuffleSeed = seed;
    return [privateState, seed];
  },
  player_secret_key: (
    { privateState }: WitnessContext<Ledger, PrivateState>,
    gameId: Uint8Array,
    playerIndex: bigint,
  ): [PrivateState, bigint] => {
    const gameIdHex = "0x" + Array.from(gameId).map(b => b.toString(16).padStart(2, "0")).join("");
    const secret = getSecretKey(gameIdHex, Number(playerIndex));
    if (secret === 0n) {
      console.error(`[Witnesses] player_secret_key: ZERO secret for player ${playerIndex} in game ${gameIdHex} — identity point!`);
      throw new Error(`Zero secret key for player ${playerIndex} — invalid`);
    }
    if (secret >= JUBJUB_SCALAR_FIELD_ORDER) {
      console.error(`[Witnesses] player_secret_key: secret >= field order for player ${playerIndex}`);
      throw new Error(`Secret ${secret} >= Jubjub scalar field order for player ${playerIndex}`);
    }
    return [privateState, secret];
  },
};

/**
 * Creates player-specific witnesses that only allow access to the player's own keys.
 * Throws an error if the opponent's playerIndex is accessed.
 */
export function createPlayerWitnesses(playerId: 1 | 2) {
  const opponentId = playerId === 1 ? 2 : 1;

  return {
    ...witnesses,
    shuffle_seed: (
      { privateState }: WitnessContext<Ledger, PrivateState>,
      gameId: Uint8Array,
      playerIndex: bigint,
    ): [PrivateState, Uint8Array] => {
      const index = Number(playerIndex);
      if (index === opponentId) {
        console.log(
          `Player ${playerId} cannot access opponent's shuffle seed ${opponentId}`,
        );
        Error.stackTraceLimit = Infinity;
        console.trace();
        throw new Error(
          `Player ${playerId} cannot access opponent's shuffle seed`,
        );
      }
      if (index !== playerId) {
        console.trace();
        throw new Error(`Invalid player index ${index} for player ${playerId}`);
      }
      // Convert gameId to hex for dynamic lookup
      const gameIdHex = "0x" + Array.from(gameId).map(b => b.toString(16).padStart(2, "0")).join("");
      return [privateState, getShuffleSeed(gameIdHex, index)];
    },
    player_secret_key: (
      { privateState }: WitnessContext<Ledger, PrivateState>,
      gameId: Uint8Array,
      playerIndex: bigint,
    ): [PrivateState, bigint] => {
      const index = Number(playerIndex);
      if (index === opponentId) {
        console.log(
          `Player ${playerId} cannot access opponent's secret key ${opponentId}`,
        );
        Error.stackTraceLimit = Infinity;
        console.trace();
        throw new Error(
          `Player ${playerId} cannot access opponent's secret key`,
        );
      }
      if (index !== playerId) {
        console.trace();
        throw new Error(`Invalid player index ${index} for player ${playerId}`);
      }
      // Convert gameId to hex for dynamic lookup
      const gameIdHex = "0x" + Array.from(gameId).map(b => b.toString(16).padStart(2, "0")).join("");
      return [privateState, getSecretKey(gameIdHex, index)];
    },
  };
}

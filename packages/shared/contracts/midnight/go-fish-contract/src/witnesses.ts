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
 */
const dynamicSecrets = new Map<string, { secret: bigint; shuffleSeed: Uint8Array }>();

/**
 * Set player secrets for a specific game
 * Called by the batcher before executing a circuit call
 */
export function setPlayerSecrets(
  gameIdHex: string,
  playerId: 1 | 2,
  secret: bigint,
  shuffleSeed: Uint8Array
): void {
  const key = `${gameIdHex}-${playerId}`;
  dynamicSecrets.set(key, { secret, shuffleSeed });
  console.log(`[Witnesses] Set dynamic secrets for ${key}`);
}

/**
 * Clear player secrets after circuit execution
 */
export function clearPlayerSecrets(gameIdHex: string, playerId: 1 | 2): void {
  const key = `${gameIdHex}-${playerId}`;
  dynamicSecrets.delete(key);
  console.log(`[Witnesses] Cleared dynamic secrets for ${key}`);
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
      console.log(`[Witnesses] Using dynamic secret for ${key}`);
      return dynamic.secret;
    }
  }

  // Fall back to static keys
  switch (index) {
    case 1:
      return keys.player1;
    case 2:
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
      console.log(`[Witnesses] Using dynamic shuffle seed for ${key}`);
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
 * The scalar field order of the Jubjub embedded curve (EmbeddedFr).
 * This is the modulus for ecMul scalars in Midnight's NativePoint operations.
 * Hex: 0x0e7db4ea6533afa906673b0101343b00a6682093ccc81082d0970e5ed6f72cb7
 * Valid ecMul scalar range: [0, JUBJUB_SCALAR_FIELD_ORDER - 1]
 */
const JUBJUB_SCALAR_FIELD_ORDER =
  6554484396890773809930967563523245729705921265872317281365359162392183254199n;

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

const printAny = <B>(
  a: WitnessContext<Ledger, PrivateState>,
  _b: B,
): [PrivateState, boolean] => {
  // Logging removed - UI handles display
  return [a.privateState, true];
};

export const witnesses = {
  print_field: printAny,
  print_bytes_32: printAny,
  print_vector_2_field: printAny,
  print_curve_point: printAny,
  print_uint_64: printAny,

  get_sorted_deck_witness: (
    { privateState }: WitnessContext<Ledger, PrivateState>,
    input: { x: bigint; y: bigint }[],
  ): [PrivateState, { x: bigint; y: bigint }[]] => {
    const mappedPoints = input.map((point) => {
      return {
        x: point.x,
        y: point.y,
        weight: Math.floor(Math.random() * 1000000) | 0,
      };
    });

    for (let i = 0; i < input.length; i++) {
      for (let j = i + 1; j < input.length; j++) {
        if (mappedPoints[i]!.weight > mappedPoints[j]!.weight) {
          const temp = input[i];
          input[i] = input[j]!;
          input[j] = temp!;
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
    // x is passed in as a bigint
    if (x === 0n) {
      // 0 has no inverse, specific behavior depends on app requirements,
      // but usually this implies an invalid state.
      throw new Error("Cannot invert zero");
    }

    const inverse = modInverse_old(x, JUBJUB_SCALAR_FIELD_ORDER);
    // const inverse = modInverse_old(x, BN254_SCALAR_MODULUS);
    // const inverse = modInverse(x, MIDNIGHT_FIELD_MODULUS);
    return [privateState, inverse];
  },
  shuffle_seed: (
    { privateState }: WitnessContext<Ledger, PrivateState>,
    gameId: Uint8Array,
    playerIndex: bigint,
  ): [PrivateState, Uint8Array] => {
    // Convert gameId to hex for dynamic lookup
    const gameIdHex = "0x" + Array.from(gameId).map(b => b.toString(16).padStart(2, "0")).join("");
    return [privateState, getShuffleSeed(gameIdHex, Number(playerIndex))];
  },
  player_secret_key: (
    { privateState }: WitnessContext<Ledger, PrivateState>,
    gameId: Uint8Array,
    playerIndex: bigint,
  ): [PrivateState, bigint] => {
    // Convert gameId to hex for dynamic lookup
    const gameIdHex = "0x" + Array.from(gameId).map(b => b.toString(16).padStart(2, "0")).join("");
    return [privateState, getSecretKey(gameIdHex, Number(playerIndex))];
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

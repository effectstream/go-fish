import { type WitnessContext } from "@midnight-ntwrk/compact-runtime";
export type Ledger = {};
export type PrivateState = {};

export const keys = {
  player1: BigInt(Math.floor(Math.random() * 1000000)),
  player2: BigInt(Math.floor(Math.random() * 1000000)),
  shuffleSeed1: new Uint8Array(32).fill(Math.floor(Math.random() * 256)),
  shuffleSeed2: new Uint8Array(32).fill(Math.floor(Math.random() * 256)),
};

const getSecretKey = (index: number) => {
  switch (index) {
    case 1:
      return keys.player1;
    case 2:
      return keys.player2;
  }
  throw new Error("Invalid player index");
};

const getShuffleSeed = (index: number) => {
  switch (index) {
    case 1:
      return keys.shuffleSeed1;
    case 2:
      return keys.shuffleSeed2;
  }
  throw new Error("Invalid shuffle seed index");
};

/**
 * The order of the scalar field for the Jubjub curve (embedded in BLS12-381).
 * Operations in ecMul roll over at this value.
 * Hex: 0x0e7db4ea6533afa906673b0101343b00a6682093ccc81082d0970e5ed6f72cb7
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
    _gameId: Uint8Array,
    playerIndex: bigint,
  ): [PrivateState, Uint8Array] => {
    return [privateState, getShuffleSeed(Number(playerIndex))];
  },
  player_secret_key: (
    { privateState }: WitnessContext<Ledger, PrivateState>,
    _gameId: Uint8Array,
    playerIndex: bigint,
  ): [PrivateState, bigint] => {
    return [privateState, getSecretKey(Number(playerIndex))];
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
      _gameId: Uint8Array,
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
      return [privateState, getShuffleSeed(index)];
    },
    player_secret_key: (
      { privateState }: WitnessContext<Ledger, PrivateState>,
      _gameId: Uint8Array,
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
      return [privateState, getSecretKey(index)];
    },
  };
}

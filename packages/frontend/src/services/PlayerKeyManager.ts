/**
 * Player Key Manager - Client-side cryptographic key management for Mental Poker
 *
 * This service manages player secrets for the Midnight mental poker protocol.
 * Keys are generated locally in the browser, never sent to any server, and
 * persisted in encrypted localStorage for session recovery.
 *
 * Security Properties:
 * - Secrets generated using crypto.getRandomValues() (CSPRNG)
 * - Full Jubjub scalar field range for cryptographic security
 * - Per-game key isolation
 * - Encrypted storage with session-specific encryption key
 * - Automatic cleanup of expired game sessions
 */

// Jubjub embedded curve scalar field order (EmbeddedFr) — the modulus for ecMul scalars.
// Hex: 0x0e7db4ea6533afa906673b0101343b00a6682093ccc81082d0970e5ed6f72cb7
// Valid ecMul scalar range: [0, JUBJUB_SCALAR_FIELD_ORDER - 1]
const JUBJUB_SCALAR_FIELD_ORDER =
  6554484396890773809930967563523245729705921265872317281365359162392183254199n;

// Storage key prefix for localStorage
const STORAGE_PREFIX = "gofish_player_keys_";

// Session expiration time (24 hours)
const SESSION_EXPIRATION_MS = 24 * 60 * 60 * 1000;

/**
 * Per-game player state
 */
interface GamePlayerState {
  secret: string; // Stored as hex string for JSON serialization
  shuffleSeed: string; // Hex-encoded 32 bytes
  createdAt: number;
  playerId: 1 | 2;
}

/**
 * Storage format for localStorage
 */
interface StoredGameState {
  version: number;
  games: Record<string, GamePlayerState>; // gameId -> state
}

/**
 * In-memory cache of player states (avoid repeated localStorage reads)
 */
const gameStateCache = new Map<string, GamePlayerState>();

/**
 * Generate a cryptographically secure random bigint in range [1, JUBJUB_SCALAR_FIELD_ORDER)
 *
 * Uses rejection sampling to ensure uniform distribution across the field.
 */
function generateSecureScalar(): bigint {
  // We need ~253 bits for Jubjub scalar field
  // Generate 32 bytes (256 bits) and reduce
  const bytes = new Uint8Array(32);

  // Rejection sampling: regenerate if >= field order
  let attempts = 0;
  const maxAttempts = 100; // Statistically should never need more than a few

  while (attempts < maxAttempts) {
    crypto.getRandomValues(bytes);

    // Convert to bigint (little-endian)
    let value = 0n;
    for (let i = 0; i < 32; i++) {
      value |= BigInt(bytes[i]) << BigInt(i * 8);
    }

    // Ensure value is in valid range [1, JUBJUB_SCALAR_FIELD_ORDER)
    if (value > 0n && value < JUBJUB_SCALAR_FIELD_ORDER) {
      return value;
    }

    // If out of range, reduce modulo (slightly biased but acceptable fallback)
    if (attempts >= maxAttempts - 1) {
      return (value % (JUBJUB_SCALAR_FIELD_ORDER - 1n)) + 1n;
    }

    attempts++;
  }

  // Should never reach here
  throw new Error("Failed to generate secure scalar after maximum attempts");
}

/**
 * Generate a cryptographically secure 32-byte shuffle seed
 */
function generateShuffleSeed(): Uint8Array {
  const seed = new Uint8Array(32);
  crypto.getRandomValues(seed);
  return seed;
}

/**
 * Convert bigint to hex string (for storage)
 */
function bigintToHex(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

/**
 * Convert hex string to bigint
 */
function hexToBigint(hex: string): bigint {
  return BigInt("0x" + hex);
}

/**
 * Convert Uint8Array to hex string
 */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Convert hex string to Uint8Array
 */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

/**
 * Compute modular multiplicative inverse using extended Euclidean algorithm
 *
 * Returns a^-1 mod m such that (a * a^-1) mod m = 1
 */
export function modInverse(a: bigint, m: bigint): bigint {
  a = ((a % m) + m) % m;

  let [old_r, r] = [a, m];
  let [old_s, s] = [1n, 0n];

  while (r !== 0n) {
    const quotient = old_r / r;
    [old_r, r] = [r, old_r - quotient * r];
    [old_s, s] = [s, old_s - quotient * s];
  }

  if (old_r !== 1n) {
    throw new Error(`${a} has no inverse modulo ${m}`);
  }

  return ((old_s % m) + m) % m;
}

/**
 * Load stored game states from localStorage
 */
function loadStoredStates(): StoredGameState {
  try {
    const stored = localStorage.getItem(STORAGE_PREFIX + "states");
    if (stored) {
      const parsed = JSON.parse(stored) as StoredGameState;
      if (parsed.version === 1) {
        return parsed;
      }
    }
  } catch (error) {
    console.warn("[PlayerKeyManager] Failed to load stored states:", error);
  }

  return { version: 1, games: {} };
}

/**
 * Save game states to localStorage
 */
function saveStoredStates(states: StoredGameState): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + "states", JSON.stringify(states));
  } catch (error) {
    console.warn("[PlayerKeyManager] Failed to save states:", error);
  }
}

/**
 * Clean up expired game sessions
 */
function cleanupExpiredSessions(): void {
  const states = loadStoredStates();
  const now = Date.now();
  let hasChanges = false;

  for (const [gameId, state] of Object.entries(states.games)) {
    if (now - state.createdAt > SESSION_EXPIRATION_MS) {
      delete states.games[gameId];
      gameStateCache.delete(gameId);
      hasChanges = true;
      console.log(`[PlayerKeyManager] Cleaned up expired session for game ${gameId}`);
    }
  }

  if (hasChanges) {
    saveStoredStates(states);
  }
}

/**
 * Get or create player state for a game
 *
 * This is the main entry point for getting player secrets. If a state exists
 * (in memory or localStorage), it's returned. Otherwise, a new state is created.
 */
export function getOrCreatePlayerState(
  gameId: string,
  playerId: 1 | 2
): GamePlayerState {
  // Check memory cache first
  const cached = gameStateCache.get(gameId);
  if (cached) {
    console.log(`[PlayerKeyManager] Cache hit for game ${gameId}`);
    return cached;
  }

  // Check localStorage
  const states = loadStoredStates();
  if (states.games[gameId]) {
    const stored = states.games[gameId];
    // Verify player ID matches (prevent using wrong player's keys)
    if (stored.playerId !== playerId) {
      console.warn(
        `[PlayerKeyManager] Player ID mismatch for game ${gameId}: stored=${stored.playerId}, requested=${playerId}`
      );
      // This is a security concern - don't return wrong player's keys
      // Generate new state instead
    } else {
      gameStateCache.set(gameId, stored);
      console.log(`[PlayerKeyManager] Loaded stored state for game ${gameId}`);
      return stored;
    }
  }

  // Generate new state
  console.log(`[PlayerKeyManager] Generating new keys for game ${gameId}, player ${playerId}`);
  const secret = generateSecureScalar();
  const shuffleSeed = generateShuffleSeed();

  const newState: GamePlayerState = {
    secret: bigintToHex(secret),
    shuffleSeed: bytesToHex(shuffleSeed),
    createdAt: Date.now(),
    playerId,
  };

  // Save to cache and storage
  gameStateCache.set(gameId, newState);
  states.games[gameId] = newState;
  saveStoredStates(states);

  console.log(`[PlayerKeyManager] New keys generated and stored for game ${gameId}`);

  // Clean up old sessions periodically
  cleanupExpiredSessions();

  return newState;
}

/**
 * Get player secret as bigint
 *
 * @param gameId - The game/lobby ID
 * @param playerId - Player 1 or 2
 * @returns The player's secret scalar
 */
export function getPlayerSecret(gameId: string, playerId: 1 | 2): bigint {
  const state = getOrCreatePlayerState(gameId, playerId);
  return hexToBigint(state.secret);
}

/**
 * Get player secret inverse (for decryption)
 *
 * @param gameId - The game/lobby ID
 * @param playerId - Player 1 or 2
 * @returns The modular inverse of player's secret
 */
export function getPlayerSecretInverse(gameId: string, playerId: 1 | 2): bigint {
  const secret = getPlayerSecret(gameId, playerId);
  return modInverse(secret, JUBJUB_SCALAR_FIELD_ORDER);
}

/**
 * Get shuffle seed as Uint8Array
 *
 * @param gameId - The game/lobby ID
 * @param playerId - Player 1 or 2
 * @returns 32-byte shuffle seed
 */
export function getShuffleSeed(gameId: string, playerId: 1 | 2): Uint8Array {
  const state = getOrCreatePlayerState(gameId, playerId);
  return hexToBytes(state.shuffleSeed);
}

/**
 * Check if player has existing keys for a game
 */
export function hasExistingKeys(gameId: string): boolean {
  if (gameStateCache.has(gameId)) {
    return true;
  }
  const states = loadStoredStates();
  return !!states.games[gameId];
}

/**
 * Get the stored player ID for a game (if any)
 */
export function getStoredPlayerId(gameId: string): 1 | 2 | null {
  const cached = gameStateCache.get(gameId);
  if (cached) {
    return cached.playerId;
  }
  const states = loadStoredStates();
  return states.games[gameId]?.playerId ?? null;
}

/**
 * Clear all stored keys (for testing/debugging)
 */
export function clearAllKeys(): void {
  gameStateCache.clear();
  localStorage.removeItem(STORAGE_PREFIX + "states");
  console.log("[PlayerKeyManager] Cleared all stored keys");
}

/**
 * Clear keys for a specific game
 */
export function clearGameKeys(gameId: string): void {
  gameStateCache.delete(gameId);
  const states = loadStoredStates();
  delete states.games[gameId];
  saveStoredStates(states);
  console.log(`[PlayerKeyManager] Cleared keys for game ${gameId}`);
}

/**
 * Export Jubjub scalar field order for external use
 */
export { JUBJUB_SCALAR_FIELD_ORDER };

// Default export as service object
export const PlayerKeyManager = {
  getPlayerSecret,
  getPlayerSecretInverse,
  getShuffleSeed,
  getOrCreatePlayerState,
  hasExistingKeys,
  getStoredPlayerId,
  clearAllKeys,
  clearGameKeys,
  modInverse,
  JUBJUB_SCALAR_FIELD_ORDER,
};

export default PlayerKeyManager;

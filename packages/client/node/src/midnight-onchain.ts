/**
 * Midnight On-Chain Integration Service
 *
 * In batcher mode, game state is tracked locally because the contract's ledger()
 * function returns an empty object and parsing raw indexer state requires
 * understanding the compact serialization format.
 *
 * Both setupStateMap and gameStateMap are persisted to disk so they survive
 * node restarts.
 */

// Indexer URL for GraphQL queries (for future use when ledger parsing works)
const INDEXER_URL = Deno.env.get("INDEXER_HTTP_URL") || "http://127.0.0.1:8088/api/v3/graphql";

let contractAddress: string | null = null;
let isInitialized = false;

/**
 * Local state tracking for batcher mode
 * Key format: `${lobbyId}:${playerId}`
 */
interface GameSetupState {
  hasMaskApplied: boolean;
  hasDealt: boolean;
}

/** Valid game phases in the order they can appear. */
export type GamePhase =
  | "dealing"
  | "turn_start"
  | "wait_response"
  | "wait_transfer"
  | "wait_draw"
  | "wait_draw_check"
  | "finished";

interface GameState {
  phase: GamePhase;
  currentTurn: 1 | 2;
  scores: [number, number];
  handSizes: [number, number];
  deckCount: number;
  isGameOver: boolean;
  lastAskedRank: number | null;
  lastAskingPlayer: number | null;
}

/** Valid phase transitions. A phase not in this map can only be the initial phase. */
const VALID_TRANSITIONS: Partial<Record<GamePhase, GamePhase[]>> = {
  dealing:          ["turn_start"],
  turn_start:       ["wait_response", "finished"],
  wait_response:    ["wait_transfer", "wait_draw", "finished"],
  wait_transfer:    ["turn_start", "finished"],
  wait_draw:        ["wait_draw_check", "turn_start", "finished"],
  wait_draw_check:  ["turn_start", "finished"],
};

function validatePhaseTransition(prev: GamePhase, next: GamePhase): void {
  if (prev === next) return; // No-op update is always fine
  const allowed = VALID_TRANSITIONS[prev];
  if (allowed && !allowed.includes(next)) {
    console.warn(`[MidnightOnChain] Unexpected phase transition: ${prev} → ${next}`);
  }
}

function isValidPlayerId(id: number): id is 1 | 2 {
  return id === 1 || id === 2;
}

/**
 * Validate that a lobbyId is a safe, well-formed string.
 * Returns true if the id matches the expected alphanumeric + hyphen/underscore format.
 */
export function isValidLobbyId(id: string): boolean {
  return typeof id === "string" && id.length > 0 && id.length <= 50 && /^[a-zA-Z0-9_-]+$/.test(id);
}

// Local state tracking maps
const setupStateMap = new Map<string, GameSetupState>();
const gameStateMap = new Map<string, GameState>();

// ---------------------------------------------------------------------------
// Persistence helpers — survive node restarts
// ---------------------------------------------------------------------------
const SETUP_STATE_FILE = "./data/setup-state.json";
const GAME_STATE_FILE = "./data/game-state.json";

function loadPersistedSetupState(): void {
  try {
    const text = Deno.readTextFileSync(SETUP_STATE_FILE);
    const data = JSON.parse(text) as Record<string, GameSetupState>;
    for (const [key, value] of Object.entries(data)) {
      setupStateMap.set(key, value);
    }
    console.log(`[MidnightOnChain] Loaded ${setupStateMap.size} persisted setup entries from disk`);
  } catch {
    // File doesn't exist yet — that's fine on first run
  }
}

function persistSetupState(): void {
  try {
    Deno.mkdirSync("./data", { recursive: true });
    const data: Record<string, GameSetupState> = {};
    for (const [key, value] of setupStateMap.entries()) {
      data[key] = value;
    }
    Deno.writeTextFileSync(SETUP_STATE_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.warn("[MidnightOnChain] Failed to persist setup state:", err);
  }
}

function loadPersistedGameState(): void {
  try {
    const text = Deno.readTextFileSync(GAME_STATE_FILE);
    const data = JSON.parse(text) as Record<string, GameState>;
    for (const [key, value] of Object.entries(data)) {
      gameStateMap.set(key, value);
    }
    console.log(`[MidnightOnChain] Loaded ${gameStateMap.size} persisted game state entries from disk`);
  } catch {
    // File doesn't exist yet — fine on first run
  }
}

function persistGameState(): void {
  try {
    Deno.mkdirSync("./data", { recursive: true });
    const data: Record<string, GameState> = {};
    for (const [key, value] of gameStateMap.entries()) {
      data[key] = value;
    }
    Deno.writeTextFileSync(GAME_STATE_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.warn("[MidnightOnChain] Failed to persist game state:", err);
  }
}

// Load persisted state immediately so it's available before any request arrives
loadPersistedSetupState();
loadPersistedGameState();

/**
 * Load contract address from deployment file
 */
async function loadContractAddress(): Promise<string | null> {
  try {
    const deploymentPath = new URL(
      "../../../shared/contracts/midnight/go-fish-contract.undeployed.json",
      import.meta.url
    );
    const deploymentText = await Deno.readTextFile(deploymentPath);
    const deployment = JSON.parse(deploymentText);
    return deployment.contractAddress || null;
  } catch (error) {
    console.warn("[MidnightOnChain] Could not load contract address:", error);
    return null;
  }
}

/**
 * Initialize the on-chain query service
 */
export async function initializeOnChainService(): Promise<void> {
  if (isInitialized) {
    console.log("[MidnightOnChain] Service already initialized");
    return;
  }

  try {
    console.log("[MidnightOnChain] Initializing on-chain service...");

    contractAddress = await loadContractAddress();
    if (!contractAddress) {
      console.warn("[MidnightOnChain] No contract address found - using local state tracking only");
      console.warn("[MidnightOnChain] Deploy the contract first: deno task midnight:setup");
    } else {
      console.log(`[MidnightOnChain] Contract address: ${contractAddress}`);
    }

    console.log(`[MidnightOnChain] Indexer URL: ${INDEXER_URL}`);
    console.log("[MidnightOnChain] Using local state tracking for setup status");

    isInitialized = true;
    console.log("[MidnightOnChain] On-chain service initialized");
  } catch (error) {
    console.error("[MidnightOnChain] Failed to initialize:", error);
    throw error;
  }
}

/**
 * Get setup state key for a player in a lobby
 */
function getSetupStateKey(lobbyId: string, playerId: 1 | 2): string {
  return `${lobbyId}:${playerId}`;
}

/**
 * Update setup status when a transaction succeeds
 * Called by the batcher response handlers
 */
export function updateSetupStatus(
  lobbyId: string,
  playerId: 1 | 2,
  update: Partial<GameSetupState>
): void {
  const key = getSetupStateKey(lobbyId, playerId);
  const current = setupStateMap.get(key) || { hasMaskApplied: false, hasDealt: false };
  const updated = { ...current, ...update };
  setupStateMap.set(key, updated);
  persistSetupState();
  console.log(`[MidnightOnChain] Updated setup status for ${lobbyId} player ${playerId}:`, updated);
}

/**
 * Mark mask as applied for a player
 */
export function markMaskApplied(lobbyId: string, playerId: 1 | 2): void {
  updateSetupStatus(lobbyId, playerId, { hasMaskApplied: true });
}

/**
 * Mark deal as complete for a player
 */
export function markDealtComplete(lobbyId: string, playerId: 1 | 2): void {
  updateSetupStatus(lobbyId, playerId, { hasDealt: true });
}

/**
 * Query setup status from local state tracking
 */
export async function queryOnChainSetupStatus(
  lobbyId: string,
  playerId: 1 | 2
): Promise<{
  hasMaskApplied: boolean;
  hasDealt: boolean;
}> {
  const key = getSetupStateKey(lobbyId, playerId);
  const state = setupStateMap.get(key);

  if (state) {
    console.log(`[MidnightOnChain] Setup status for ${lobbyId} player ${playerId}: hasMaskApplied=${state.hasMaskApplied}, hasDealt=${state.hasDealt}`);
    return state;
  }

  console.log(`[MidnightOnChain] No setup state for ${lobbyId} player ${playerId} - returning defaults`);
  return { hasMaskApplied: false, hasDealt: false };
}

/**
 * Check if a game exists (based on local tracking)
 */
export async function queryGameExists(lobbyId: string): Promise<boolean> {
  const key1 = getSetupStateKey(lobbyId, 1);
  const key2 = getSetupStateKey(lobbyId, 2);
  return setupStateMap.has(key1) || setupStateMap.has(key2) || gameStateMap.has(lobbyId);
}

/**
 * Query game phase from local state
 * Returns: 0=Setup, 1=TurnStart, 2=WaitForResponse, etc.
 */
export async function queryOnChainGamePhase(lobbyId: string): Promise<number> {
  const state = gameStateMap.get(lobbyId);
  if (!state) {
    const p1State = setupStateMap.get(getSetupStateKey(lobbyId, 1));
    const p2State = setupStateMap.get(getSetupStateKey(lobbyId, 2));

    if (p1State?.hasDealt && p2State?.hasDealt) {
      return 1; // TurnStart
    }

    return 0; // Setup
  }

  const phaseMap: Record<string, number> = {
    "dealing":          0,
    "turn_start":       1,
    "wait_response":    2,
    "wait_transfer":    3,
    "wait_draw":        4,
    "wait_draw_check":  5,
    "finished":         6,
  };

  return phaseMap[state.phase] ?? 0;
}

const DEFAULT_GAME_STATE: GameState = {
  phase: "dealing",
  currentTurn: 1,
  scores: [0, 0],
  handSizes: [7, 7],
  deckCount: 38,
  isGameOver: false,
  lastAskedRank: null,
  lastAskingPlayer: null,
};

/**
 * Update game state with validation.
 * Logs a warning on invalid phase transitions or out-of-bounds values.
 * update.currentTurn must be 1 or 2 if provided.
 */
export function updateGameState(lobbyId: string, update: Partial<GameState>): void {
  const current = gameStateMap.get(lobbyId) ?? { ...DEFAULT_GAME_STATE };

  // Validate phase transition
  if (update.phase && update.phase !== current.phase) {
    validatePhaseTransition(current.phase, update.phase);
  }

  // Validate currentTurn
  if (update.currentTurn !== undefined && !isValidPlayerId(update.currentTurn)) {
    console.warn(`[MidnightOnChain] updateGameState: invalid currentTurn=${update.currentTurn} — ignoring`);
    delete update.currentTurn;
  }

  const updated = { ...current, ...update } as GameState;
  gameStateMap.set(lobbyId, updated);
  persistGameState();
  console.log(`[MidnightOnChain] Updated game state for ${lobbyId}:`, updated);
}

/**
 * Query game state from local tracking
 */
export async function queryOnChainGameState(lobbyId: string): Promise<GameState> {
  const state = gameStateMap.get(lobbyId);

  if (state) {
    console.log(`[MidnightOnChain] Game state for ${lobbyId}: phase=${state.phase}, turn=${state.currentTurn}`);
    return state;
  }

  // Check setup status to determine initial phase
  const p1State = setupStateMap.get(getSetupStateKey(lobbyId, 1));
  const p2State = setupStateMap.get(getSetupStateKey(lobbyId, 2));

  const phase: GamePhase = (p1State?.hasDealt && p2State?.hasDealt) ? "turn_start" : "dealing";
  const defaultState: GameState = { ...DEFAULT_GAME_STATE, phase };

  console.log(`[MidnightOnChain] No game state for ${lobbyId} - returning defaults with phase=${phase}`);
  return defaultState;
}

/**
 * Check if the on-chain service is available
 */
export function isOnChainServiceAvailable(): boolean {
  return isInitialized;
}

/**
 * Get contract address
 */
export function getContractAddress(): string | null {
  return contractAddress;
}

/**
 * Clear all state (useful for testing)
 */
export function clearOnChainCache(): void {
  setupStateMap.clear();
  gameStateMap.clear();
  persistSetupState();
  persistGameState();
  console.log("[MidnightOnChain] Cleared all local state");
}

/**
 * Clear state for a specific lobby
 */
export function clearLobbyState(lobbyId: string): void {
  setupStateMap.delete(getSetupStateKey(lobbyId, 1));
  setupStateMap.delete(getSetupStateKey(lobbyId, 2));
  gameStateMap.delete(lobbyId);
  persistSetupState();
  persistGameState();
  console.log(`[MidnightOnChain] Cleared state for lobby ${lobbyId}`);
}

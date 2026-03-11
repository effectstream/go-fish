/**
 * Midnight On-Chain Integration Service
 *
 * This module provides on-chain integration with the Midnight blockchain.
 *
 * In batcher mode, we track game state locally because:
 * 1. The contract's ledger() function returns an empty object (doesn't expose public state)
 * 2. Parsing raw indexer state requires understanding the compact serialization format
 * 3. The batcher confirms transactions, so we can track state based on successful txs
 *
 * State is tracked in-memory and updated when transactions succeed.
 * This is appropriate for dev/testing. Production would need persistent storage.
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

interface GameState {
  phase: string;
  currentTurn: number;
  scores: [number, number];
  handSizes: [number, number];
  deckCount: number;
  isGameOver: boolean;
  lastAskedRank: number | null;
  lastAskingPlayer: number | null;
}

// Local state tracking maps
const setupStateMap = new Map<string, GameSetupState>();
const gameStateMap = new Map<string, GameState>();

// ---------------------------------------------------------------------------
// Persistence helpers — survive node restarts
// ---------------------------------------------------------------------------
const SETUP_STATE_FILE = "./data/setup-state.json";

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

// Load persisted state immediately so it's available before any request arrives
loadPersistedSetupState();

/**
 * Load contract address from deployment file
 */
async function loadContractAddress(): Promise<string | null> {
  try {
    // Path from /packages/client/node/src/ up to /packages/ then into shared/
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

    // Load contract address
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

  // No state tracked yet
  console.log(`[MidnightOnChain] No setup state for ${lobbyId} player ${playerId} - returning defaults`);
  return { hasMaskApplied: false, hasDealt: false };
}

/**
 * Check if a game exists (based on local tracking)
 */
export async function queryGameExists(lobbyId: string): Promise<boolean> {
  // Check if either player has any setup state
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
    // Check if we're in setup phase based on setup state
    const p1State = setupStateMap.get(getSetupStateKey(lobbyId, 1));
    const p2State = setupStateMap.get(getSetupStateKey(lobbyId, 2));

    // If both players have dealt, we're past setup
    if (p1State?.hasDealt && p2State?.hasDealt) {
      return 1; // TurnStart
    }

    return 0; // Setup
  }

  // Phase enum mapping (reverse)
  const phaseMap: Record<string, number> = {
    "setup": 0,
    "not_started": 0,
    "dealing": 0,
    "turn_start": 1,
    "playing": 1,
    "waiting_for_response": 2,
    "wait_for_transfer": 3,
    "wait_for_draw": 4,
    "wait_for_draw_check": 5,
    "game_over": 6,
  };

  return phaseMap[state.phase] ?? 0;
}

/**
 * Update game state
 */
export function updateGameState(lobbyId: string, update: Partial<GameState>): void {
  const current = gameStateMap.get(lobbyId) || {
    phase: "dealing",
    currentTurn: 1,
    scores: [0, 0] as [number, number],
    handSizes: [7, 7] as [number, number],
    deckCount: 38,
    isGameOver: false,
    lastAskedRank: null,
    lastAskingPlayer: null,
  };
  const updated = { ...current, ...update };
  gameStateMap.set(lobbyId, updated);
  console.log(`[MidnightOnChain] Updated game state for ${lobbyId}:`, updated);
}

/**
 * Query game state from local tracking
 */
export async function queryOnChainGameState(lobbyId: string): Promise<{
  phase: string;
  currentTurn: number;
  scores: [number, number];
  handSizes: [number, number];
  deckCount: number;
  isGameOver: boolean;
  lastAskedRank: number | null;
  lastAskingPlayer: number | null;
}> {
  const state = gameStateMap.get(lobbyId);

  if (state) {
    console.log(`[MidnightOnChain] Game state for ${lobbyId}: phase=${state.phase}, turn=${state.currentTurn}`);
    return state;
  }

  // Check setup status to determine initial state
  const p1State = setupStateMap.get(getSetupStateKey(lobbyId, 1));
  const p2State = setupStateMap.get(getSetupStateKey(lobbyId, 2));

  let phase = "dealing";
  if (p1State?.hasDealt && p2State?.hasDealt) {
    phase = "turn_start";  // Frontend expects "turn_start" for cards to be clickable
  }

  const defaultState = {
    phase,
    currentTurn: 1,
    scores: [0, 0] as [number, number],
    handSizes: [7, 7] as [number, number],
    deckCount: 38,
    isGameOver: false,
    lastAskedRank: null,
    lastAskingPlayer: null,
  };

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
  console.log(`[MidnightOnChain] Cleared state for lobby ${lobbyId}`);
}

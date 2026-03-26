/**
 * Midnight On-Chain Integration Service
 *
 * In batcher mode, game state is tracked locally because the contract's ledger()
 * function returns an empty object and parsing raw indexer state requires
 * understanding the compact serialization format.
 *
 * setupStateMap is persisted to disk to survive node restarts.
 * Game phase is sourced from the real Midnight indexer via the batcher query server.
 */

// Indexer URL for GraphQL queries (informational only — game state is queried via the batcher)
const INDEXER_URL = Deno.env.get("INDEXER_HTTP_URL") || "http://127.0.0.1:8088/api/v3/graphql";

// Batcher query server URL — runs alongside the batcher on a separate port.
// This is the authoritative source for real on-chain game state.
const BATCHER_QUERY_URL = Deno.env.get("BATCHER_QUERY_URL") || "http://127.0.0.1:9997";

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

// Note: gameStateMap was removed. Game phase is now sourced from the real Midnight
// indexer via the batcher query server (POST /query-game-state). The backend no
// longer maintains an optimistic local simulation for game-phase state.

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
 * Check if a game exists (based on setup state tracking)
 */
export async function queryGameExists(lobbyId: string): Promise<boolean> {
  const key1 = getSetupStateKey(lobbyId, 1);
  const key2 = getSetupStateKey(lobbyId, 2);
  return setupStateMap.has(key1) || setupStateMap.has(key2);
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
 * Map numeric phase from the Midnight contract to the string used by the backend/frontend.
 * Mirrors the mapping in midnight-query.ts.
 */
function mapPhaseNumberToString(phase: number): GamePhase {
  switch (phase) {
    case 0: return "dealing";
    case 1: return "turn_start";
    case 2: return "wait_response";
    case 3: return "wait_transfer";
    case 4: return "wait_draw";
    case 5: return "wait_draw_check";
    case 6: return "finished";
    default: return "dealing";
  }
}

/**
 * Query real on-chain game state from the batcher query server.
 *
 * The batcher's POST /query-game-state endpoint runs the public Midnight impure
 * circuits (getGamePhase, getCurrentTurn, getScores, etc.) against the real
 * Midnight indexer. This is authoritative — it reflects actual blockchain state,
 * not an optimistic local simulation.
 *
 * Falls back to setup-map heuristics if the batcher query server is unavailable
 * (e.g., USE_TYPESCRIPT_CONTRACT=true in dev mode).
 */
export async function queryOnChainGameState(lobbyId: string): Promise<GameState> {
  try {
    const response = await fetch(`${BATCHER_QUERY_URL}/query-game-state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lobbyId }),
    });

    if (!response.ok) {
      throw new Error(`Batcher query server returned ${response.status}`);
    }

    const data = await response.json() as {
      exists: boolean;
      phase?: number;
      currentTurn?: number;
      scores?: [number, number];
      handSizes?: [number, number];
      deckCount?: number;
      isGameOver?: boolean;
      lastAskedRank?: number | null;
      lastAskingPlayer?: number | null;
    };

    if (!data.exists) {
      // Game not yet on-chain — derive phase from setup status
      const p1State = setupStateMap.get(getSetupStateKey(lobbyId, 1));
      const p2State = setupStateMap.get(getSetupStateKey(lobbyId, 2));
      const phase: GamePhase = (p1State?.hasDealt && p2State?.hasDealt) ? "turn_start" : "dealing";
      console.log(`[MidnightOnChain] queryOnChainGameState(${lobbyId}): game not on chain yet, phase=${phase}`);
      return { ...DEFAULT_GAME_STATE, phase };
    }

    const phaseStr = mapPhaseNumberToString(data.phase ?? 0);
    const currentTurn = data.currentTurn ?? 1;
    const state: GameState = {
      phase: phaseStr,
      currentTurn: isValidPlayerId(currentTurn) ? currentTurn : 1,
      scores: data.scores ?? [0, 0],
      handSizes: data.handSizes ?? [7, 7],
      deckCount: data.deckCount ?? 38,
      isGameOver: data.isGameOver ?? false,
      lastAskedRank: data.lastAskedRank ?? null,
      lastAskingPlayer: data.lastAskingPlayer ?? null,
    };

    console.log(`[MidnightOnChain] queryOnChainGameState(${lobbyId}): phase=${state.phase}, turn=${state.currentTurn} [from chain]`);
    return state;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[MidnightOnChain] queryOnChainGameState(${lobbyId}): batcher query failed (${msg}), falling back to local state`);

    // Fallback: derive phase from setup status (for mock/dev mode where batcher isn't running)
    const p1State = setupStateMap.get(getSetupStateKey(lobbyId, 1));
    const p2State = setupStateMap.get(getSetupStateKey(lobbyId, 2));
    const phase: GamePhase = (p1State?.hasDealt && p2State?.hasDealt) ? "turn_start" : "dealing";
    return { ...DEFAULT_GAME_STATE, phase };
  }
}

/**
 * Query mask/deal status directly from the batcher's on-chain state.
 * Returns null if the game doesn't exist on-chain yet or the query fails.
 * Used by setup_status endpoint to detect states missed by notify_setup.
 */
export async function queryOnChainSetupStatuses(lobbyId: string): Promise<{
  maskApplied: [boolean, boolean];
  hasDealt: [boolean, boolean];
} | null> {
  try {
    const response = await fetch(`${BATCHER_QUERY_URL}/query-game-state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lobbyId }),
    });
    if (!response.ok) {
      console.warn(`[MidnightOnChain] queryOnChainSetupStatuses: batcher returned ${response.status} for lobby=${lobbyId}`);
      return null;
    }
    const data = await response.json() as {
      exists: boolean;
      maskApplied?: [boolean, boolean];
      hasDealt?: [boolean, boolean];
    };
    console.log(`[MidnightOnChain] queryOnChainSetupStatuses lobby=${lobbyId} raw=`, JSON.stringify(data));
    if (!data.exists || !data.maskApplied) return null;
    return {
      maskApplied: data.maskApplied,
      hasDealt: data.hasDealt ?? [false, false],
    };
  } catch (err) {
    console.warn(`[MidnightOnChain] queryOnChainSetupStatuses: fetch threw for lobby=${lobbyId}:`, err);
    return null;
  }
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
  persistSetupState();
  console.log("[MidnightOnChain] Cleared all local state");
}

/**
 * Clear state for a specific lobby
 */
export function clearLobbyState(lobbyId: string): void {
  setupStateMap.delete(getSetupStateKey(lobbyId, 1));
  setupStateMap.delete(getSetupStateKey(lobbyId, 2));
  persistSetupState();
  console.log(`[MidnightOnChain] Cleared state for lobby ${lobbyId}`);
}

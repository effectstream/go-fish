/**
 * Midnight Service - Abstraction Layer
 *
 * This service routes Midnight contract calls to either:
 * 1. Backend API (for USE_TYPESCRIPT_CONTRACT=true mode - local TypeScript contract)
 * 2. On-chain service (for production mode - real Midnight blockchain via Lace wallet)
 *
 * This maintains backwards compatibility while enabling real on-chain integration.
 *
 * Architecture:
 * - USE_TYPESCRIPT_CONTRACT=true (mock mode):
 *   - All calls go through backend API
 *   - Backend runs local TypeScript-compiled contract
 *   - Only EVM wallet required
 *
 * - USE_TYPESCRIPT_CONTRACT=false (production mode):
 *   - Write operations go through frontend → Lace wallet → chain
 *   - Read operations (queries) still go through backend → indexer
 *   - Both EVM and Lace wallets required
 */

import MidnightOnChainService, { isOnChainReady, initializeOnChainService, isBatcherMode } from "./MidnightOnChainService";
import * as GoFishContractService from "./GoFishContractService";
import { isBatcherModeEnabled } from "../proving/batcher-providers";

import { API_BASE_URL } from "../apiConfig";

// Backend API base URL
const BACKEND_URL = API_BASE_URL;

// App configuration (loaded from backend)
interface AppConfig {
  useMockedMidnight: boolean;
  requiresLaceWallet: boolean;
  requiresEvmWallet: boolean;
}

let appConfig: AppConfig = {
  useMockedMidnight: false,  // Default to production mode
  requiresLaceWallet: true,
  requiresEvmWallet: true,
};

let configLoaded = false;
let onChainInitialized = false;

/**
 * Load app configuration from backend
 */
export async function loadConfig(): Promise<AppConfig> {
  if (configLoaded) {
    return appConfig;
  }

  // /api/config endpoint removed — use hardcoded defaults.
  // The frontend reads contract state directly from the Midnight indexer,
  // so no backend config is needed.

  configLoaded = true;
  return appConfig;
}

/**
 * Check if we're using the mocked (local TypeScript) contract
 */
export function isUsingMockedContract(): boolean {
  return appConfig.useMockedMidnight;
}

/**
 * Get the current app configuration
 */
export function getConfig(): AppConfig {
  return { ...appConfig };
}

/**
 * Initialize the Midnight service.
 * In production mode, this initializes the on-chain service using the
 * in-browser wallet + batcher (no Lace extension required).
 */
export async function initialize(): Promise<boolean> {
  await loadConfig();

  if (!appConfig.useMockedMidnight) {
    console.log("[MidnightService] Initializing on-chain mode (in-browser wallet + batcher)...");
    onChainInitialized = await initializeOnChainService();
    if (!onChainInitialized) {
      console.warn("[MidnightService] On-chain service not ready - will fall back to backend for now");
    } else {
      console.log("[MidnightService] On-chain mode active");
    }
  } else {
    // Mock mode - backend handles everything
    console.log("[MidnightService] Using mocked (local) contract mode via backend");
  }

  return true;
}

/**
 * Check if on-chain mode is active
 * Returns true if we're in production mode AND the on-chain service is ready
 */
export function isOnChainModeActive(): boolean {
  const active = !appConfig.useMockedMidnight && onChainInitialized && isOnChainReady();
  if (!active) {
    console.log("[MidnightService] isOnChainModeActive=false because:", {
      useMockedMidnight: appConfig.useMockedMidnight,
      onChainInitialized,
      isOnChainReady: isOnChainReady(),
    });
  }
  return active;
}

/**
 * Try to initialize on-chain service.
 * With the in-browser wallet, this always proceeds (no Lace required).
 */
export async function tryInitializeOnChain(): Promise<boolean> {
  if (appConfig.useMockedMidnight) {
    console.log("[MidnightService] Mock mode - skipping on-chain initialization");
    return false;
  }

  if (onChainInitialized) {
    return true;
  }

  console.log("[MidnightService] Attempting on-chain initialization (in-browser wallet + batcher)...");
  try {
    onChainInitialized = await initializeOnChainService();
    console.log("[MidnightService] On-chain initialization result:", onChainInitialized, "isOnChainReady:", isOnChainReady());
    return onChainInitialized;
  } catch (error) {
    console.error("[MidnightService] On-chain initialization failed:", error);
    return false;
  }
}

// ============================================================================
// Contract Actions - Route to on-chain or backend based on configuration
// ============================================================================

/**
 * Returns true if write operations should go to MidnightOnChainService.
 * This covers both Lace wallet mode (isOnChainModeActive) and batcher mode
 * (isBatcherModeEnabled), since MidnightOnChainService handles both paths
 * internally via its batcherModeActive flag.
 *
 * When batcher mode is enabled but the service hasn't been initialized yet,
 * this triggers a lazy initialization so batcherModeActive is set before
 * any action method is called.
 */
async function shouldUseOnChainAsync(): Promise<boolean> {
  if (isOnChainModeActive()) return true;
  if (!isBatcherModeEnabled()) return false;
  // Batcher mode: ensure the on-chain service is initialized so that
  // batcherModeActive is set to true inside MidnightOnChainService.
  if (!onChainInitialized) {
    await tryInitializeOnChain();
  }
  return true;
}

/**
 * Apply mask action (setup phase)
 * playerSecretHex: hex-encoded player secret (no 0x prefix) from PlayerKeyManager.
 * Passing it here ensures the backend uses the same secret for setup and hand queries.
 */
export async function applyMask(
  lobbyId: string,
  playerId: 1 | 2,
  playerSecretHex?: string
): Promise<{ success: boolean; errorMessage?: string }> {
  // In production mode with on-chain ready, use on-chain service
  if (await shouldUseOnChainAsync()) {
    console.log("[MidnightService] applyMask via on-chain");
    return MidnightOnChainService.applyMask(lobbyId, playerId);
  }

  // Otherwise fall back to backend
  console.log("[MidnightService] applyMask via backend");
  return callBackendAction("apply_mask", {
    lobby_id: lobbyId,
    player_id: playerId,
    ...(playerSecretHex ? { player_secret: playerSecretHex } : {}),
  });
}

/**
 * Deal cards action (setup phase)
 * playerSecretHex: hex-encoded player secret (no 0x prefix) from PlayerKeyManager.
 * shuffleSeedHex: hex-encoded shuffle seed (no 0x prefix) from PlayerKeyManager.
 * Passing both ensures the backend local simulation matches what was done on-chain.
 */
export async function dealCards(
  lobbyId: string,
  playerId: 1 | 2,
  playerSecretHex?: string,
  shuffleSeedHex?: string
): Promise<{ success: boolean; errorMessage?: string }> {
  if (await shouldUseOnChainAsync()) {
    console.log("[MidnightService] dealCards via on-chain");
    return MidnightOnChainService.dealCards(lobbyId, playerId);
  }

  console.log("[MidnightService] dealCards via backend");
  return callBackendAction("deal_cards", {
    lobby_id: lobbyId,
    player_id: playerId,
    ...(playerSecretHex ? { player_secret: playerSecretHex } : {}),
    ...(shuffleSeedHex ? { shuffle_seed: shuffleSeedHex } : {}),
  });
}

/**
 * Ask for card action
 */
export async function askForCard(
  lobbyId: string,
  playerId: 1 | 2,
  rank: number
): Promise<{ success: boolean; errorMessage?: string }> {
  if (await shouldUseOnChainAsync()) {
    console.log("[MidnightService] askForCard via on-chain");
    return MidnightOnChainService.askForCard(lobbyId, playerId, rank);
  }

  console.log("[MidnightService] askForCard via backend");
  return callBackendAction("ask_for_card", { lobby_id: lobbyId, player_id: playerId, rank });
}

/**
 * Respond to ask action
 */
export async function respondToAsk(
  lobbyId: string,
  playerId: 1 | 2
): Promise<{ success: boolean; hasCards: boolean; cardCount: number; errorMessage?: string }> {
  if (await shouldUseOnChainAsync()) {
    console.log("[MidnightService] respondToAsk via on-chain");
    return MidnightOnChainService.respondToAsk(lobbyId, playerId);
  }

  console.log("[MidnightService] respondToAsk via backend");
  const result = await callBackendAction("respond_to_ask", { lobby_id: lobbyId, player_id: playerId }) as {
    success: boolean;
    errorMessage?: string;
    hasCards?: boolean;
    cardCount?: number;
  };
  return {
    success: result.success,
    errorMessage: result.errorMessage,
    hasCards: result.hasCards ?? false,
    cardCount: result.cardCount ?? 0,
  };
}

// goFish() deleted — no goFish circuit exists. respondToAsk handles the
// draw internally; the turn flow is: askForCard → respondToAsk → afterGoFish.

/**
 * After Go Fish action — contract v3 determines drewRequestedCard internally
 * by decrypting the drawn card point (game.compact:451-510). No client-side
 * hand diffing needed.
 */
export async function afterGoFish(
  lobbyId: string,
  playerId: 1 | 2,
): Promise<{ success: boolean; errorMessage?: string }> {
  if (await shouldUseOnChainAsync()) {
    console.log("[MidnightService] afterGoFish via on-chain");
    return MidnightOnChainService.afterGoFish(lobbyId, playerId);
  }

  console.log("[MidnightService] afterGoFish via backend");
  return callBackendAction("after_go_fish", {
    lobby_id: lobbyId,
    player_id: playerId,
  });
}

/**
 * Score a book (3 cards of the same rank). Call after any hand-changing
 * action when the player holds ≥3 of a rank. The contract removes the 3
 * cards, increments the score, and checks the early-win threshold (≥4).
 */
export async function checkAndScoreBook(
  lobbyId: string,
  playerId: 1 | 2,
  targetRank: number,
): Promise<{ success: boolean; scored: boolean; errorMessage?: string }> {
  if (await shouldUseOnChainAsync()) {
    console.log(`[MidnightService] checkAndScoreBook(P${playerId}, rank=${targetRank}) via on-chain`);
    return MidnightOnChainService.checkAndScoreBook(lobbyId, playerId, targetRank);
  }

  console.log(`[MidnightService] checkAndScoreBook via backend`);
  const result = await callBackendAction("check_and_score_book", {
    lobby_id: lobbyId,
    player_id: playerId,
    target_rank: targetRank,
  });
  return { ...result, scored: result.success };
}

/**
 * Claim a win because the active player has not moved within the timeout window.
 * Can only be called by the waiting player (the one whose turn it is NOT).
 */
export async function claimTimeoutWin(
  lobbyId: string,
  claimingPlayerId: 1 | 2
): Promise<{ success: boolean; errorMessage?: string }> {
  if (await shouldUseOnChainAsync()) {
    console.log("[MidnightService] claimTimeoutWin via on-chain");
    return MidnightOnChainService.claimTimeoutWin(lobbyId, claimingPlayerId);
  }

  console.log("[MidnightService] claimTimeoutWin via backend");
  return callBackendAction("claim_timeout_win", { lobby_id: lobbyId, player_id: claimingPlayerId });
}

/**
 * Skip draw when deck is empty
 */
export async function skipDrawDeckEmpty(
  lobbyId: string,
  playerId: 1 | 2
): Promise<{ success: boolean; errorMessage?: string }> {
  if (await shouldUseOnChainAsync()) {
    console.log("[MidnightService] skipDrawDeckEmpty via on-chain");
    return MidnightOnChainService.skipDrawDeckEmpty(lobbyId, playerId);
  }

  console.log("[MidnightService] skipDrawDeckEmpty via backend");
  return callBackendAction("skip_draw_deck_empty", { lobby_id: lobbyId, player_id: playerId });
}

// ============================================================================
// Query Operations - Always go through backend
// The backend queries the indexer in production mode or local contract in mock mode
// ============================================================================

/**
 * Get player's hand (mock/batcher mode — returns approximate hand, may not match on-chain state)
 */
export async function getPlayerHand(
  lobbyId: string,
  playerId: 1 | 2
): Promise<Array<{ rank: number; suit: number }>> {
  try {
    const response = await fetch(
      `${BACKEND_URL}/api/midnight/player_hand?lobby_id=${lobbyId}&player_id=${playerId}`
    );
    if (response.ok) {
      const data = await response.json();
      return data.hand || [];
    }
  } catch (error) {
    console.error("[MidnightService] Failed to get player hand:", error);
  }
  return [];
}

/**
 * Get player's real on-chain hand by supplying the player secret.
 * In batcher mode the backend lacks player secrets, so the frontend must pass
 * its locally-stored secret (from PlayerKeyManager) to get the real hand.
 */
export async function getPlayerHandWithSecret(
  lobbyId: string,
  playerId: 1 | 2,
  playerSecretHex: string,
  options?: {
    shuffleSeedHex?: string;
    opponentSecretHex?: string;
    opponentShuffleSeedHex?: string;
  }
): Promise<Array<{ rank: number; suit: number }>> {
  try {
    const body: Record<string, unknown> = {
      lobby_id: lobbyId,
      player_id: playerId,
      player_secret: playerSecretHex,
    };
    if (options?.shuffleSeedHex) body.shuffle_seed = options.shuffleSeedHex;
    if (options?.opponentSecretHex) body.opponent_secret = options.opponentSecretHex;
    if (options?.opponentShuffleSeedHex) body.opponent_shuffle_seed = options.opponentShuffleSeedHex;

    const response = await fetch(`${BACKEND_URL}/api/midnight/player_hand_with_secret`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.ok) {
      const data = await response.json();
      return data.hand || [];
    }
    console.error("[MidnightService] getPlayerHandWithSecret bad response:", response.status);
  } catch (error) {
    console.error("[MidnightService] Failed to get player hand with secret:", error);
  }
  return [];
}

/**
 * Get setup status by reading directly from the Midnight contract ledger
 * state via the indexer. No backend API calls — all reads use
 * GoFishContractService.queryBoolCircuit which evaluates the contract's
 * exported read circuits (hasMaskApplied, hasDealt) against the indexer's
 * current ContractState.
 *
 * Matches the e2e reference at e2e/smoke/_helpers.ts (readCircuit pattern).
 */
export async function getSetupStatus(
  lobbyId: string,
  playerId: 1 | 2
): Promise<{
  hasMaskApplied: boolean;
  hasDealt: boolean;
  opponentHasMaskApplied: boolean;
  opponentHasDealt: boolean;
}> {
  const opponentId: 1 | 2 = playerId === 1 ? 2 : 1;
  const gameId = GoFishContractService.lobbyIdToGameId(lobbyId);

  // Check if game exists on-chain first. Many circuits (hasDealt, etc.)
  // assert game existence and throw if called before applyMask creates it.
  const exists = await GoFishContractService.queryCircuit<boolean>("doesGameExist", gameId);
  if (!exists) {
    // Game not on-chain yet — everything is false
    return { hasMaskApplied: false, hasDealt: false, opponentHasMaskApplied: false, opponentHasDealt: false };
  }

  // Each query does a fresh HTTP call to the indexer (no cache).
  // Run sequentially to avoid indexer overload on parallel requests.
  const myMask = await GoFishContractService.queryBoolCircuit("hasMaskApplied", lobbyId, playerId);
  const oppMask = await GoFishContractService.queryBoolCircuit("hasMaskApplied", lobbyId, opponentId);
  const myDealt = await GoFishContractService.queryBoolCircuit("hasDealt", lobbyId, playerId);
  const oppDealt = await GoFishContractService.queryBoolCircuit("hasDealt", lobbyId, opponentId);

  return {
    hasMaskApplied: myMask,
    hasDealt: myDealt,
    opponentHasMaskApplied: oppMask,
    opponentHasDealt: oppDealt,
  };
}

/** Minimal shape of the game_state API response used by the frontend. */
export interface GameStateResponse {
  lobbyId: string;
  phase: string;
  currentTurn: number;
  scores: [number, number];
  handSizes: [number, number];
  deckCount: number;
  isGameOver: boolean;
  playerId: number;
  players: Array<{ accountId: number; name: string; walletAddress: string }>;
  myHand: Array<{ rank: number; suit: number }>;
  myBooks: string[];
  gameLog: string[];
  playerName?: string;
  opponentName?: string;
  [key: string]: unknown; // Allow extra fields without casting to any
}

/**
 * Get game state
 */
/** Map contract phase numbers to frontend phase strings. */
const PHASE_NAMES: Record<number, string> = {
  0: 'dealing',
  1: 'turn_start',
  2: 'wait_response',
  3: 'wait_transfer',
  4: 'wait_draw',
  5: 'wait_draw_check',
  6: 'game_over',
};

/**
 * Read the full game state by combining:
 *   - Midnight contract reads (phase, scores, handSizes, currentTurn,
 *     isGameOver) via GoFishContractService.queryGameState — directly
 *     from the indexer, no backend API
 *   - Lobby metadata (players, playerId) from the Paima REST endpoint
 *     /lobby_state — the only backend read, for player names/wallets
 *
 * Falls back to the backend's /game_state if the contract game doesn't
 * exist yet (still in EVM-only lobby phase before applyMask creates the
 * Midnight game).
 */
export async function getGameState(
  lobbyId: string,
  wallet: string
): Promise<GameStateResponse | null> {
  // Try reading game state directly from the Midnight contract
  const contractState = await GoFishContractService.queryGameState(lobbyId);
  if (contractState) {
    console.log(`[MidnightService] getGameState: contract phase=${contractState.phase} turn=${contractState.currentTurn} hands=${contractState.handSizes} scores=${contractState.scores}`);
  } else {
    console.log(`[MidnightService] getGameState: contract returned null (game not on-chain yet)`);
  }

  // Get lobby metadata (players, playerId) from the Paima REST API
  let players: GameStateResponse['players'] = [];
  let playerId = 1;
  let playerName: string | undefined;
  let opponentName: string | undefined;

  try {
    const lobbyRes = await fetch(`${BACKEND_URL}/lobby_state?lobby_id=${lobbyId}`);
    if (lobbyRes.ok) {
      const lobby = await lobbyRes.json();
      players = (lobby.players ?? []).map((p: any, i: number) => ({
        accountId: p.account_id,
        name: p.player_name,
        walletAddress: p.wallet_address,
      }));

      // Determine which player we are by wallet address
      const myIndex = players.findIndex(
        (p) => p.walletAddress.toLowerCase() === wallet.toLowerCase()
      );
      playerId = myIndex >= 0 ? myIndex + 1 : 1;
      playerName = players[playerId - 1]?.name;
      opponentName = players[playerId === 1 ? 1 : 0]?.name;
    }
  } catch { /* best-effort */ }

  if (contractState) {
    return {
      lobbyId,
      phase: PHASE_NAMES[contractState.phase] ?? 'dealing',
      currentTurn: contractState.currentTurn,
      scores: contractState.scores,
      handSizes: contractState.handSizes,
      deckCount: contractState.deckCount,
      isGameOver: contractState.isGameOver,
      playerId,
      players,
      myHand: [],
      myBooks: [],
      gameLog: [],
      playerName,
      opponentName,
    };
  }

  // Game doesn't exist on-chain yet (still in EVM dealing phase).
  // Fall back to the backend for a basic 'dealing' response.
  try {
    const response = await fetch(`${BACKEND_URL}/game_state?lobby_id=${lobbyId}&wallet=${wallet}`);
    if (response.ok) {
      return await response.json();
    }
  } catch { /* fall through */ }

  // Last resort: synthetic dealing state from lobby info
  return {
    lobbyId,
    phase: 'dealing',
    currentTurn: 1,
    scores: [0, 0],
    handSizes: [0, 0],
    deckCount: 21,
    isGameOver: false,
    playerId,
    players,
    myHand: [],
    myBooks: [],
    gameLog: [],
    playerName,
    opponentName,
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Call a backend action endpoint
 */
async function callBackendAction(
  action: string,
  body: Record<string, unknown>
): Promise<{ success: boolean; errorMessage?: string }> {
  try {
    const response = await fetch(`${BACKEND_URL}/api/midnight/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const result = await response.json();
    return result;
  } catch (error: unknown) {
    console.error(`[MidnightService] ${action} failed:`, error);
    return { success: false, errorMessage: error instanceof Error ? error.message : "Request failed" };
  }
}

// Export service
export const MidnightService = {
  loadConfig,
  initialize,
  isUsingMockedContract,
  getConfig,
  isOnChainModeActive,
  tryInitializeOnChain,
  // Actions
  applyMask,
  dealCards,
  askForCard,
  respondToAsk,
  afterGoFish,
  checkAndScoreBook,
  skipDrawDeckEmpty,
  claimTimeoutWin,
  // Queries
  getPlayerHand,
  getPlayerHandWithSecret,
  getSetupStatus,
  getGameState,
};

export default MidnightService;

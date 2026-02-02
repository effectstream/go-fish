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

import MidnightOnChainService, { isOnChainReady, initializeOnChainService } from "./MidnightOnChainService";
import { isLaceConnected } from "../laceWalletBridge";

// Backend API base URL
const BACKEND_URL = "http://localhost:9999";

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

  try {
    const response = await fetch(`${BACKEND_URL}/api/config`);
    if (response.ok) {
      appConfig = await response.json();
      console.log("[MidnightService] Config loaded:", appConfig);
    }
  } catch (error) {
    console.warn("[MidnightService] Failed to load config, using defaults:", error);
  }

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
 * Initialize the Midnight service
 * In production mode, this initializes the on-chain service
 */
export async function initialize(): Promise<boolean> {
  await loadConfig();

  if (!appConfig.useMockedMidnight) {
    // Production mode - try to initialize on-chain service if Lace is connected
    if (isLaceConnected()) {
      console.log("[MidnightService] Initializing on-chain mode...");
      onChainInitialized = await initializeOnChainService();
      if (!onChainInitialized) {
        console.warn("[MidnightService] On-chain service not ready - will fall back to backend for now");
      } else {
        console.log("[MidnightService] On-chain mode active");
      }
    } else {
      console.log("[MidnightService] Lace wallet not connected yet - on-chain service will initialize when connected");
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
 * Try to initialize on-chain service (call after Lace wallet connects)
 */
export async function tryInitializeOnChain(): Promise<boolean> {
  if (appConfig.useMockedMidnight) {
    console.log("[MidnightService] Mock mode - skipping on-chain initialization");
    return false;
  }

  if (onChainInitialized) {
    return true;
  }

  if (!isLaceConnected()) {
    console.warn("[MidnightService] Cannot initialize on-chain - Lace wallet not connected");
    return false;
  }

  console.log("[MidnightService] Attempting on-chain initialization...");
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
 * Apply mask action (setup phase)
 */
export async function applyMask(
  lobbyId: string,
  playerId: 1 | 2
): Promise<{ success: boolean; errorMessage?: string }> {
  // In production mode with on-chain ready, use on-chain service
  if (isOnChainModeActive()) {
    console.log("[MidnightService] applyMask via on-chain");
    return MidnightOnChainService.applyMask(lobbyId, playerId);
  }

  // Otherwise fall back to backend
  console.log("[MidnightService] applyMask via backend");
  return callBackendAction("apply_mask", { lobby_id: lobbyId, player_id: playerId });
}

/**
 * Deal cards action (setup phase)
 */
export async function dealCards(
  lobbyId: string,
  playerId: 1 | 2
): Promise<{ success: boolean; errorMessage?: string }> {
  if (isOnChainModeActive()) {
    console.log("[MidnightService] dealCards via on-chain");
    return MidnightOnChainService.dealCards(lobbyId, playerId);
  }

  console.log("[MidnightService] dealCards via backend");
  return callBackendAction("deal_cards", { lobby_id: lobbyId, player_id: playerId });
}

/**
 * Ask for card action
 */
export async function askForCard(
  lobbyId: string,
  playerId: 1 | 2,
  rank: number
): Promise<{ success: boolean; errorMessage?: string }> {
  if (isOnChainModeActive()) {
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
  if (isOnChainModeActive()) {
    console.log("[MidnightService] respondToAsk via on-chain");
    return MidnightOnChainService.respondToAsk(lobbyId, playerId);
  }

  console.log("[MidnightService] respondToAsk via backend");
  const result = await callBackendAction("respond_to_ask", { lobby_id: lobbyId, player_id: playerId });
  return {
    ...result,
    hasCards: (result as any).hasCards ?? false,
    cardCount: (result as any).cardCount ?? 0,
  };
}

/**
 * Go Fish action
 */
export async function goFish(
  lobbyId: string,
  playerId: 1 | 2
): Promise<{ success: boolean; errorMessage?: string }> {
  if (isOnChainModeActive()) {
    console.log("[MidnightService] goFish via on-chain");
    return MidnightOnChainService.goFish(lobbyId, playerId);
  }

  console.log("[MidnightService] goFish via backend");
  return callBackendAction("go_fish", { lobby_id: lobbyId, player_id: playerId });
}

/**
 * After Go Fish action
 */
export async function afterGoFish(
  lobbyId: string,
  playerId: 1 | 2,
  drewRequestedCard: boolean
): Promise<{ success: boolean; errorMessage?: string }> {
  if (isOnChainModeActive()) {
    console.log("[MidnightService] afterGoFish via on-chain");
    return MidnightOnChainService.afterGoFish(lobbyId, playerId, drewRequestedCard);
  }

  console.log("[MidnightService] afterGoFish via backend");
  return callBackendAction("after_go_fish", {
    lobby_id: lobbyId,
    player_id: playerId,
    drew_requested_card: drewRequestedCard,
  });
}

/**
 * Skip draw when deck is empty
 */
export async function skipDrawDeckEmpty(
  lobbyId: string,
  playerId: 1 | 2
): Promise<{ success: boolean; errorMessage?: string }> {
  if (isOnChainModeActive()) {
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
 * Get player's hand
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
 * Get setup status
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
  try {
    const response = await fetch(
      `${BACKEND_URL}/api/midnight/setup_status?lobby_id=${lobbyId}&player_id=${playerId}`
    );
    if (response.ok) {
      return await response.json();
    }
  } catch (error) {
    console.error("[MidnightService] Failed to get setup status:", error);
  }
  return {
    hasMaskApplied: false,
    hasDealt: false,
    opponentHasMaskApplied: false,
    opponentHasDealt: false,
  };
}

/**
 * Get game state
 */
export async function getGameState(
  lobbyId: string,
  wallet: string
): Promise<any> {
  try {
    const response = await fetch(`${BACKEND_URL}/game_state?lobby_id=${lobbyId}&wallet=${wallet}`);
    if (response.ok) {
      return await response.json();
    }
  } catch (error) {
    console.error("[MidnightService] Failed to get game state:", error);
  }
  return null;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Call a backend action endpoint
 */
async function callBackendAction(
  action: string,
  body: Record<string, any>
): Promise<{ success: boolean; errorMessage?: string }> {
  try {
    const response = await fetch(`${BACKEND_URL}/api/midnight/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const result = await response.json();
    return result;
  } catch (error: any) {
    console.error(`[MidnightService] ${action} failed:`, error);
    return { success: false, errorMessage: error.message || "Request failed" };
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
  goFish,
  afterGoFish,
  skipDrawDeckEmpty,
  // Queries
  getPlayerHand,
  getSetupStatus,
  getGameState,
};

export default MidnightService;

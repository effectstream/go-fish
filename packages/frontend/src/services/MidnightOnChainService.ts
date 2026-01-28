/**
 * Midnight On-Chain Service
 *
 * This service handles on-chain contract interactions for Go Fish game.
 * It follows the same pattern as effectstream-midnight for proper ZK integration.
 *
 * Architecture:
 * - Connects to deployed contract via findDeployedContract
 * - Uses Lace wallet for transaction signing (balanceTx, submitTx)
 * - Uses indexer for public state queries
 * - Uses proof server for ZK proof generation
 *
 * Transaction flow: callTx → proof server → balanceTx (wallet) → submitTx (wallet)
 *
 * NOTE: Full on-chain integration requires Midnight SDK packages to be properly
 * configured. For now, this module provides the interface but defers to the backend.
 * When Midnight infrastructure is running, this can be enabled by uncommenting
 * the SDK imports and provider setup.
 */

import { getConnectedAPI, isLaceConnected } from "../laceWalletBridge";

// Configuration - matches local Midnight infrastructure
// These will be used when full SDK integration is enabled
const _BASE_URL_MIDNIGHT_INDEXER = "http://127.0.0.1:8088";
const _BASE_URL_PROOF_SERVER = "http://127.0.0.1:6300";
const _BASE_URL_MIDNIGHT_INDEXER_API = `${_BASE_URL_MIDNIGHT_INDEXER}/api/v3/graphql`;

// Service state
let contractAddress: string | null = null;
let isInitialized = false;

/**
 * Load contract address from backend config or deployment file
 */
async function loadContractAddress(): Promise<string | null> {
  // First try to get from backend config
  try {
    const response = await fetch("http://localhost:9999/api/midnight/contract_address");
    if (response.ok) {
      const data = await response.json();
      if (data.contractAddress) {
        console.log("[MidnightOnChain] Got contract address from backend");
        return data.contractAddress;
      }
    }
  } catch (error) {
    console.warn("[MidnightOnChain] Could not fetch contract address from backend:", error);
  }

  // Fall back to static deployment file
  try {
    const response = await fetch("/contract_address/contract-go-fish.undeployed.json");
    if (response.ok) {
      const data = await response.json();
      if (data.contractAddress) {
        console.log("[MidnightOnChain] Got contract address from static file");
        return data.contractAddress;
      }
    }
  } catch (error) {
    console.warn("[MidnightOnChain] Could not load contract address from static file:", error);
  }

  return null;
}

/**
 * Initialize the on-chain service
 *
 * NOTE: Full SDK integration is deferred until Midnight infrastructure is running.
 * This sets up the basic configuration but doesn't connect to the chain yet.
 */
export async function initializeOnChainService(): Promise<boolean> {
  if (isInitialized) {
    console.log("[MidnightOnChain] Already initialized");
    return true;
  }

  if (!isLaceConnected()) {
    console.warn("[MidnightOnChain] Lace wallet not connected");
    return false;
  }

  try {
    console.log("[MidnightOnChain] Initializing on-chain service...");

    const connectedAPI = getConnectedAPI();
    if (!connectedAPI) {
      throw new Error("Lace wallet API not available");
    }

    // Load contract address
    contractAddress = await loadContractAddress();
    if (!contractAddress) {
      console.warn("[MidnightOnChain] No contract address found");
      console.warn("[MidnightOnChain] Deploy the contract first: deno task midnight:deploy");
      // Still mark as initialized - we can function without on-chain by using backend
    }

    // NOTE: Full provider setup requires Midnight SDK packages.
    // For now, we initialize in a "backend-fallback" mode where all operations
    // go through the backend API. When Midnight infrastructure is running and
    // the SDK types are properly configured, this can be updated to use
    // direct on-chain calls via the wallet.
    //
    // TODO: Uncomment when SDK types are properly configured:
    // providers = await initializeProviders(connectedAPI);
    // deployedContract = await joinContract(providers, contractAddress);

    isInitialized = true;
    console.log("[MidnightOnChain] On-chain service initialized (backend-fallback mode)");
    console.log("[MidnightOnChain] Note: Using backend for all operations until Midnight infrastructure is running");
    return true;
  } catch (error) {
    console.error("[MidnightOnChain] Failed to initialize:", error);
    return false;
  }
}

/**
 * Check if on-chain service is ready
 *
 * Returns false for now since we're in backend-fallback mode.
 * When full SDK integration is enabled, this will check if the
 * deployed contract is connected.
 */
export function isOnChainReady(): boolean {
  // Always return false to use backend fallback
  // When SDK is properly configured, change to:
  // return isInitialized && deployedContract !== null && isLaceConnected();
  return false;
}

/**
 * Convert lobbyId to gameId (bytes32)
 * Used when full SDK integration is enabled
 */
function _lobbyIdToGameId(lobbyId: string): Uint8Array {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(lobbyId);
  const gameId = new Uint8Array(32);
  gameId.set(encoded.slice(0, Math.min(32, encoded.length)));
  return gameId;
}

// ============================================================================
// Contract Actions - Stub implementations for backend-fallback mode
// These return errors since we're not doing direct on-chain calls yet
// ============================================================================

/**
 * Apply mask action (setup phase)
 */
export async function onChainApplyMask(
  _lobbyId: string,
  _playerId: 1 | 2
): Promise<{ success: boolean; errorMessage?: string }> {
  // In backend-fallback mode, this should not be called
  return { success: false, errorMessage: "On-chain mode not active - use backend API" };
}

/**
 * Deal cards action (setup phase)
 */
export async function onChainDealCards(
  _lobbyId: string,
  _playerId: 1 | 2
): Promise<{ success: boolean; errorMessage?: string }> {
  return { success: false, errorMessage: "On-chain mode not active - use backend API" };
}

/**
 * Ask for card action
 */
export async function onChainAskForCard(
  _lobbyId: string,
  _playerId: 1 | 2,
  _rank: number
): Promise<{ success: boolean; errorMessage?: string }> {
  return { success: false, errorMessage: "On-chain mode not active - use backend API" };
}

/**
 * Respond to ask action
 */
export async function onChainRespondToAsk(
  _lobbyId: string,
  _playerId: 1 | 2
): Promise<{ success: boolean; hasCards: boolean; cardCount: number; errorMessage?: string }> {
  return { success: false, hasCards: false, cardCount: 0, errorMessage: "On-chain mode not active - use backend API" };
}

/**
 * Go Fish action - draw from deck
 */
export async function onChainGoFish(
  _lobbyId: string,
  _playerId: 1 | 2
): Promise<{ success: boolean; errorMessage?: string }> {
  return { success: false, errorMessage: "On-chain mode not active - use backend API" };
}

/**
 * After Go Fish action - complete the turn
 */
export async function onChainAfterGoFish(
  _lobbyId: string,
  _playerId: 1 | 2,
  _drewRequestedCard: boolean
): Promise<{ success: boolean; errorMessage?: string }> {
  return { success: false, errorMessage: "On-chain mode not active - use backend API" };
}

/**
 * Skip draw when deck is empty
 */
export async function onChainSkipDrawDeckEmpty(
  _lobbyId: string,
  _playerId: 1 | 2
): Promise<{ success: boolean; errorMessage?: string }> {
  return { success: false, errorMessage: "On-chain mode not active - use backend API" };
}

/**
 * Get contract address
 */
export function getContractAddress(): string | null {
  return contractAddress;
}

// Export service
export const MidnightOnChainService = {
  initialize: initializeOnChainService,
  isReady: isOnChainReady,
  getContractAddress,
  // Actions
  applyMask: onChainApplyMask,
  dealCards: onChainDealCards,
  askForCard: onChainAskForCard,
  respondToAsk: onChainRespondToAsk,
  goFish: onChainGoFish,
  afterGoFish: onChainAfterGoFish,
  skipDrawDeckEmpty: onChainSkipDrawDeckEmpty,
};

export default MidnightOnChainService;

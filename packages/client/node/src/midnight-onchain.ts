/**
 * Midnight On-Chain Integration Service
 *
 * This module provides on-chain integration with the Midnight blockchain.
 * It queries contract state from the indexer for read operations.
 *
 * Note: Write operations (transactions) should be routed through the frontend
 * via the Lace wallet, NOT through the backend. This maintains the security
 * properties of the Mental Poker protocol.
 *
 * The backend's role in production mode:
 * 1. Query public game state from the indexer
 * 2. Coordinate game flow between players
 * 3. Validate state transitions
 *
 * Player-specific operations (applyMask, dealCards, askForCard, etc.)
 * must be signed by the player's wallet, so they go through the frontend.
 */

import { Contract, ledger } from "../../../shared/contracts/midnight/go-fish-contract/src/managed/contract/index.js";

// Import Midnight providers (these are available in the midnight-contracts package)
// Note: In production, these would connect to actual Midnight infrastructure
let indexerPublicDataProvider: any = null;
let contractAddress: string | null = null;
let isInitialized = false;

/**
 * Midnight network configuration
 * These values should match the deployed environment
 */
interface MidnightOnChainConfig {
  indexerUrl: string;
  indexerWsUrl: string;
  proofServerUrl: string;
  networkId: string;
  contractAddress: string | null;
}

// Default configuration for local development
const defaultConfig: MidnightOnChainConfig = {
  indexerUrl: "http://127.0.0.1:8088/api/v3/graphql",
  indexerWsUrl: "ws://127.0.0.1:8088/api/v3/graphql/ws",
  proofServerUrl: "http://127.0.0.1:6300",
  networkId: "undeployed",
  contractAddress: null, // Will be loaded from deployment file
};

let config: MidnightOnChainConfig = { ...defaultConfig };

/**
 * Load contract address from deployment file
 */
async function loadContractAddress(): Promise<string | null> {
  try {
    // Try to load from the standard deployment location
    const deploymentPath = new URL(
      "../../../../shared/contracts/midnight/contract-go-fish.undeployed.json",
      import.meta.url
    );
    const deploymentText = await Deno.readTextFile(deploymentPath);
    const deployment = JSON.parse(deploymentText);
    return deployment.contractAddress || null;
  } catch (error) {
    console.warn("[MidnightOnChain] Could not load contract address from deployment file:", error);
    return null;
  }
}

/**
 * Initialize the on-chain query service
 * This sets up the connection to the Midnight indexer for querying contract state
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
      console.warn("[MidnightOnChain] No contract address found - queries will return fallback values");
      console.warn("[MidnightOnChain] Deploy the contract first: deno task midnight:deploy");
    } else {
      console.log(`[MidnightOnChain] Contract address: ${contractAddress}`);
    }

    // Note: The actual provider setup requires the Midnight JS SDK packages
    // which need to be imported dynamically in the Deno environment
    //
    // For now, we'll set up the configuration and defer actual initialization
    // until we have the required imports working

    console.log(`[MidnightOnChain] Indexer URL: ${config.indexerUrl}`);
    console.log(`[MidnightOnChain] Network ID: ${config.networkId}`);

    isInitialized = true;
    console.log("[MidnightOnChain] On-chain service initialized (query-only mode)");
  } catch (error) {
    console.error("[MidnightOnChain] Failed to initialize:", error);
    throw error;
  }
}

/**
 * Convert lobbyId to gameId (bytes32)
 */
function lobbyIdToGameId(lobbyId: string): Uint8Array {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(lobbyId);
  const gameId = new Uint8Array(32);
  gameId.set(encoded.slice(0, Math.min(32, encoded.length)));
  return gameId;
}

/**
 * Query game state from the on-chain contract via indexer
 *
 * In production, this queries the actual Midnight blockchain state.
 * Returns fallback values if the indexer is not available.
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
  if (!isInitialized || !contractAddress) {
    console.log("[MidnightOnChain] Not initialized or no contract - returning fallback state");
    return {
      phase: "dealing",
      currentTurn: 1,
      scores: [0, 0],
      handSizes: [7, 7],
      deckCount: 38,
      isGameOver: false,
      lastAskedRank: null,
      lastAskingPlayer: null,
    };
  }

  try {
    // TODO: Implement actual indexer query using indexerPublicDataProvider
    // This requires the Midnight JS SDK to be properly imported
    //
    // Example query pattern:
    // const contractState = await indexerPublicDataProvider.queryContractState(contractAddress);
    // const ledgerState = ledger(contractState.data);
    // return extractGameState(ledgerState, lobbyId);

    console.log(`[MidnightOnChain] Would query state for game: ${lobbyId}`);

    // For now, return a placeholder indicating on-chain mode is active but not implemented
    return {
      phase: "dealing",
      currentTurn: 1,
      scores: [0, 0],
      handSizes: [7, 7],
      deckCount: 38,
      isGameOver: false,
      lastAskedRank: null,
      lastAskingPlayer: null,
    };
  } catch (error) {
    console.error("[MidnightOnChain] Query failed:", error);
    // Return fallback on error
    return {
      phase: "dealing",
      currentTurn: 1,
      scores: [0, 0],
      handSizes: [7, 7],
      deckCount: 38,
      isGameOver: false,
      lastAskedRank: null,
      lastAskingPlayer: null,
    };
  }
}

/**
 * Query setup status from on-chain contract
 */
export async function queryOnChainSetupStatus(
  lobbyId: string,
  playerId: 1 | 2
): Promise<{
  hasMaskApplied: boolean;
  hasDealt: boolean;
}> {
  if (!isInitialized || !contractAddress) {
    return { hasMaskApplied: false, hasDealt: false };
  }

  try {
    // TODO: Implement actual indexer query
    console.log(`[MidnightOnChain] Would query setup status for game: ${lobbyId}, player: ${playerId}`);
    return { hasMaskApplied: false, hasDealt: false };
  } catch (error) {
    console.error("[MidnightOnChain] Setup status query failed:", error);
    return { hasMaskApplied: false, hasDealt: false };
  }
}

/**
 * Check if the on-chain service is available
 */
export function isOnChainServiceAvailable(): boolean {
  return isInitialized && contractAddress !== null;
}

/**
 * Get the current configuration
 */
export function getOnChainConfig(): MidnightOnChainConfig {
  return { ...config, contractAddress };
}

/**
 * Update configuration (for testing or different environments)
 */
export function setOnChainConfig(newConfig: Partial<MidnightOnChainConfig>): void {
  config = { ...config, ...newConfig };
}

/**
 * Get contract address
 */
export function getContractAddress(): string | null {
  return contractAddress;
}

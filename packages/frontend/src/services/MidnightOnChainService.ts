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
 */

import { getConnectedAPI, isLaceConnected } from "../laceWalletBridge";
import { isBatcherModeEnabled } from "../proving/batcher-providers";
import * as BatcherMidnightService from "./BatcherMidnightService";

// Import Midnight SDK packages (v3 with ledger-v7)
import type { ContractAddress } from "@midnight-ntwrk/compact-runtime";
import {
  Transaction,
  type TransactionId,
  type FinalizedTransaction,
  type CoinPublicKey,
  type EncPublicKey,
} from "@midnight-ntwrk/ledger-v7";
import { setNetworkId, type NetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import {
  type DeployedContract,
  type FoundContract,
  findDeployedContract,
  deployContract,
} from "@midnight-ntwrk/midnight-js-contracts";
import { httpClientProofProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { FetchZkConfigProvider } from "@midnight-ntwrk/midnight-js-fetch-zk-config-provider";
import { getBrowserProofProvider } from "./midnightBrowserProofProvider";
import { levelPrivateStateProvider } from "@midnight-ntwrk/midnight-js-level-private-state-provider";
import { assertIsContractAddress, fromHex, toHex } from "@midnight-ntwrk/midnight-js-utils";
import type {
  MidnightProviders,
  UnboundTransaction,
} from "@midnight-ntwrk/midnight-js-types";
import type { Contract, ImpureCircuitId } from "@midnight-ntwrk/compact-js";
import type { DAppConnectorWalletAPI } from "@midnight-ntwrk/dapp-connector-api";

// Custom type for the connected wallet API (combines DAppConnectorWalletAPI with shielded address access)
interface ConnectedAPI extends DAppConnectorWalletAPI {
  getShieldedAddresses(): Promise<{
    shieldedAddress: string;
    shieldedCoinPublicKey: string;
    shieldedEncryptionPublicKey: string;
  }>;
  balanceUnsealedTransaction(tx: string): Promise<{ tx: string }>;
}

// Import the contract - path needs to be resolved at runtime
// For now, we'll type it manually since the contract may not be available as npm package
type GoFishWitnesses = {
  getFieldInverse: any;
  player_secret_key: any;
  shuffle_seed: any;
  get_sorted_deck_witness: any;
};

type PrivateState = Record<string, never>;

// Configuration - matches local Midnight infrastructure
// Use environment variables if available, otherwise default to GraphQL proxy on port 8089
// The proxy translates SDK v2.0.0 queries to indexer v3 format
const BASE_URL_MIDNIGHT_INDEXER = import.meta.env.VITE_INDEXER_HTTP_URL?.replace(/\/api\/.*$/, '') || "http://127.0.0.1:8089";
const BASE_WS_MIDNIGHT_INDEXER = import.meta.env.VITE_INDEXER_WS_URL?.replace(/\/api\/.*$/, '') || "ws://127.0.0.1:8089";
// When VITE_PROOF_SERVER_URL is set, proving is delegated to that HTTP server.
// When unset (default), proofs run locally in the browser via WASM — the recommended
// production mode since the Lace wallet does not ship with a built-in proof server.
const PROOF_SERVER_URL: string | undefined = import.meta.env.VITE_PROOF_SERVER_URL || undefined;
// Using /api/v1/graphql - the proxy handles translation to v3 if needed
const BASE_URL_MIDNIGHT_INDEXER_API = import.meta.env.VITE_INDEXER_HTTP_URL || `${BASE_URL_MIDNIGHT_INDEXER}/api/v1/graphql`;
const BASE_URL_MIDNIGHT_INDEXER_WS = import.meta.env.VITE_INDEXER_WS_URL || `${BASE_WS_MIDNIGHT_INDEXER}/api/v1/graphql/ws`;

const MIDNIGHT_NETWORK_ID: NetworkId = "undeployed";

console.log(
  PROOF_SERVER_URL
    ? `[MidnightOnChain] Proof mode: HTTP server (${PROOF_SERVER_URL})`
    : "[MidnightOnChain] Proof mode: WASM in-browser (default)"
);

// Backend API URL for notifying state changes
const BACKEND_API_URL = "http://localhost:9996";

/**
 * Notify the backend about a successful setup action
 * This allows the backend to track state for coordination between players
 */
async function notifyBackendSetupComplete(
  lobbyId: string,
  playerId: 1 | 2,
  action: "mask_applied" | "dealt_complete"
): Promise<void> {
  try {
    const response = await fetch(`${BACKEND_API_URL}/api/midnight/notify_setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lobby_id: lobbyId, player_id: playerId, action }),
    });
    if (!response.ok) {
      console.warn(`[MidnightOnChain] Failed to notify backend: ${response.status}`);
    } else {
      console.log(`[MidnightOnChain] Backend notified: ${action} for player ${playerId}`);
    }
  } catch (error) {
    console.warn(`[MidnightOnChain] Could not notify backend:`, error);
  }
}

// Service state
let contractAddressRaw: string | null = null;  // 32-byte address for indexer queries
let contractAddressNormalized: string | null = null;  // 34-byte address for SDK
let isInitialized = false;
let providers: GoFishProviders | null = null;
let deployedContract: DeployedGoFishContract | null = null;
let goFishContractInstance: any = null;
let batcherModeActive = false;

type ContractPrivateStateId = "privateState";

type GoFishContract = Contract<PrivateState, GoFishWitnesses>;

type GoFishCircuits = ImpureCircuitId<GoFishContract>;

export type GoFishProviders = MidnightProviders<
  GoFishCircuits,
  ContractPrivateStateId,
  PrivateState
>;

type DeployedGoFishContract =
  | DeployedContract<GoFishContract>
  | FoundContract<GoFishContract>;

type ShieldedAddresses = Awaited<
  ReturnType<ConnectedAPI["getShieldedAddresses"]>
>;

/**
 * Normalize contract address for SDK compatibility.
 *
 * Different SDK versions may expect different address formats.
 * This function normalizes addresses as needed.
 */
function normalizeContractAddress(address: string): string {
  // Remove any 0x prefix if present
  const cleanAddress = address.startsWith("0x") ? address.slice(2) : address;

  // Expected lengths
  const EXPECTED_BYTES = 34;
  const EXPECTED_HEX_LENGTH = EXPECTED_BYTES * 2; // 68 hex chars

  if (cleanAddress.length === EXPECTED_HEX_LENGTH) {
    // Already correct length
    return cleanAddress;
  }

  if (cleanAddress.length === 64) {
    // 32-byte address from compact-runtime 0.11.0 - pad with 2-byte prefix
    console.log("[MidnightOnChain] Normalizing 32-byte address to 34-byte format");
    return "0000" + cleanAddress;
  }

  console.warn(`[MidnightOnChain] Unexpected contract address length: ${cleanAddress.length} hex chars`);
  return cleanAddress;
}

/**
 * Load contract address from backend config or deployment file
 * Returns both raw (32-byte) and normalized (34-byte) addresses
 */
async function loadContractAddress(): Promise<{ raw: string; normalized: string } | null> {
  // First try to get from backend config
  try {
    const { API_BASE_URL } = await import("../apiConfig");
    const response = await fetch(`${API_BASE_URL}/api/midnight/contract_address`);
    if (response.ok) {
      const data = await response.json();
      if (data.contractAddress) {
        console.log("[MidnightOnChain] Got contract address from backend");
        const raw = data.contractAddress;
        return { raw, normalized: normalizeContractAddress(raw) };
      }
    }
  } catch (error) {
    console.warn("[MidnightOnChain] Could not fetch contract address from backend:", error);
  }

  // Fall back to static deployment file
  try {
    const response = await fetch("/contract_address/go-fish-contract.undeployed.json");
    if (response.ok) {
      const data = await response.json();
      if (data.contractAddress) {
        console.log("[MidnightOnChain] Got contract address from static file");
        const raw = data.contractAddress;
        return { raw, normalized: normalizeContractAddress(raw) };
      }
    }
  } catch (error) {
    console.warn("[MidnightOnChain] Could not load contract address from static file:", error);
  }

  return null;
}

/**
 * Load the contract module dynamically
 */
async function loadContractModule(): Promise<boolean> {
  try {
    const contractModule = await import("../../../shared/contracts/midnight/go-fish-contract/src/_index.ts");
    const { Contract: ContractNamespace, witnesses } = contractModule;
    goFishContractInstance = new ContractNamespace.Contract(witnesses);

    console.log("[MidnightOnChain] Loaded contract module successfully");
    return true;
  } catch (error) {
    console.warn("[MidnightOnChain] Could not load contract module:", error);
    console.warn("[MidnightOnChain] On-chain mode will not be available");
    return false;
  }
}

/**
 * Create wallet and midnight provider from connected wallet API
 * Uses ledger-v7 with SDK v3 types
 */
function createWalletAndMidnightProvider(
  connectedAPI: ConnectedAPI,
  coinPublicKey: string,
  encryptionPublicKey: string,
): {
  getCoinPublicKey: () => CoinPublicKey;
  getEncryptionPublicKey: () => EncPublicKey;
  balanceTx: (tx: UnboundTransaction, ttl?: Date) => Promise<FinalizedTransaction>;
  submitTx: (tx: FinalizedTransaction) => Promise<TransactionId>;
} {
  return {
    getCoinPublicKey(): CoinPublicKey {
      return coinPublicKey as unknown as CoinPublicKey;
    },
    getEncryptionPublicKey(): EncPublicKey {
      return encryptionPublicKey as unknown as EncPublicKey;
    },
    async balanceTx(
      tx: UnboundTransaction,
      _ttl?: Date,
    ): Promise<FinalizedTransaction> {
      try {
        console.log("[MidnightOnChain] Balancing transaction via wallet");
        // Serialize using ledger-v7 (network ID is set globally)
        const serializedTx = toHex((tx as any).serialize());
        const received = await connectedAPI.balanceUnsealedTransaction(serializedTx);
        // Deserialize using ledger-v7 (network ID is set globally)
        const transaction = Transaction.deserialize(fromHex(received.tx));
        return transaction as FinalizedTransaction;
      } catch (e: any) {
        // Extract detailed error info from FiberFailure
        let errorDetails = "Unknown error";
        if (e?.cause) {
          const cause = e.cause;
          if (cause?.error?.message) {
            errorDetails = cause.error.message;
          } else if (cause?.message) {
            errorDetails = cause.message;
          } else if (typeof cause === "string") {
            errorDetails = cause;
          } else {
            errorDetails = JSON.stringify(cause, null, 2);
          }
        } else if (e?.message) {
          errorDetails = e.message;
        }
        console.error("[MidnightOnChain] Error balancing transaction:", errorDetails);
        console.error("[MidnightOnChain] Full error object:", e);
        throw new Error(`Failed to balance transaction: ${errorDetails}`);
      }
    },
    async submitTx(tx: FinalizedTransaction): Promise<TransactionId> {
      // Submit transaction directly - the wallet API handles the serialization
      // Cast to any since FinalizedTransaction from ledger-v7 and Transaction from wallet API
      // are structurally compatible but have different nominal types
      await connectedAPI.submitTransaction(tx as any);
      const txIdentifiers = tx.identifiers();
      const txId = txIdentifiers[0];
      console.log("[MidnightOnChain] Submitted transaction:", txId);
      return txId;
    },
  };
}

/**
 * Initialize providers for the Midnight SDK
 */
async function initializeProviders(
  connectedAPI: ConnectedAPI,
  shieldedAddresses: ShieldedAddresses,
): Promise<GoFishProviders> {
  const { shieldedCoinPublicKey, shieldedEncryptionPublicKey } = shieldedAddresses;

  console.log(`[MidnightOnChain] Connecting with network ID: ${MIDNIGHT_NETWORK_ID}`);
  setNetworkId(MIDNIGHT_NETWORK_ID);

  const walletAndMidnightProvider = createWalletAndMidnightProvider(
    connectedAPI,
    shieldedCoinPublicKey,
    shieldedEncryptionPublicKey,
  );

  const zkConfigProvider = new FetchZkConfigProvider(window.location.origin, fetch.bind(window));

  // Select proof provider based on VITE_PROOF_SERVER_URL:
  //   - Unset (default/production): WASM in-browser proving via @paima/midnight-wasm-prover.
  //     Runs in a Web Worker — no external proof server required.
  //   - Set: delegate to the specified HTTP proof server (dev/fallback).
  const proofProvider = PROOF_SERVER_URL
    ? httpClientProofProvider(PROOF_SERVER_URL, zkConfigProvider)
    : getBrowserProofProvider();

  return {
    privateStateProvider: levelPrivateStateProvider({
      privateStoragePasswordProvider: async () => "PAIMA_STORAGE_PASSWORD",
      accountId: shieldedCoinPublicKey,
    }),
    zkConfigProvider,
    proofProvider,
    publicDataProvider: indexerPublicDataProvider(
      BASE_URL_MIDNIGHT_INDEXER_API,
      BASE_URL_MIDNIGHT_INDEXER_WS,
    ),
    walletProvider: walletAndMidnightProvider,
    midnightProvider: walletAndMidnightProvider,
  };
}

/**
 * Pre-flight check to verify indexer connectivity before attempting findDeployedContract
 */
async function checkIndexerConnectivity(): Promise<boolean> {
  // Check HTTP endpoint
  try {
    console.log(`[MidnightOnChain] Checking indexer HTTP endpoint: ${BASE_URL_MIDNIGHT_INDEXER_API}`);
    const response = await fetch(BASE_URL_MIDNIGHT_INDEXER_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "{ __typename }",
      }),
    });
    if (!response.ok) {
      console.error(`[MidnightOnChain] Indexer HTTP check failed: ${response.status} ${response.statusText}`);
      return false;
    }
    const data = await response.json();
    console.log("[MidnightOnChain] Indexer HTTP endpoint is reachable:", data);
  } catch (error) {
    console.error("[MidnightOnChain] Indexer HTTP endpoint not reachable:", error);
    return false;
  }

  // Note: We skip the WebSocket pre-flight check because browser WebSocket API
  // may not properly support the graphql-ws subprotocol that the indexer uses.
  // The SDK's internal implementation (using graphql-ws package) handles this differently.
  console.log("[MidnightOnChain] Skipping WebSocket pre-flight (SDK handles connection internally)");

  console.log("[MidnightOnChain] Indexer connectivity checks passed");
  return true;
}

/**
 * Deploy a new contract (only used in batcher mode)
 */
async function deployNewContract(
  provs: GoFishProviders,
): Promise<DeployedGoFishContract> {
  if (!goFishContractInstance) {
    throw new Error("Contract module not loaded");
  }

  console.log("[MidnightOnChain] Deploying new contract via batcher...");

  const DEPLOY_TIMEOUT_MS = 120000; // 2 minutes for deployment

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new Error(`Contract deployment timed out after ${DEPLOY_TIMEOUT_MS}ms`));
    }, DEPLOY_TIMEOUT_MS);
  });

  try {
    const deployed = await Promise.race([
      deployContract(provs as any, {
        compiledContract: goFishContractInstance,
        privateStateId: "privateState",
        initialPrivateState: {},
      }),
      timeoutPromise,
    ]);

    console.log(`[MidnightOnChain] Contract deployed at: ${deployed.deployTxData.public.contractAddress}`);
    return deployed as unknown as DeployedGoFishContract;
  } catch (error) {
    console.error("[MidnightOnChain] Contract deployment failed:", error);
    throw error;
  }
}

/**
 * Join an existing deployed contract, or deploy if in batcher mode and contract not found
 *
 * @param provs The providers to use
 * @param rawAddress The raw 32-byte contract address (for indexer queries)
 * @param normalizedAddress The normalized 34-byte contract address (for findDeployedContract)
 */
async function joinContract(
  provs: GoFishProviders,
  rawAddress: string,
  normalizedAddress: string,
): Promise<DeployedGoFishContract> {
  if (!goFishContractInstance) {
    throw new Error("Contract module not loaded");
  }

  console.log(`[MidnightOnChain] Attempting to find deployed contract at: ${rawAddress} (normalized: ${normalizedAddress})`);

  // Pre-flight check - verify indexer is accessible
  const indexerOk = await checkIndexerConnectivity();
  if (!indexerOk) {
    throw new Error("Indexer connectivity check failed - ensure the indexer is running at " + BASE_URL_MIDNIGHT_INDEXER);
  }

  // In batcher/dev mode, always deploy a fresh contract
  // This avoids issues with findDeployedContract hanging when it can't find
  // the original deploy transaction (indexer returns ContractUpdate instead of ContractDeploy)
  if (batcherModeActive) {
    console.log("[MidnightOnChain] Batcher mode active - deploying fresh contract (chain resets each time in dev)");
    try {
      const deployedGoFishContract = await deployContract(provs, {
        compiledContract: goFishContractInstance,
        privateStateId: "privateState",
        initialPrivateState: {},
      });

      const newAddress = deployedGoFishContract.deployTxData.public.contractAddress;
      console.log(`[MidnightOnChain] Contract deployed successfully at address: ${newAddress}`);

      return deployedGoFishContract as DeployedGoFishContract;
    } catch (deployError) {
      console.error("[MidnightOnChain] Contract deployment failed:", deployError);
      throw deployError;
    }
  }

  // For wallet mode, check if contract exists and try to join it
  let contractFoundInIndexer = false;
  try {
    console.log("[MidnightOnChain] Querying indexer for contract existence...");
    const contractQuery = await fetch(BASE_URL_MIDNIGHT_INDEXER_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `query GetContract($address: String!) {
          contractAction(address: $address) {
            address
          }
        }`,
        variables: { address: rawAddress },
      }),
    });
    const contractData = await contractQuery.json();
    console.log("[MidnightOnChain] Contract query result:", JSON.stringify(contractData));

    if (contractData.errors) {
      console.log("[MidnightOnChain] GraphQL query not supported by this indexer version - continuing anyway");
    } else if (!contractData.data?.contractAction) {
      console.warn(`[MidnightOnChain] Contract not found via contractAction query at address ${rawAddress}`);
    } else {
      console.log("[MidnightOnChain] Contract found in indexer!");
      contractFoundInIndexer = true;
    }
  } catch (queryError: any) {
    if (queryError?.message?.includes("Contract not deployed")) {
      throw queryError;
    }
    console.warn("[MidnightOnChain] Could not query contract existence:", queryError);
  }

  // Add timeout to prevent hanging forever
  const TIMEOUT_MS = 30000; // 30 seconds

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new Error(`findDeployedContract timed out after ${TIMEOUT_MS}ms - the indexer is reachable but findDeployedContract is not completing. This may indicate the contract was not found at address ${rawAddress}`));
    }, TIMEOUT_MS);
  });

  try {
    console.log("[MidnightOnChain] Calling findDeployedContract with normalized address...");
    const goFishContract = await Promise.race([
      findDeployedContract(provs, {
        contractAddress: normalizedAddress,
        compiledContract: goFishContractInstance,
        privateStateId: "privateState",
        initialPrivateState: {},
      }),
      timeoutPromise,
    ]);

    console.log(`[MidnightOnChain] Joined contract at address: ${rawAddress}`);
    return goFishContract;
  } catch (error) {
    console.error("[MidnightOnChain] findDeployedContract failed:", error);
    throw error;
  }
}

/**
 * Initialize the on-chain service
 * Supports two modes:
 * 1. Wallet mode (default): Uses Lace wallet for transaction signing
 * 2. Batcher mode: Uses batcher service for transaction submission (no wallet required)
 */
export async function initializeOnChainService(): Promise<boolean> {
  if (isInitialized) {
    console.log("[MidnightOnChain] Already initialized");
    return true;
  }

  // Check if batcher mode is enabled
  batcherModeActive = isBatcherModeEnabled();

  if (batcherModeActive) {
    console.log("[MidnightOnChain] Batcher mode enabled - using BatcherMidnightService");
    console.log("[MidnightOnChain] No Lace wallet required - transactions go through Paima batcher");
    isInitialized = true;
    return true;
  }

  // Wallet mode requires Lace connection
  if (!isLaceConnected()) {
    console.warn("[MidnightOnChain] Lace wallet not connected");
    return false;
  }

  try {
    console.log("[MidnightOnChain] Initializing on-chain service (wallet mode)...");

    const connectedAPI = getConnectedAPI();
    if (!connectedAPI) {
      throw new Error("Lace wallet API not available");
    }

    // Load contract module
    const contractLoaded = await loadContractModule();
    if (!contractLoaded) {
      console.warn("[MidnightOnChain] Contract module not available - running in backend mode");
      isInitialized = true;
      return true;
    }

    // Load contract address
    const addressResult = await loadContractAddress();
    if (!addressResult) {
      console.warn("[MidnightOnChain] No contract address found");
      console.warn("[MidnightOnChain] Deploy the contract first: deno task midnight:deploy");
      isInitialized = true;
      return true;
    }
    contractAddressRaw = addressResult.raw;
    contractAddressNormalized = addressResult.normalized;

    // Get shielded addresses from wallet
    const shieldedAddresses = await connectedAPI.getShieldedAddresses();
    // Initialize wallet-based providers
    providers = await initializeProviders(connectedAPI, shieldedAddresses);
    console.log("[MidnightOnChain] Wallet mode providers initialized");

    // Join the contract
    deployedContract = await joinContract(providers, contractAddressRaw, contractAddressNormalized);
    // Update contract address in case we deployed a new one
    if (deployedContract && (deployedContract as any).deployTxData?.public?.contractAddress) {
      const newAddress = (deployedContract as any).deployTxData.public.contractAddress;
      if (newAddress !== contractAddressRaw) {
        console.log(`[MidnightOnChain] Contract was deployed at new address: ${newAddress}`);
        contractAddressRaw = newAddress;
        contractAddressNormalized = normalizeContractAddress(newAddress);
      }
    }
    console.log("[MidnightOnChain] Contract joined successfully");

    // Initialize static deck if not already done
    // This is a one-time operation needed before any games can be created
    // It submits a transaction to the chain to initialize the deck mappings
    console.log("[MidnightOnChain] Checking if static deck needs initialization...");
    try {
      const callTx = (deployedContract as any).callTx;
      if (callTx && typeof callTx.init_deck === "function") {
        console.log("[MidnightOnChain] Calling init_deck to initialize static deck on-chain...");
        console.log("[MidnightOnChain] This will submit a transaction to the chain and may take a moment...");
        const result = await callTx.init_deck();
        console.log("[MidnightOnChain] init_deck transaction submitted successfully:", result);
      } else {
        console.warn("[MidnightOnChain] init_deck function not found on contract - callTx:", Object.keys(callTx || {}));
      }
    } catch (initError: any) {
      // Extract error message from FiberFailure if present
      let errorMsg = initError?.message || "";
      if (initError?.cause) {
        const cause = initError.cause;
        if (cause?.error?.message) {
          errorMsg = cause.error.message;
        } else if (cause?.message) {
          errorMsg = cause.message;
        } else if (typeof cause === "string") {
          errorMsg = cause;
        }
      }
      if (!errorMsg) {
        errorMsg = String(initError);
      }

      // Check if the error indicates the deck is already initialized
      if (errorMsg.includes("already initialized") || errorMsg.includes("Static deck") || errorMsg.includes("staticDeckInitialized")) {
        console.log("[MidnightOnChain] Static deck appears to already be initialized (this is OK)");
        staticDeckInitialized = true;
      } else {
        // This is a real error - but we'll continue and let applyMask fail with a clearer message
        console.error("[MidnightOnChain] init_deck failed with error:", errorMsg);
        console.error("[MidnightOnChain] Full error object:", initError);
        console.error("[MidnightOnChain] Games may fail until init_deck succeeds");
      }
    }

    isInitialized = true;
    console.log("[MidnightOnChain] On-chain service fully initialized");
    return true;
  } catch (error) {
    console.error("[MidnightOnChain] Failed to initialize:", error);
    // Still mark as initialized so we can use backend fallback
    isInitialized = true;
    return true;
  }
}

/**
 * Check if on-chain service is ready for direct chain calls
 * In batcher mode, just needs to be initialized (no wallet required)
 * In wallet mode, needs deployed contract and Lace connection
 */
export function isOnChainReady(): boolean {
  if (batcherModeActive) {
    return isInitialized;
  }
  return isInitialized && deployedContract !== null && isLaceConnected();
}

/**
 * Check if batcher mode is active
 */
export function isBatcherMode(): boolean {
  return batcherModeActive;
}

/**
 * Get the callTx object from the deployed contract
 */
function getCallTx(): Record<string, (...args: any[]) => Promise<any>> {
  if (!deployedContract) {
    throw new Error("Contract not connected");
  }
  const callTx = (deployedContract as any).callTx;
  if (!callTx || typeof callTx !== "object") {
    throw new Error("Contract callTx is not available");
  }
  return callTx;
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

// Track whether we've successfully initialized the deck in this session
let staticDeckInitialized = false;

// ============================================================================
// Contract Actions - Direct on-chain calls
// ============================================================================

/**
 * Initialize the static deck (must be called once before any games)
 * This is idempotent - calling it multiple times is safe
 */
export async function initializeStaticDeck(): Promise<{ success: boolean; errorMessage?: string }> {
  if (staticDeckInitialized) {
    console.log("[MidnightOnChain] Static deck already initialized in this session");
    return { success: true };
  }

  // In batcher mode, use the batcher service
  if (batcherModeActive) {
    console.log("[MidnightOnChain] Using batcher service for init_deck...");
    const result = await BatcherMidnightService.initDeck();
    if (result.success) {
      staticDeckInitialized = true;
      return { success: true };
    }
    // Check if already initialized (treat as success)
    if (result.error?.includes("already") || result.error?.includes("Static deck")) {
      console.log("[MidnightOnChain] Static deck was already initialized");
      staticDeckInitialized = true;
      return { success: true };
    }
    return { success: false, errorMessage: result.error };
  }

  if (!isOnChainReady()) {
    return { success: false, errorMessage: "On-chain mode not active" };
  }

  try {
    console.log("[MidnightOnChain] Initializing static deck on-chain...");
    const callTx = getCallTx();
    await callTx.init_deck();
    staticDeckInitialized = true;
    console.log("[MidnightOnChain] Static deck initialized successfully!");
    return { success: true };
  } catch (error: any) {
    const errorMsg = error?.message || String(error);
    // Check if already initialized (the contract checks this)
    if (errorMsg.includes("already") || errorMsg.includes("Static deck")) {
      console.log("[MidnightOnChain] Static deck was already initialized on-chain");
      staticDeckInitialized = true;
      return { success: true };
    }
    console.error("[MidnightOnChain] initializeStaticDeck failed:", error);
    return { success: false, errorMessage: errorMsg };
  }
}

/**
 * Apply mask action (setup phase)
 */
export async function onChainApplyMask(
  lobbyId: string,
  playerId: 1 | 2
): Promise<{ success: boolean; errorMessage?: string }> {
  // In batcher mode, use the batcher service
  if (batcherModeActive) {
    // Ensure static deck is initialized before any game operation
    if (!staticDeckInitialized) {
      console.log("[MidnightOnChain] Ensuring static deck is initialized before applyMask...");
      const initResult = await initializeStaticDeck();
      if (!initResult.success) {
        return { success: false, errorMessage: `Failed to initialize static deck: ${initResult.errorMessage}` };
      }
    }
    console.log("[MidnightOnChain] Using batcher service for applyMask...");
    const result = await BatcherMidnightService.applyMask(lobbyId, playerId);
    if (result.success) {
      // Notify backend that mask was applied so it can track state
      await notifyBackendSetupComplete(lobbyId, playerId, "mask_applied");
    }
    return { success: result.success, errorMessage: result.error };
  }

  if (!isOnChainReady()) {
    return { success: false, errorMessage: "On-chain mode not active - use backend API" };
  }

  // Ensure static deck is initialized before any game operation
  if (!staticDeckInitialized) {
    console.log("[MidnightOnChain] Ensuring static deck is initialized before applyMask...");
    const initResult = await initializeStaticDeck();
    if (!initResult.success) {
      return { success: false, errorMessage: `Failed to initialize static deck: ${initResult.errorMessage}` };
    }
  }

  try {
    const callTx = getCallTx();
    const gameId = lobbyIdToGameId(lobbyId);
    await callTx.applyMask(gameId, BigInt(playerId));
    return { success: true };
  } catch (error) {
    console.error("[MidnightOnChain] applyMask failed:", error);
    return { success: false, errorMessage: String(error) };
  }
}

/**
 * Deal cards action (setup phase)
 */
export async function onChainDealCards(
  lobbyId: string,
  playerId: 1 | 2
): Promise<{ success: boolean; errorMessage?: string }> {
  // In batcher mode, use the batcher service
  if (batcherModeActive) {
    console.log("[MidnightOnChain] Using batcher service for dealCards...");
    const result = await BatcherMidnightService.dealCards(lobbyId, playerId);
    if (result.success) {
      // Notify backend that dealing is complete so it can track state
      await notifyBackendSetupComplete(lobbyId, playerId, "dealt_complete");
    }
    return { success: result.success, errorMessage: result.error };
  }

  if (!isOnChainReady()) {
    return { success: false, errorMessage: "On-chain mode not active - use backend API" };
  }

  try {
    const callTx = getCallTx();
    const gameId = lobbyIdToGameId(lobbyId);
    await callTx.dealCards(gameId, BigInt(playerId));
    return { success: true };
  } catch (error) {
    console.error("[MidnightOnChain] dealCards failed:", error);
    return { success: false, errorMessage: String(error) };
  }
}

/**
 * Ask for card action
 */
export async function onChainAskForCard(
  lobbyId: string,
  playerId: 1 | 2,
  rank: number
): Promise<{ success: boolean; errorMessage?: string }> {
  // In batcher mode, use the batcher service
  if (batcherModeActive) {
    console.log("[MidnightOnChain] Using batcher service for askForCard...");
    const result = await BatcherMidnightService.askForCard(lobbyId, playerId, rank);
    return { success: result.success, errorMessage: result.error };
  }

  if (!isOnChainReady()) {
    return { success: false, errorMessage: "On-chain mode not active - use backend API" };
  }

  try {
    const callTx = getCallTx();
    const gameId = lobbyIdToGameId(lobbyId);
    const now = BigInt(Math.floor(Date.now() / 1000));
    await callTx.askForCard(gameId, BigInt(playerId), BigInt(rank), now);
    return { success: true };
  } catch (error) {
    console.error("[MidnightOnChain] askForCard failed:", error);
    return { success: false, errorMessage: String(error) };
  }
}

/**
 * Respond to ask action
 */
export async function onChainRespondToAsk(
  lobbyId: string,
  playerId: 1 | 2
): Promise<{ success: boolean; hasCards: boolean; cardCount: number; errorMessage?: string }> {
  // In batcher mode, use the batcher service
  if (batcherModeActive) {
    console.log("[MidnightOnChain] Using batcher service for respondToAsk...");

    // Determine hasCards BEFORE queuing the circuit by checking the on-chain hand.
    // The batcher queues asynchronously so the circuit result is not available synchronously.
    let hasCards = false;
    let cardCount = 0;
    try {
      // Fetch the last asked rank from backend (on-chain state, no wallet needed)
      const rankResp = await fetch(`${BACKEND_API_URL}/api/midnight/last_asked_rank?lobby_id=${encodeURIComponent(lobbyId)}`);
      if (rankResp.ok) {
        const { lastAskedRank } = await rankResp.json() as { lastAskedRank: number | null };
        if (lastAskedRank !== null) {
          // Query the responding player's current hand from the batcher's on-chain indexer
          const hand = await BatcherMidnightService.queryHandFromBatcher(lobbyId, playerId);
          if (hand !== null) {
            const matchingCards = hand.filter(c => c.rank === lastAskedRank);
            hasCards = matchingCards.length > 0;
            cardCount = matchingCards.length;
            console.log(`[MidnightOnChain] respondToAsk pre-check: lastAskedRank=${lastAskedRank} hand=${hand.length} cards, matching=${cardCount}`);
          }
        }
      }
    } catch (preCheckErr) {
      console.warn("[MidnightOnChain] respondToAsk pre-check failed — defaulting hasCards=false:", preCheckErr);
    }

    const result = await BatcherMidnightService.respondToAsk(lobbyId, playerId);
    return { success: result.success, hasCards, cardCount, errorMessage: result.error };
  }

  if (!isOnChainReady()) {
    return { success: false, hasCards: false, cardCount: 0, errorMessage: "On-chain mode not active - use backend API" };
  }

  try {
    const callTx = getCallTx();
    const gameId = lobbyIdToGameId(lobbyId);
    const now = BigInt(Math.floor(Date.now() / 1000));
    const result = await callTx.respondToAsk(gameId, BigInt(playerId), now);
    // Result is [boolean, bigint] - hasCards and count
    const [hasCards, cardCount] = result as [boolean, bigint];
    return { success: true, hasCards, cardCount: Number(cardCount) };
  } catch (error) {
    console.error("[MidnightOnChain] respondToAsk failed:", error);
    return { success: false, hasCards: false, cardCount: 0, errorMessage: String(error) };
  }
}

/**
 * Go Fish action - draw from deck
 */
export async function onChainGoFish(
  lobbyId: string,
  playerId: 1 | 2
): Promise<{ success: boolean; errorMessage?: string }> {
  // In batcher mode, use the batcher service
  if (batcherModeActive) {
    console.log("[MidnightOnChain] Using batcher service for goFish...");
    const result = await BatcherMidnightService.goFish(lobbyId, playerId);
    return { success: result.success, errorMessage: result.error };
  }

  if (!isOnChainReady()) {
    return { success: false, errorMessage: "On-chain mode not active - use backend API" };
  }

  try {
    const callTx = getCallTx();
    const gameId = lobbyIdToGameId(lobbyId);
    const now = BigInt(Math.floor(Date.now() / 1000));
    await callTx.goFish(gameId, BigInt(playerId), now);
    return { success: true };
  } catch (error) {
    console.error("[MidnightOnChain] goFish failed:", error);
    return { success: false, errorMessage: String(error) };
  }
}

/**
 * After Go Fish action - complete the turn
 */
export async function onChainAfterGoFish(
  lobbyId: string,
  playerId: 1 | 2,
  drewRequestedCard: boolean
): Promise<{ success: boolean; errorMessage?: string }> {
  // In batcher mode, use the batcher service
  if (batcherModeActive) {
    console.log("[MidnightOnChain] Using batcher service for afterGoFish...");
    const result = await BatcherMidnightService.afterGoFish(lobbyId, playerId, drewRequestedCard);
    return { success: result.success, errorMessage: result.error };
  }

  if (!isOnChainReady()) {
    return { success: false, errorMessage: "On-chain mode not active - use backend API" };
  }

  try {
    const callTx = getCallTx();
    const gameId = lobbyIdToGameId(lobbyId);
    const now = BigInt(Math.floor(Date.now() / 1000));
    await callTx.afterGoFish(gameId, BigInt(playerId), drewRequestedCard, now);
    return { success: true };
  } catch (error) {
    console.error("[MidnightOnChain] afterGoFish failed:", error);
    return { success: false, errorMessage: String(error) };
  }
}

/**
 * Skip draw when deck is empty
 */
export async function onChainSkipDrawDeckEmpty(
  lobbyId: string,
  playerId: 1 | 2
): Promise<{ success: boolean; errorMessage?: string }> {
  // In batcher mode, use the batcher service
  if (batcherModeActive) {
    console.log("[MidnightOnChain] Using batcher service for switchTurn...");
    const result = await BatcherMidnightService.switchTurn(lobbyId, playerId);
    return { success: result.success, errorMessage: result.error };
  }

  if (!isOnChainReady()) {
    return { success: false, errorMessage: "On-chain mode not active - use backend API" };
  }

  try {
    const callTx = getCallTx();
    const gameId = lobbyIdToGameId(lobbyId);
    // Call switchTurn when deck is empty
    await callTx.switchTurn(gameId, BigInt(playerId));
    return { success: true };
  } catch (error) {
    console.error("[MidnightOnChain] skipDrawDeckEmpty failed:", error);
    return { success: false, errorMessage: String(error) };
  }
}

/**
 * Claim a win because the active player has not moved within the timeout window.
 * Can only be called by the waiting player (the one whose turn it is NOT).
 */
export async function onChainClaimTimeoutWin(
  lobbyId: string,
  claimingPlayerId: 1 | 2
): Promise<{ success: boolean; errorMessage?: string }> {
  if (batcherModeActive) {
    console.log("[MidnightOnChain] Using batcher service for claimTimeoutWin...");
    const result = await BatcherMidnightService.claimTimeoutWin(lobbyId, claimingPlayerId);
    return { success: result.success, errorMessage: result.error };
  }

  if (!isOnChainReady()) {
    return { success: false, errorMessage: "On-chain mode not active - use backend API" };
  }

  try {
    const callTx = getCallTx();
    const gameId = lobbyIdToGameId(lobbyId);
    await callTx.claimTimeoutWin(gameId, BigInt(claimingPlayerId));
    return { success: true };
  } catch (error) {
    console.error("[MidnightOnChain] claimTimeoutWin failed:", error);
    return { success: false, errorMessage: String(error) };
  }
}

/**
 * Get contract address (raw 32-byte version)
 */
export function getContractAddress(): string | null {
  return contractAddressRaw;
}

/**
 * Query contract state from indexer
 */
export async function queryContractState(): Promise<any | null> {
  if (!providers || !contractAddressNormalized) {
    return null;
  }

  try {
    assertIsContractAddress(contractAddressNormalized as ContractAddress);
    const contractState = await providers.publicDataProvider.queryContractState(
      contractAddressNormalized as ContractAddress,
    );
    return contractState;
  } catch (error) {
    console.error("[MidnightOnChain] Error querying contract state:", error);
    return null;
  }
}

// Export service
export const MidnightOnChainService = {
  initialize: initializeOnChainService,
  isReady: isOnChainReady,
  isBatcherMode,
  getContractAddress,
  queryContractState,
  initializeStaticDeck,
  // Actions
  applyMask: onChainApplyMask,
  dealCards: onChainDealCards,
  askForCard: onChainAskForCard,
  respondToAsk: onChainRespondToAsk,
  goFish: onChainGoFish,
  afterGoFish: onChainAfterGoFish,
  skipDrawDeckEmpty: onChainSkipDrawDeckEmpty,
  claimTimeoutWin: onChainClaimTimeoutWin,
};

export default MidnightOnChainService;

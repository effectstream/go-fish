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

// Import Midnight SDK packages
import type { ContractAddress } from "@midnight-ntwrk/compact-runtime";
import { fromHex, toHex } from "@midnight-ntwrk/compact-runtime";
import * as ledger from "@midnight-ntwrk/ledger-v6";
import type {
  CoinPublicKey,
  EncPublicKey,
  ShieldedCoinInfo,
} from "@midnight-ntwrk/ledger-v6";
import {
  type DeployedContract,
  findDeployedContract,
  type FoundContract,
} from "@midnight-ntwrk/midnight-js-contracts";
import { httpClientProofProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { FetchZkConfigProvider } from "@midnight-ntwrk/midnight-js-fetch-zk-config-provider";
import { levelPrivateStateProvider } from "@midnight-ntwrk/midnight-js-level-private-state-provider";
import { assertIsContractAddress } from "@midnight-ntwrk/midnight-js-utils";
import {
  setNetworkId,
  type NetworkId,
} from "@midnight-ntwrk/midnight-js-network-id";
import type {
  BalancedProvingRecipe,
  ImpureCircuitId,
  MidnightProvider,
  MidnightProviders,
  WalletProvider,
  Contract,
} from "@midnight-ntwrk/midnight-js-types";
import type { ConnectedAPI } from "@midnight-ntwrk/dapp-connector-api";

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
const BASE_URL_MIDNIGHT_INDEXER = "http://127.0.0.1:8088";
const BASE_WS_MIDNIGHT_INDEXER = "ws://127.0.0.1:8088";
const BASE_URL_PROOF_SERVER = "http://127.0.0.1:6300";
const BASE_URL_MIDNIGHT_INDEXER_API = `${BASE_URL_MIDNIGHT_INDEXER}/api/v1/graphql`;
const BASE_URL_MIDNIGHT_INDEXER_WS = `${BASE_WS_MIDNIGHT_INDEXER}/api/v1/graphql/ws`;

const MIDNIGHT_NETWORK_ID: NetworkId = "undeployed";

// Service state
let contractAddress: string | null = null;
let isInitialized = false;
let providers: GoFishProviders | null = null;
let deployedContract: DeployedGoFishContract | null = null;
let goFishContractInstance: any = null;

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
 * Load contract address from backend config or deployment file
 */
async function loadContractAddress(): Promise<string | null> {
  // First try to get from backend config
  try {
    const { API_BASE_URL } = await import("../apiConfig");
    const response = await fetch(`${API_BASE_URL}/api/midnight/contract_address`);
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
 * Load the contract module dynamically
 */
async function loadContractModule(): Promise<boolean> {
  try {
    // Try to load the contract from the shared module
    // This path would need to be adjusted based on how the contract is bundled
    // Contract is a namespace that contains the Contract class
    const contractModule = await import("../../../shared/contracts/midnight/go-fish-contract/src/_index.ts");

    const { Contract: ContractNamespace, witnesses } = contractModule;
    // ContractNamespace.Contract is the actual class constructor
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
 */
function createWalletAndMidnightProvider(
  connectedAPI: ConnectedAPI,
  coinPublicKey: CoinPublicKey,
  encryptionPublicKey: EncPublicKey,
): WalletProvider & MidnightProvider {
  return {
    getCoinPublicKey(): CoinPublicKey {
      return coinPublicKey;
    },
    getEncryptionPublicKey(): EncPublicKey {
      return encryptionPublicKey;
    },
    async balanceTx(
      tx: ledger.UnprovenTransaction,
      _newCoins?: ShieldedCoinInfo[],
      _ttl?: Date,
    ): Promise<BalancedProvingRecipe> {
      try {
        console.log("[MidnightOnChain] Balancing transaction via wallet");
        const serializedTx = toHex(tx.serialize());
        const received = await connectedAPI.balanceUnsealedTransaction(serializedTx);
        const transaction = ledger.Transaction.deserialize<
          ledger.SignatureEnabled,
          ledger.PreProof,
          ledger.PreBinding
        >(
          "signature",
          "pre-proof",
          "pre-binding",
          fromHex(received.tx),
        );
        return {
          type: "TransactionToProve",
          transaction: transaction,
        };
      } catch (e: any) {
        // Extract detailed error info from FiberFailure
        let errorDetails = "Unknown error";
        if (e?.cause) {
          // FiberFailure wraps the actual error in cause
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
        console.error("[MidnightOnChain] This usually means:");
        console.error("  - Wallet doesn't have enough tDUST (use the faucet to get more)");
        console.error("  - Wallet state is out of sync (try refreshing the page)");
        console.error("  - Transaction is invalid");
        throw new Error(`Failed to balance transaction: ${errorDetails}`);
      }
    },
    async submitTx(tx: ledger.FinalizedTransaction): Promise<ledger.TransactionId> {
      await connectedAPI.submitTransaction(toHex(tx.serialize()));
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
    shieldedCoinPublicKey as CoinPublicKey,
    shieldedEncryptionPublicKey as EncPublicKey,
  );

  const zkConfigPath = window.location.origin;

  return {
    privateStateProvider: levelPrivateStateProvider({
      privateStoragePasswordProvider: async () => "PAIMA_STORAGE_PASSWORD",
    } as any),
    zkConfigProvider: new FetchZkConfigProvider(
      zkConfigPath,
      fetch.bind(window),
    ),
    proofProvider: httpClientProofProvider(BASE_URL_PROOF_SERVER),
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
 * Join an existing deployed contract
 */
async function joinContract(
  provs: GoFishProviders,
  address: string,
): Promise<DeployedGoFishContract> {
  if (!goFishContractInstance) {
    throw new Error("Contract module not loaded");
  }

  console.log(`[MidnightOnChain] Attempting to find deployed contract at: ${address}`);

  // Pre-flight check - verify indexer is accessible
  const indexerOk = await checkIndexerConnectivity();
  if (!indexerOk) {
    throw new Error("Indexer connectivity check failed - ensure the indexer is running at " + BASE_URL_MIDNIGHT_INDEXER);
  }

  // Check if the contract exists in the indexer
  // Note: The GraphQL schema may vary between indexer versions, so we try multiple queries
  try {
    console.log("[MidnightOnChain] Querying indexer for contract existence...");
    // Try the contractAction query which is more commonly available
    const contractQuery = await fetch(BASE_URL_MIDNIGHT_INDEXER_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `query GetContract($address: String!) {
          contractAction(address: $address) {
            address
          }
        }`,
        variables: { address: address },
      }),
    });
    const contractData = await contractQuery.json();
    console.log("[MidnightOnChain] Contract query result:", JSON.stringify(contractData));

    if (contractData.errors) {
      console.log("[MidnightOnChain] GraphQL query not supported by this indexer version - continuing anyway");
    } else if (!contractData.data?.contractAction) {
      console.warn(`[MidnightOnChain] Contract not found at address ${address} - it may not have been deployed or indexed yet`);
    } else {
      console.log("[MidnightOnChain] Contract found in indexer!");
    }
  } catch (queryError) {
    console.warn("[MidnightOnChain] Could not query contract existence:", queryError);
  }

  // Add timeout to prevent hanging forever
  const TIMEOUT_MS = 30000; // 30 seconds

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new Error(`findDeployedContract timed out after ${TIMEOUT_MS}ms - the indexer is reachable but findDeployedContract is not completing. This may indicate the contract was not found at address ${address}`));
    }, TIMEOUT_MS);
  });

  try {
    console.log("[MidnightOnChain] Calling findDeployedContract...");
    const goFishContract = await Promise.race([
      findDeployedContract(provs, {
        contractAddress: address,
        contract: goFishContractInstance,
        privateStateId: "privateState",
        initialPrivateState: {},
      }),
      timeoutPromise,
    ]);

    console.log(`[MidnightOnChain] Joined contract at address: ${address}`);
    return goFishContract;
  } catch (error) {
    console.error("[MidnightOnChain] findDeployedContract failed:", error);
    throw error;
  }
}

/**
 * Initialize the on-chain service
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

    // Load contract module
    const contractLoaded = await loadContractModule();
    if (!contractLoaded) {
      console.warn("[MidnightOnChain] Contract module not available - running in backend mode");
      isInitialized = true;
      return true;
    }

    // Load contract address
    contractAddress = await loadContractAddress();
    if (!contractAddress) {
      console.warn("[MidnightOnChain] No contract address found");
      console.warn("[MidnightOnChain] Deploy the contract first: deno task midnight:deploy");
      isInitialized = true;
      return true;
    }

    // Get shielded addresses from wallet
    const shieldedAddresses = await connectedAPI.getShieldedAddresses();

    // Initialize providers
    providers = await initializeProviders(connectedAPI, shieldedAddresses);
    console.log("[MidnightOnChain] Providers initialized");

    // Join the contract
    deployedContract = await joinContract(providers, contractAddress);
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
 */
export function isOnChainReady(): boolean {
  return isInitialized && deployedContract !== null && isLaceConnected();
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
  if (!isOnChainReady()) {
    return { success: false, errorMessage: "On-chain mode not active" };
  }

  if (staticDeckInitialized) {
    console.log("[MidnightOnChain] Static deck already initialized in this session");
    return { success: true };
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
  if (!isOnChainReady()) {
    return { success: false, errorMessage: "On-chain mode not active - use backend API" };
  }

  try {
    const callTx = getCallTx();
    const gameId = lobbyIdToGameId(lobbyId);
    await callTx.askForCard(gameId, BigInt(playerId), BigInt(rank));
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
  if (!isOnChainReady()) {
    return { success: false, hasCards: false, cardCount: 0, errorMessage: "On-chain mode not active - use backend API" };
  }

  try {
    const callTx = getCallTx();
    const gameId = lobbyIdToGameId(lobbyId);
    const result = await callTx.respondToAsk(gameId, BigInt(playerId));
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
  if (!isOnChainReady()) {
    return { success: false, errorMessage: "On-chain mode not active - use backend API" };
  }

  try {
    const callTx = getCallTx();
    const gameId = lobbyIdToGameId(lobbyId);
    await callTx.goFish(gameId, BigInt(playerId));
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
  if (!isOnChainReady()) {
    return { success: false, errorMessage: "On-chain mode not active - use backend API" };
  }

  try {
    const callTx = getCallTx();
    const gameId = lobbyIdToGameId(lobbyId);
    await callTx.afterGoFish(gameId, BigInt(playerId), drewRequestedCard);
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
 * Get contract address
 */
export function getContractAddress(): string | null {
  return contractAddress;
}

/**
 * Query contract state from indexer
 */
export async function queryContractState(): Promise<any | null> {
  if (!providers || !contractAddress) {
    return null;
  }

  try {
    assertIsContractAddress(contractAddress as ContractAddress);
    const contractState = await providers.publicDataProvider.queryContractState(
      contractAddress as ContractAddress,
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
};

export default MidnightOnChainService;

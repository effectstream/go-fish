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

type ContractPrivateStateId = "counterPrivateState";

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
      } catch (e) {
        console.error("[MidnightOnChain] Error balancing transaction:", e);
        throw e;
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
 * Join an existing deployed contract
 */
async function joinContract(
  provs: GoFishProviders,
  address: string,
): Promise<DeployedGoFishContract> {
  if (!goFishContractInstance) {
    throw new Error("Contract module not loaded");
  }

  const goFishContract = await findDeployedContract(provs, {
    contractAddress: address,
    contract: goFishContractInstance,
    privateStateId: "counterPrivateState",
    initialPrivateState: {},
  });

  console.log(`[MidnightOnChain] Joined contract at address: ${address}`);
  return goFishContract;
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

// ============================================================================
// Contract Actions - Direct on-chain calls
// ============================================================================

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

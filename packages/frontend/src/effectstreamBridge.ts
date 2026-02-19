/**
 * Effectstream Bridge - Handles blockchain interactions and wallet management
 * Bridges the frontend to Paima Engine (Effectstream) and smart contracts
 *
 * Uses a local wallet (auto-generated in browser) for EVM interactions,
 * removing the need for MetaMask or other external EVM wallets.
 * Players only need Lace wallet for Midnight ZK operations.
 */

import {
  PaimaEngineConfig,
  sendTransaction,
  walletLogin,
  type Wallet,
} from "@paimaexample/wallets";
import { hardhat } from "viem/chains";
import { ethers } from "ethers";

// WalletMode enum value for EvmEthers (avoiding isolatedModules issue)
const WALLET_MODE_EVM_ETHERS = 1;

// Contract addresses from deployment
const PAIMA_L2_CONTRACT_ADDRESS = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";

// Paima Engine API endpoint
const PAIMA_API_URL = "http://localhost:9996";

// Global wallet instance (local wallet - auto-generated)
let wallet: Wallet | null = null;

// Paima Engine configuration - NOT using batching, wallet pays for gas directly
const paimaEngineConfig = new PaimaEngineConfig(
  "go-fish",
  "mainEvmRPC",
  PAIMA_L2_CONTRACT_ADDRESS,
  hardhat as any, // Type compatibility with viem versions
  undefined,      // use default abi
  undefined,      // no batcher url
  false,          // useBatching = false
);

// Hardhat pre-funded account private keys (Account #0 through #9)
// These accounts each have 10000 ETH on the local Hardhat chain
const HARDHAT_ACCOUNTS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", // Account #0
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", // Account #1
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", // Account #2
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6", // Account #3
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a", // Account #4
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba", // Account #5
  "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e", // Account #6
  "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356", // Account #7
  "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97", // Account #8
  "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6", // Account #9
];

// Local storage key for which Hardhat account to use
const LOCAL_WALLET_INDEX_KEY = "go-fish-local-wallet-index";

/**
 * Get or assign a Hardhat account index for this browser session
 */
function getOrAssignAccountIndex(): number {
  let indexStr = localStorage.getItem(LOCAL_WALLET_INDEX_KEY);

  if (!indexStr) {
    // Assign a random account index (1-9, keeping 0 for other purposes)
    const index = Math.floor(Math.random() * 9) + 1;
    localStorage.setItem(LOCAL_WALLET_INDEX_KEY, String(index));
    console.log('[EffectstreamBridge] Assigned Hardhat account #' + index);
    return index;
  }

  return parseInt(indexStr, 10);
}

/**
 * Get the private key for the assigned Hardhat account
 */
function getPrivateKey(): string {
  const index = getOrAssignAccountIndex();
  console.log('[EffectstreamBridge] Using Hardhat account #' + index);
  return HARDHAT_ACCOUNTS[index];
}

/**
 * Initialize a local wallet using a pre-funded Hardhat account
 * This removes the need for MetaMask - wallet is assigned automatically
 * Uses ethers.js directly without external services like thirdweb
 */
async function initializeLocalWallet(): Promise<Wallet | null> {
  if (wallet) return wallet;

  try {
    // Get a pre-funded Hardhat account
    const privateKey = getPrivateKey();

    // Create ethers wallet with a provider (ethers v5 syntax)
    const provider = new ethers.providers.JsonRpcProvider("http://localhost:8545");
    const ethersWallet = new ethers.Wallet(privateKey, provider);

    console.log('[EffectstreamBridge] Local wallet address:', ethersWallet.address);

    // Login using the EvmEthers mode with our ethers wallet as the signer
    const loginOptions = {
      mode: WALLET_MODE_EVM_ETHERS,
      preferBatchedMode: true,
      connection: {
        metadata: {
          name: "ethers.localwallet",
          displayName: "Go Fish Local Wallet",
        },
        api: ethersWallet,
      },
    };

    const walletLoginResult = await walletLogin(loginOptions as any);
    if (walletLoginResult.success) {
      wallet = walletLoginResult.result;
      console.log('[EffectstreamBridge] Local wallet initialized:', wallet.walletAddress);
      return wallet;
    }

    console.error('[EffectstreamBridge] Failed to login with local wallet');
    return null;
  } catch (error) {
    console.error('[EffectstreamBridge] Failed to initialize local wallet:', error);
    return null;
  }
}

/**
 * Connect wallet - now uses auto-generated local wallet
 * No MetaMask or external wallet required
 */
export async function userWalletLogin({
  mode = 0,
}: {
  mode?: number;
} = {}): Promise<{ success: boolean; errorMessage?: string }> {
  try {
    // Always use local wallet - ignore mode parameter
    const localWallet = await initializeLocalWallet();

    if (localWallet) {
      console.log('[EffectstreamBridge] Local wallet connected:', localWallet.walletAddress);
      return { success: true };
    } else {
      return { success: false, errorMessage: 'Failed to initialize local wallet' };
    }
  } catch (error) {
    console.error('[EffectstreamBridge] Error connecting wallet:', error);
    return {
      success: false,
      errorMessage: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Ensure wallet is initialized before any operation
 */
async function ensureWallet(): Promise<Wallet | null> {
  if (!wallet) {
    return await initializeLocalWallet();
  }
  return wallet;
}

/**
 * Get current wallet address
 */
export function getWalletAddress(): string | null {
  return wallet?.walletAddress || null;
}

/**
 * Check if wallet is connected
 */
export function isWalletConnected(): boolean {
  return wallet !== null;
}

/**
 * Create a new game lobby on-chain
 */
export async function createLobby(
  playerName: string,
  lobbyName: string,
  maxPlayers: number
): Promise<{ success: boolean; lobbyId?: string; errorMessage?: string }> {
  const currentWallet = await ensureWallet();
  if (!currentWallet) {
    return { success: false, errorMessage: "Failed to initialize wallet" };
  }

  try {
    // Submit transaction to Paima L2 contract
    // Format: createdLobby command with playerName, lobbyName, and maxPlayers
    const params = ["createdLobby", playerName, lobbyName, maxPlayers];

    // Send transaction without waiting for processing (to avoid timeout)
    const result = await sendTransaction(currentWallet, params, paimaEngineConfig, "no-wait");

    if (!result.success) {
      return { success: false, errorMessage: "Failed to create lobby" };
    }

    console.log('Create lobby transaction submitted:', result);

    // Wait longer for transaction to be processed and indexed by Paima Engine
    // The backend needs time to process the block and index the lobby
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Query for the user's most recent lobby
    const walletAddress = currentWallet.walletAddress;
    const response = await fetch(
      `${PAIMA_API_URL}/user_lobbies?wallet=${walletAddress}&page=0&count=1`
    );

    if (!response.ok) {
      console.warn('Could not fetch lobby ID, but transaction succeeded');
      return { success: true, lobbyId: undefined };
    }

    const data = await response.json();
    const lobbyId = data.lobbies?.[0]?.lobby_id;

    return {
      success: true,
      lobbyId: lobbyId ? String(lobbyId) : undefined,
    };
  } catch (error) {
    console.error('Error creating lobby:', error);
    return {
      success: false,
      errorMessage: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Join an existing lobby
 */
export async function joinLobby(
  playerName: string,
  lobbyId: string
): Promise<{ success: boolean; errorMessage?: string }> {
  const currentWallet = await ensureWallet();
  if (!currentWallet) {
    return { success: false, errorMessage: "Failed to initialize wallet" };
  }

  try {
    // Grammar expects: joinedLobby|playerName|lobbyID
    const params = ["joinedLobby", playerName, lobbyId];
    const result = await sendTransaction(currentWallet, params, paimaEngineConfig);

    if (!result.success) {
      return { success: false, errorMessage: "Failed to join lobby" };
    }

    console.log('Join lobby transaction submitted:', result);

    // Wait a bit for the transaction to be processed and indexed
    await new Promise(resolve => setTimeout(resolve, 1000));

    return { success: true };
  } catch (error) {
    console.error('Error joining lobby:', error);
    return {
      success: false,
      errorMessage: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Toggle ready status in a lobby
 */
export async function toggleReady(
  lobbyId: string
): Promise<{ success: boolean; errorMessage?: string }> {
  const currentWallet = await ensureWallet();
  if (!currentWallet) {
    return { success: false, errorMessage: "Failed to initialize wallet" };
  }

  try {
    // Grammar expects: toggledReady|lobbyID
    const params = ["toggledReady", lobbyId];
    const result = await sendTransaction(currentWallet, params, paimaEngineConfig);

    if (!result.success) {
      return { success: false, errorMessage: "Failed to toggle ready" };
    }

    console.log('Toggle ready transaction submitted:', result);
    return { success: true };
  } catch (error) {
    console.error('Error toggling ready:', error);
    return {
      success: false,
      errorMessage: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Start game (host only)
 */
export async function startGame(
  lobbyId: string
): Promise<{ success: boolean; errorMessage?: string }> {
  const currentWallet = await ensureWallet();
  if (!currentWallet) {
    return { success: false, errorMessage: "Failed to initialize wallet" };
  }

  try {
    // Grammar expects: startedGame|lobbyID
    const params = ["startedGame", lobbyId];
    const result = await sendTransaction(currentWallet, params, paimaEngineConfig);

    if (!result.success) {
      return { success: false, errorMessage: "Failed to start game" };
    }

    console.log('Start game transaction submitted:', result);
    return { success: true };
  } catch (error) {
    console.error('Error starting game:', error);
    return {
      success: false,
      errorMessage: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Leave a lobby
 */
export async function leaveLobby(
  lobbyId: string
): Promise<{ success: boolean; errorMessage?: string }> {
  const currentWallet = await ensureWallet();
  if (!currentWallet) {
    return { success: false, errorMessage: "Failed to initialize wallet" };
  }

  try {
    // Grammar expects: leftLobby|lobbyID
    const params = ["leftLobby", lobbyId];
    const result = await sendTransaction(currentWallet, params, paimaEngineConfig);

    if (!result.success) {
      return { success: false, errorMessage: "Failed to leave lobby" };
    }

    console.log('Leave lobby transaction submitted:', result);
    return { success: true };
  } catch (error) {
    console.error('Error leaving lobby:', error);
    return {
      success: false,
      errorMessage: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Get lobby state from Paima Engine API
 */
export async function getLobbyState(
  lobbyId: string
): Promise<{ success: boolean; lobby?: any; errorMessage?: string }> {
  try {
    const response = await fetch(`${PAIMA_API_URL}/lobby_state?lobby_id=${lobbyId}`);

    if (!response.ok) {
      return { success: false, errorMessage: `HTTP ${response.status}` };
    }

    const data = await response.json();
    return { success: true, lobby: data };
  } catch (error) {
    console.error('Error fetching lobby state:', error);
    return {
      success: false,
      errorMessage: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Get list of open lobbies
 */
export async function getOpenLobbies(
  page: number = 0,
  count: number = 10
): Promise<{ success: boolean; lobbies?: any[]; errorMessage?: string }> {
  try {
    const response = await fetch(
      `${PAIMA_API_URL}/open_lobbies?page=${page}&count=${count}`
    );

    if (!response.ok) {
      return { success: false, errorMessage: `HTTP ${response.status}` };
    }

    const data = await response.json();
    return { success: true, lobbies: data.lobbies || [] };
  } catch (error) {
    console.error('Error fetching open lobbies:', error);
    return {
      success: false,
      errorMessage: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Get user's lobbies
 */
export async function getUserLobbies(
  walletAddress: string,
  page: number = 0,
  count: number = 10
): Promise<{ success: boolean; lobbies?: any[]; errorMessage?: string }> {
  try {
    const response = await fetch(
      `${PAIMA_API_URL}/user_lobbies?wallet=${walletAddress}&page=${page}&count=${count}`
    );

    if (!response.ok) {
      return { success: false, errorMessage: `HTTP ${response.status}` };
    }

    const data = await response.json();
    return { success: true, lobbies: data.lobbies || [] };
  } catch (error) {
    console.error('Error fetching user lobbies:', error);
    return {
      success: false,
      errorMessage: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Submit a game action (ask for card, draw card, etc.)
 */
export async function submitGameAction(
  lobbyId: string,
  actionType: string,
  ...params: any[]
): Promise<{ success: boolean; errorMessage?: string }> {
  const currentWallet = await ensureWallet();
  if (!currentWallet) {
    return { success: false, errorMessage: "Failed to initialize wallet" };
  }

  try {
    const txParams = ["gameAction", lobbyId, actionType, ...params];
    const result = await sendTransaction(currentWallet, txParams, paimaEngineConfig);

    if (!result.success) {
      return { success: false, errorMessage: "Failed to submit action" };
    }

    console.log('Game action submitted:', result);
    return { success: true };
  } catch (error) {
    console.error('Error submitting game action:', error);
    return {
      success: false,
      errorMessage: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

// Export all functions as a single bridge object
export const EffectstreamBridge = {
  userWalletLogin,
  getWalletAddress,
  isWalletConnected,
  createLobby,
  joinLobby,
  toggleReady,
  startGame,
  leaveLobby,
  getLobbyState,
  getOpenLobbies,
  getUserLobbies,
  submitGameAction,
};

export default EffectstreamBridge;

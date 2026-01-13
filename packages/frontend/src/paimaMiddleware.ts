/**
 * Paima Middleware - Handles blockchain interactions and wallet management
 * Bridges the frontend to Paima Engine and smart contracts
 */

import {
  PaimaEngineConfig,
  sendTransaction,
  walletLogin,
  WalletMode,
  type WalletLoginResult,
  type Wallet,
} from "@paimaexample/wallets";
import { hardhat } from "viem/chains";

// Contract addresses from deployment
const PAIMA_L2_CONTRACT_ADDRESS = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";
const GO_FISH_LOBBY_CONTRACT_ADDRESS = "0x5FbDB2315678afecb367f032d93F642f64180aa3";

// Paima Engine API endpoint
const PAIMA_API_URL = "http://localhost:9999";

// Global wallet instance
let wallet: Wallet | null = null;

// Paima Engine configuration
const paimaEngineConfig = new PaimaEngineConfig(
  "go-fish",
  "mainEvmRPC",
  PAIMA_L2_CONTRACT_ADDRESS,
  hardhat,
  undefined,
  undefined,
  false,
);

/**
 * Connect to user's wallet (MetaMask/injected wallet)
 */
export async function userWalletLogin({
  mode = 0, // WalletMode.EvmInjected
  preferBatchedMode = false,
}: {
  mode?: number;
  preferBatchedMode?: boolean;
} = {}): Promise<WalletLoginResult> {
  try {
    const result = await walletLogin({
      mode,
      chain: paimaEngineConfig.paimaL2Chain,
    });

    if (result.success) {
      wallet = result.result;
      console.log('Wallet connected:', result.result.walletAddress);
      return { success: true };
    } else {
      console.error('Wallet connection failed:', result.errorMessage);
      return { success: false, errorMessage: result.errorMessage };
    }
  } catch (error) {
    console.error('Error connecting wallet:', error);
    return {
      success: false,
      errorMessage: error instanceof Error ? error.message : 'Unknown error',
    };
  }
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
  name: string,
  maxPlayers: number
): Promise<{ success: boolean; lobbyId?: string; errorMessage?: string }> {
  if (!wallet) {
    return { success: false, errorMessage: "Wallet not connected" };
  }

  try {
    // Submit transaction to Paima L2 contract
    // Format: createdLobby command with playerName and maxPlayers
    const params = ["createdLobby", name, maxPlayers];

    // Send transaction without waiting for processing (to avoid timeout)
    const result = await sendTransaction(wallet, params, paimaEngineConfig, "no-wait");

    if (!result.success) {
      return { success: false, errorMessage: "Failed to create lobby" };
    }

    console.log('Create lobby transaction submitted:', result);

    // Wait longer for transaction to be processed and indexed by Paima Engine
    // The backend needs time to process the block and index the lobby
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Query for the user's most recent lobby
    const walletAddress = wallet.walletAddress;
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
  if (!wallet) {
    return { success: false, errorMessage: "Wallet not connected" };
  }

  try {
    // Grammar expects: joinedLobby|playerName|lobbyID
    const params = ["joinedLobby", playerName, lobbyId];
    const result = await sendTransaction(wallet, params, paimaEngineConfig);

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
  if (!wallet) {
    return { success: false, errorMessage: "Wallet not connected" };
  }

  try {
    // Grammar expects: toggledReady|lobbyID
    const params = ["toggledReady", lobbyId];
    const result = await sendTransaction(wallet, params, paimaEngineConfig);

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
  if (!wallet) {
    return { success: false, errorMessage: "Wallet not connected" };
  }

  try {
    // Grammar expects: startedGame|lobbyID
    const params = ["startedGame", lobbyId];
    const result = await sendTransaction(wallet, params, paimaEngineConfig);

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
  if (!wallet) {
    return { success: false, errorMessage: "Wallet not connected" };
  }

  try {
    const txParams = ["gameAction", lobbyId, actionType, ...params];
    const result = await sendTransaction(wallet, txParams, paimaEngineConfig);

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

// Export all functions as a single middleware object
export const PaimaMiddleware = {
  userWalletLogin,
  getWalletAddress,
  isWalletConnected,
  createLobby,
  joinLobby,
  toggleReady,
  startGame,
  getLobbyState,
  getOpenLobbies,
  getUserLobbies,
  submitGameAction,
};

export default PaimaMiddleware;

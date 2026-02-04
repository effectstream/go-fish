/**
 * Lace Wallet Bridge - Handles Midnight Lace wallet connection
 *
 * This module connects to the Lace Midnight wallet browser extension.
 * It tries @paimaexample/wallets first, then falls back to direct window.midnight access.
 */

import { walletLogin, WalletMode } from "@paimaexample/wallets";
import { setNetworkId, type NetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import type { ConnectedAPI } from "@midnight-ntwrk/dapp-connector-api";
import semver from "semver";

// State
let laceWalletAddress: string | null = null;
let connectedAPI: ConnectedAPI | null = null;
let contractAddress: string | null = null;
let paimaWalletResult: any = null;

// Network ID for Midnight network
// For local development with the undeployed network, use "undeployed"
// For testnet, use "preview" (Lace Midnight Preview wallet)
const MIDNIGHT_NETWORK_ID: NetworkId = "undeployed";
const COMPATIBLE_CONNECTOR_API_VERSION = ">=1.0.0";

// Set the network ID globally before any wallet operations
setNetworkId(MIDNIGHT_NETWORK_ID);

/**
 * Get contract address from deployment file
 */
const fetchContractAddress = async (): Promise<string | null> => {
  try {
    const r = await fetch("contract_address/contract-go-fish.undeployed.json");
    const json = await r.json();
    console.log("[LaceWalletBridge] Contract address:", json.contractAddress);
    return json.contractAddress;
  } catch (error) {
    console.warn("[LaceWalletBridge] Could not fetch contract address:", error);
    return null;
  }
};

/**
 * Direct connection to window.midnight (fallback method)
 */
async function connectDirectToMidnight(): Promise<ConnectedAPI> {
  const midnight = (window as any).midnight;

  if (!midnight) {
    throw new Error("Midnight Lace wallet not found. Is the extension installed?");
  }

  // Find compatible wallet APIs
  const wallets = Object.entries(midnight).filter(([_, api]: [string, any]) =>
    api.apiVersion &&
    semver.satisfies(api.apiVersion, COMPATIBLE_CONNECTOR_API_VERSION)
  ) as [string, any][];

  if (wallets.length === 0) {
    throw new Error("No compatible Midnight wallet found.");
  }

  const [name, api] = wallets[0];
  console.log(`[LaceWalletBridge] Direct connect to wallet: ${name} (version ${api.apiVersion})`);
  console.log(`[LaceWalletBridge] Requesting network ID: ${MIDNIGHT_NETWORK_ID}`);

  // Set password provider
  const passwordProvider = async () => "PAIMA_STORAGE_PASSWORD";
  const apiWithPassword: any = { ...api };
  if (typeof apiWithPassword.connect !== "function") {
    apiWithPassword.connect = api.connect.bind(api);
  }
  apiWithPassword.privateStoragePasswordProvider = passwordProvider;

  // Connect to the wallet with our network ID
  return await apiWithPassword.connect(MIDNIGHT_NETWORK_ID);
}

/**
 * Login with Lace wallet - tries @paimaexample/wallets first, then direct connection
 */
export async function laceWalletLogin(): Promise<{
  success: boolean;
  address?: string;
  errorMessage?: string;
}> {
  try {
    console.log(`[LaceWalletBridge] Logging in with network ID: ${MIDNIGHT_NETWORK_ID}`);

    // First try @paimaexample/wallets
    try {
      const result = await walletLogin({
        // @ts-ignore - WalletMode.Midnight = 2
        mode: WalletMode.Midnight,
        networkId: MIDNIGHT_NETWORK_ID,
      });

      if (result.success) {
        console.log("[LaceWalletBridge] Connected via @paimaexample/wallets");
        paimaWalletResult = result.result;
        connectedAPI = paimaWalletResult.provider.getConnection().api as ConnectedAPI;
      } else {
        console.log("[LaceWalletBridge] @paimaexample/wallets failed, trying direct connection...");
        throw new Error("Paima wallet failed");
      }
    } catch (paimaError) {
      // Fallback to direct window.midnight connection
      console.log("[LaceWalletBridge] Falling back to direct window.midnight connection");
      connectedAPI = await connectDirectToMidnight();
    }

    // Get shielded addresses from the wallet
    const addresses = await connectedAPI!.getShieldedAddresses();

    // The shielded address is the wallet address for Midnight
    laceWalletAddress = addresses.shieldedAddress || null;

    // Try to get the contract address
    contractAddress = await fetchContractAddress();

    console.log("[LaceWalletBridge] Lace wallet connected:", laceWalletAddress);

    return { success: true, address: laceWalletAddress || undefined };
  } catch (error) {
    console.error("[LaceWalletBridge] Login failed:", error);

    let errorMessage = error instanceof Error ? error.message : "Unknown error";

    return {
      success: false,
      errorMessage,
    };
  }
}

/**
 * Check if Lace wallet is connected
 */
export function isLaceConnected(): boolean {
  return connectedAPI !== null && laceWalletAddress !== null;
}

/**
 * Get Lace wallet address
 */
export function getLaceAddress(): string | null {
  return laceWalletAddress;
}

/**
 * Get the deployed contract address
 */
export function getDeployedContractAddress(): string | null {
  return contractAddress;
}

/**
 * Get the connected API instance (for advanced usage)
 */
export function getConnectedAPI(): ConnectedAPI | null {
  return connectedAPI;
}

/**
 * Get the Paima wallet result (for contract interaction)
 */
export function getPaimaWallet(): any {
  return paimaWalletResult;
}

/**
 * Request funds from the faucet
 */
export async function requestFaucetFunds(): Promise<{
  success: boolean;
  errorMessage?: string;
}> {
  if (!laceWalletAddress) {
    return { success: false, errorMessage: "Wallet not connected" };
  }

  try {
    const url = `http://localhost:9999/api/faucet/nights?address=${encodeURIComponent(laceWalletAddress)}`;
    const resp = await fetch(url);
    const data = await resp.json().catch(() => null);

    if (!resp.ok) {
      throw new Error(
        (data && typeof data === "object" && "message" in data
          ? (data as any).message
          : undefined) ?? `Faucet request failed (HTTP ${resp.status})`,
      );
    }

    console.log("[LaceWalletBridge] Faucet response:", data);
    return { success: true };
  } catch (error) {
    console.error("[LaceWalletBridge] Faucet request failed:", error);
    return {
      success: false,
      errorMessage: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Disconnect wallet
 */
export function disconnectLaceWallet(): void {
  connectedAPI = null;
  laceWalletAddress = null;
  contractAddress = null;
  paimaWalletResult = null;
  console.log("[LaceWalletBridge] Wallet disconnected");
}

// Export all functions
export const LaceWalletBridge = {
  laceWalletLogin,
  isLaceConnected,
  getLaceAddress,
  getDeployedContractAddress,
  getConnectedAPI,
  getPaimaWallet,
  requestFaucetFunds,
  disconnectLaceWallet,
};

export default LaceWalletBridge;

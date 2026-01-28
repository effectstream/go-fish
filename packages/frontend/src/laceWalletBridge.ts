/**
 * Lace Wallet Bridge - Handles Midnight Lace wallet connection
 *
 * This module connects to the Lace Midnight wallet browser extension directly
 * via window.midnight (not through Cardano wallet APIs).
 *
 * Note: The actual contract interaction happens via the backend in production mode.
 * The Lace wallet is used for authentication and signing transactions.
 */

import semver from "semver";

// State
let laceWalletAddress: string | null = null;
let connectedAPI: any | null = null;
let contractAddress: string | null = null;

// Network ID for Midnight network
// The Lace Midnight Preview wallet uses the "preview" network
// Valid values: "undeployed", "testnet", "testnet-02", "devnet", "preview"
const MIDNIGHT_NETWORK_ID = "preview";
const COMPATIBLE_CONNECTOR_API_VERSION = ">=1.0.0";

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
 * Connect directly to the Midnight Lace wallet via window.midnight
 * This is how effectstream-midnight connects to the wallet.
 */
async function connectToMidnightWallet(): Promise<any> {
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
  console.log(`[LaceWalletBridge] Connecting to wallet: ${name} (version ${api.apiVersion})`);

  // Set the password provider directly on the API object (don't spread it)
  // Spreading loses the private field context which causes "attempted to get private field on non-instance"
  api.privateStoragePasswordProvider = async () => "PAIMA_STORAGE_PASSWORD";

  // Connect to the wallet with our network ID
  return await api.connect(MIDNIGHT_NETWORK_ID);
}

/**
 * Login with Lace wallet by connecting directly to window.midnight
 */
export async function laceWalletLogin(): Promise<{
  success: boolean;
  address?: string;
  errorMessage?: string;
}> {
  try {
    // Connect directly to Midnight wallet (not through @paimaexample/wallets)
    connectedAPI = await connectToMidnightWallet();

    // Get shielded addresses from the wallet
    const addresses = await connectedAPI.getShieldedAddresses();

    // The shielded address is the wallet address for Midnight
    laceWalletAddress = addresses.shieldedAddress || null;

    // Try to get the contract address
    contractAddress = await fetchContractAddress();

    console.log("[LaceWalletBridge] Lace wallet connected:", laceWalletAddress);

    return { success: true, address: laceWalletAddress || undefined };
  } catch (error) {
    console.error("[LaceWalletBridge] Login failed:", error);

    // Provide helpful error messages
    let errorMessage = error instanceof Error ? error.message : "Unknown error";

    if (errorMessage.includes("midnight") || errorMessage.includes("Midnight")) {
      // Keep the message as-is, it's already helpful
    } else if (errorMessage.includes("Extension installed")) {
      // Keep the message as-is
    }

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
export function getConnectedAPI(): any | null {
  return connectedAPI;
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
  console.log("[LaceWalletBridge] Wallet disconnected");
}

// Export all functions
export const LaceWalletBridge = {
  laceWalletLogin,
  isLaceConnected,
  getLaceAddress,
  getDeployedContractAddress,
  getConnectedAPI,
  requestFaucetFunds,
  disconnectLaceWallet,
};

export default LaceWalletBridge;

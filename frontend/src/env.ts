import type { NetworkId } from "@midnight-ntwrk/midnight-js-network-id";

function requireEnv(name: string): string {
  const value = import.meta.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
      `Run with --mode undeployed or --mode mainnet to load the correct .env file.`
    );
  }
  return value;
}

export const ENV = {
  BATCHER_MODE_ENABLED: import.meta.env.VITE_BATCHER_MODE_ENABLED !== "false",
  NODE_API_URL: requireEnv("VITE_NODE_API_URL").replace(/\/$/, ""),
  BATCHER_URL: requireEnv("VITE_BATCHER_URL"),
  BATCHER_QUERY_URL: requireEnv("VITE_BATCHER_QUERY_URL"),
  INDEXER_HTTP_URL: requireEnv("VITE_INDEXER_HTTP_URL"),
  INDEXER_WS_URL: requireEnv("VITE_INDEXER_WS_URL"),
  EVM_RPC_URL: requireEnv("VITE_EVM_RPC_URL"),
  PAIMA_L2_CONTRACT_ADDRESS: requireEnv("VITE_PAIMA_L2_CONTRACT_ADDRESS"),
  MIDNIGHT_NETWORK_ID: requireEnv("VITE_MIDNIGHT_NETWORK_ID") as NetworkId,
  PROOF_SERVER_URL: import.meta.env.VITE_PROOF_SERVER_URL || undefined,
  MIDNIGHT_PARAMS_BASE_URL: import.meta.env.VITE_MIDNIGHT_PARAMS_BASE_URL || undefined,
  USE_LEGACY_GAME_UI: import.meta.env.VITE_USE_LEGACY_GAME_UI === "true",
} as const;

export const MIDNIGHT_CONTRACT_FILE = `go-fish-contract.${ENV.MIDNIGHT_NETWORK_ID}.json`;

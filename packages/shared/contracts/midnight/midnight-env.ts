/**
 * Midnight Network Configuration
 *
 * This file provides the network configuration for connecting to Midnight.
 * For local development, we use the "undeployed" network ID.
 */

import { NetworkId } from "@midnight-ntwrk/midnight-js-network-id";

export interface MidnightNetworkConfig {
  id: string;
  node: string;
  indexer: string;
  indexerWS: string;
  proofServer: string;
  walletSeed: string;
}

// Genesis mint wallet seed - used for funding test wallets via faucet
const GENESIS_MINT_WALLET_SEED =
  "0000000000000000000000000000000000000000000000000000000000000001";

// Local undeployed network configuration
export const midnightNetworkConfig: MidnightNetworkConfig = {
  id: "undeployed",
  node: "http://127.0.0.1:9944",
  indexer: "http://127.0.0.1:8088/api/v3/graphql",
  indexerWS: "ws://127.0.0.1:8088/api/v3/graphql/ws",
  proofServer: "http://127.0.0.1:6300",
  walletSeed: GENESIS_MINT_WALLET_SEED,
};

// Export network ID for use in wallet configuration
export const MIDNIGHT_NETWORK_ID: string = midnightNetworkConfig.id;

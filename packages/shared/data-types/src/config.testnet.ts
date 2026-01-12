/**
 * Testnet configuration for Paima Engine (Midnight Blockchain)
 */

export default {
  // Midnight testnet configuration
  chainId: 0, // TODO: Set Midnight testnet chain ID
  rpcUrl: 'https://rpc.testnet.midnight.network', // TODO: Update with actual Midnight RPC URL

  // Paima Engine configuration
  paimaL2ContractAddress: '0x0000000000000000000000000000000000000000', // TODO: Deploy and set contract address

  // Batcher configuration
  batcherUrl: 'https://batcher.go-fish.example.com', // TODO: Update with actual batcher URL

  // API configuration
  apiUrl: 'https://api.go-fish.example.com', // TODO: Update with actual API URL

  // Database configuration
  databaseUrl: process.env.DATABASE_URL || 'postgres://localhost:5432/go-fish',

  // Sync protocols
  syncProtocols: {
    // Main sync - Midnight blockchain
    midnight: {
      enabled: true,
      startBlockHeight: 0,
    },
  },

  // Disable development mode features
  devMode: false,
};

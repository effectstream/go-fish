/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Enable batcher mode (set to "true" to enable) */
  readonly VITE_BATCHER_MODE_ENABLED?: string;
  /** Batcher service URL */
  readonly VITE_BATCHER_URL?: string;
  /** Indexer HTTP URL */
  readonly VITE_INDEXER_HTTP_URL?: string;
  /** Indexer WebSocket URL */
  readonly VITE_INDEXER_WS_URL?: string;
  /** Paima L2 contract address */
  readonly VITE_PAIMA_L2_CONTRACT_ADDRESS?: string;
  /** EVM RPC URL */
  readonly VITE_EVM_RPC_URL?: string;
  /** Use legacy DOM game screen instead of Three.js (set to "true" to enable) */
  readonly VITE_USE_LEGACY_GAME_UI?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/// <reference types="vite/client" />

declare module "crypto-browserify" {
  const crypto: any;
  export default crypto;
  export const createHash: any;
  export const createHmac: any;
  export const randomBytes: any;
  export const pbkdf2Sync: any;
  export const timingSafeEqual: any;
}

declare module "browser-level" {
  export class BrowserLevel<K = string, V = any> {
    constructor(location: string, options?: any);
  }
}

interface ImportMetaEnv {
  /** Enable batcher mode (set to "true" to enable) */
  readonly VITE_BATCHER_MODE_ENABLED?: string;
  /** Paima node API URL */
  readonly VITE_NODE_API_URL: string;
  /** Batcher service URL */
  readonly VITE_BATCHER_URL: string;
  /** Batcher query server URL */
  readonly VITE_BATCHER_QUERY_URL: string;
  /** Indexer HTTP URL */
  readonly VITE_INDEXER_HTTP_URL: string;
  /** Indexer WebSocket URL */
  readonly VITE_INDEXER_WS_URL: string;
  /** Paima L2 contract address */
  readonly VITE_PAIMA_L2_CONTRACT_ADDRESS: string;
  /** EVM RPC URL */
  readonly VITE_EVM_RPC_URL: string;
  /** Midnight network ID ("undeployed" or "mainnet") */
  readonly VITE_MIDNIGHT_NETWORK_ID: string;
  /** Optional: proof server URL (unset = in-browser WASM proving) */
  readonly VITE_PROOF_SERVER_URL?: string;
  /** Optional: fallback URL for BLS midnight params */
  readonly VITE_MIDNIGHT_PARAMS_BASE_URL?: string;
  /** Use legacy DOM game screen instead of Three.js (set to "true" to enable) */
  readonly VITE_USE_LEGACY_GAME_UI?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

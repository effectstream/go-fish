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
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

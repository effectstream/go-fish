import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';

export default defineConfig({
  plugins: [
    wasm(),
    topLevelAwait(),
    nodePolyfills({
      // Include all node polyfills needed by Midnight SDK
      include: [
        'buffer',
        'process',
        'crypto',
        'path',
        'fs',
        'assert',
        'stream',
        'util',
        'events',
      ],
      // Provide global polyfills
      globals: {
        Buffer: true,
        global: true,
        process: true,
      },
    }),
  ],
  server: {
    port: 3000,
    fs: {
      strict: false,
    },
  },
  build: {
    target: 'esnext',
    commonjsOptions: {
      transformMixedEsModules: true,
      extensions: ['.js', '.cjs'],
      ignoreDynamicRequires: true,
    },
    rollupOptions: {
      // Ensure WebSocket is treated correctly
      external: [],
    },
  },
  optimizeDeps: {
    include: [
      // CommonJS modules that need pre-bundling for ESM compatibility
      'object-inspect',
      'side-channel',
      'call-bind',
      'get-intrinsic',
      'has-symbols',
      'has-proto',
      'function-bind',
      // Include fp-ts and rxjs for Midnight SDK
      'fp-ts',
      'fp-ts/function',
      'rxjs',
      // Include isomorphic-ws for proper bundling
      'isomorphic-ws',
    ],
    exclude: [
      // Midnight runtime packages that use WASM - must be excluded from pre-bundling
      '@midnight-ntwrk/onchain-runtime-v1',
      '@midnight-ntwrk/compact-runtime',
    ],
    esbuildOptions: {
      target: 'esnext',
      // Define global for Node.js modules
      define: {
        global: 'globalThis',
      },
    },
  },
  resolve: {
    alias: {
      // Map isomorphic-ws to native WebSocket in browser
      'isomorphic-ws': 'ws',
    },
  },
  // Handle WASM files from Midnight runtime
  assetsInclude: ['**/*.wasm'],
  worker: {
    format: 'es',
  },
  define: {
    // Define global for compatibility
    global: 'globalThis',
  },
});

import { defineConfig, normalizePath } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
    // Copy zkConfig files (keys, zkir) for FetchZkConfigProvider
    viteStaticCopy({
      targets: [
        {
          // Copy verifier/prover keys
          src: normalizePath(
            path.resolve(
              __dirname,
              '..',
              'shared',
              'contracts',
              'midnight',
              'go-fish-contract',
              'src',
              'managed',
              'keys',
              '*',
            ),
          ),
          dest: 'keys',
        },
        {
          // Copy zkir files
          src: normalizePath(
            path.resolve(
              __dirname,
              '..',
              'shared',
              'contracts',
              'midnight',
              'go-fish-contract',
              'src',
              'managed',
              'zkir',
              '*',
            ),
          ),
          dest: 'zkir',
        },
        {
          // Copy contract address file
          src: normalizePath(
            path.resolve(
              __dirname,
              '..',
              'shared',
              'contracts',
              'midnight',
              'go-fish-contract.undeployed.json',
            ),
          ),
          dest: 'contract_address',
        },
        {
          // Copy @paima/midnight-vm-bindings WASM file for web worker
          src: normalizePath(
            path.resolve(
              __dirname,
              'node_modules',
              '@paima',
              'midnight-vm-bindings',
              '*.wasm',
            ),
          ),
          dest: 'wasm',
        },
        {
          // Copy worker helper JS files from midnight-vm-bindings
          src: normalizePath(
            path.resolve(
              __dirname,
              'node_modules',
              '@paima',
              'midnight-vm-bindings',
              'snippets',
              '**/*',
            ),
          ),
          dest: 'wasm/snippets',
        },
      ],
    }),
  ],
  server: {
    port: 3000,
    fs: {
      strict: false,
    },
    // Required headers for SharedArrayBuffer (multi-threaded WASM)
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  preview: {
    // Required headers for SharedArrayBuffer in preview mode
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
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
      '@midnight-ntwrk/onchain-runtime',
      '@midnight-ntwrk/compact-runtime',
      '@midnight-ntwrk/ledger',
      // WASM bindings with nested worker pattern - must be excluded to preserve import.meta.url
      '@paima/midnight-vm-bindings',
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
      // Shim compact-runtime to provide compatibility between v0.11.0 and midnight-js v2.0.0
      // midnight-js v2.0.0 expects `constructorContext` but v0.11.0 exports `createConstructorContext`
      '@midnight-ntwrk/compact-runtime': path.resolve(__dirname, 'src/midnight-shim.ts'),
      // Force consistent version of onchain-runtime
      '@midnight-ntwrk/onchain-runtime': path.resolve(__dirname, 'node_modules/@midnight-ntwrk/onchain-runtime-v2'),
      '@midnight-ntwrk/onchain-runtime-v2': path.resolve(__dirname, 'node_modules/@midnight-ntwrk/onchain-runtime-v2'),
    },
  },
  // Handle WASM files from Midnight runtime
  assetsInclude: ['**/*.wasm'],
  worker: {
    format: 'es',
    plugins: () => [
      wasm(),
      topLevelAwait(),
    ],
    rollupOptions: {
      output: {
        chunkFileNames: 'assets/worker/[name]-[hash].js',
        assetFileNames: 'assets/worker/[name]-[hash].js',
      },
    },
  },
  define: {
    // Define global for compatibility
    global: 'globalThis',
  },
});

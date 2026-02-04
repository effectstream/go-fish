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
              'contract-go-fish.undeployed.json',
            ),
          ),
          dest: 'contract_address',
        },
      ],
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
      '@midnight-ntwrk/onchain-runtime-v2',
      '@midnight-ntwrk/compact-runtime',
      '@midnight-ntwrk/compact-js',
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
      // Force consistent versions of Midnight runtime packages to avoid ChargedState mismatch
      '@midnight-ntwrk/compact-runtime': path.resolve(__dirname, 'node_modules/@midnight-ntwrk/compact-runtime'),
      '@midnight-ntwrk/onchain-runtime-v1': path.resolve(__dirname, 'node_modules/@midnight-ntwrk/onchain-runtime-v1'),
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

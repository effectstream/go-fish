import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';

export default defineConfig({
  plugins: [
    wasm(),
    topLevelAwait(),
    nodePolyfills({
      include: ['buffer', 'process'],
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
    ],
    exclude: [
      // Midnight runtime packages that use WASM - must be excluded from pre-bundling
      '@midnight-ntwrk/onchain-runtime-v1',
      '@midnight-ntwrk/compact-runtime',
    ],
    esbuildOptions: {
      target: 'esnext',
    },
  },
  resolve: {
    alias: {
      // Force use of node: prefix for built-in modules
      assert: 'node:assert',
      buffer: 'node:buffer',
      process: 'node:process',
    },
  },
  // Handle WASM files from Midnight runtime
  assetsInclude: ['**/*.wasm'],
  worker: {
    format: 'es',
  },
});

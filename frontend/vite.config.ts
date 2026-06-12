import { defineConfig, normalizePath } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import glsl from 'vite-plugin-glsl';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const wsBrowserPath = path.join(path.dirname(require.resolve('ws/package.json')), 'browser.js');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const managedDir = path.resolve(
  __dirname,
  '../packages/shared/contracts/midnight/go-fish-contract/src/managed',
);
const publicDir = path.resolve(__dirname, 'public');
const cryptoShimPath = path.resolve(__dirname, 'src/shims/crypto.ts');
const levelShimPath = path.resolve(__dirname, 'src/shims/level.ts');

/**
 * Serves compiled ZK contract artifacts (keys + zkir) and BLS prover params from
 * the shared managed directory and public/midnight-prover during dev/preview.
 *
 * Prevents SPA fallback from serving index.html for missing binary assets, which
 * would cause @paima/midnight-wasm-prover to panic with "capacity overflow".
 */
function artifactMiddleware(req: any, res: any, next: any) {
  const url: string = (req.url ?? '').split('?')[0];
  let filePath: string | null = null;
  let rootDir: string | null = null;

  if (url.startsWith('/keys/')) {
    rootDir = path.resolve(managedDir, 'keys');
    filePath = path.resolve(rootDir, url.slice('/keys/'.length));
  } else if (url.startsWith('/zkir/')) {
    rootDir = path.resolve(managedDir, 'zkir');
    filePath = path.resolve(rootDir, url.slice('/zkir/'.length));
  } else if (url.startsWith('/midnight-prover/')) {
    rootDir = path.resolve(publicDir, 'midnight-prover');
    filePath = path.resolve(rootDir, url.slice('/midnight-prover/'.length));
  }

  if (!filePath || !rootDir) {
    next();
    return;
  }

  const rel = path.relative(rootDir, filePath);
  if (rel.startsWith('..') || rel === '') {
    res.statusCode = 400;
    res.end('Invalid ZK artifact path');
    return;
  }

  if (fs.existsSync(filePath)) {
    res.setHeader('Content-Type', 'application/octet-stream');
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  res.statusCode = 404;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end(`ZK artifact not found: ${url}`);
}

function serveContractArtifacts() {
  return {
    name: 'serve-contract-artifacts',
    configureServer(server: any) {
      server.middlewares.use(artifactMiddleware);
    },
    configurePreviewServer(server: any) {
      server.middlewares.use(artifactMiddleware);
    },
  };
}

export default defineConfig({
  plugins: [
    wasm(),
    topLevelAwait(),
    glsl(),
    // Serve ZK keys/zkir and BLS params as binary files (prevents SPA fallback HTML)
    serveContractArtifacts(),
    nodePolyfills({
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
      // Use memfs for fs so server-only modules pulled into the bundle
      // (e.g. @effectstream/midnight-contracts get-wallet-info, reached via
      // @effectstream/wallets) resolve named fs exports instead of hitting
      // node-stdlib-browser's empty mock. Matches sibling games (block-kart).
      overrides: {
        fs: 'memfs',
        'node:fs': 'memfs',
      },
      globals: {
        Buffer: true,
        global: true,
        process: true,
      },
    }),
    // Copy zkConfig files (keys, zkir) for FetchZkConfigProvider and BLS params for production builds
    viteStaticCopy({
      targets: [
        {
          src: normalizePath(
            path.resolve(
              __dirname,
              '../packages/shared/contracts/midnight/go-fish-contract/src/managed/keys/*',
            ),
          ),
          dest: 'keys',
        },
        {
          src: normalizePath(
            path.resolve(
              __dirname,
              '../packages/shared/contracts/midnight/go-fish-contract/src/managed/zkir/*',
            ),
          ),
          dest: 'zkir',
        },
        {
          src: normalizePath(
            path.resolve(
              __dirname,
              '../packages/shared/contracts/midnight/go-fish-contract.*.json',
            ),
          ),
          dest: 'contract_address',
        },
        {
          // BLS trusted-setup params for @paima/midnight-wasm-prover
          src: normalizePath(
            path.resolve(__dirname, 'public/midnight-prover/*'),
          ),
          dest: 'midnight-prover',
        },
        {
          src: normalizePath(
            path.resolve(
              __dirname,
              'node_modules/@paima/midnight-vm-bindings/*.wasm',
            ),
          ),
          dest: 'wasm',
        },
        {
          src: normalizePath(
            path.resolve(
              __dirname,
              'node_modules/@paima/midnight-vm-bindings/snippets/**/*',
            ),
          ),
          dest: 'wasm/snippets',
        },
      ],
    }),
  ],
  server: {
    port: 3000,
    host: '0.0.0.0',
    allowedHosts: true,
    fs: {
      strict: false,
    },
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  preview: {
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
      external: [],
    },
  },
  optimizeDeps: {
    include: [
      'object-inspect',
      'effect',
      'fp-ts',
      'fp-ts/function',
      'rxjs',
      'isomorphic-ws',
    ],
    exclude: [
      '@effectstream/midnight-contracts',
      '@paima/midnight-wasm-prover',
      '@midnight-ntwrk/onchain-runtime',
      '@midnight-ntwrk/onchain-runtime-v3',
      '@midnight-ntwrk/compact-runtime',
      '@midnight-ntwrk/compact-js',
      '@midnight-ntwrk/ledger',
      '@midnight-ntwrk/ledger-v8',
      '@midnight-ntwrk/midnight-js-contracts',
      '@midnight-ntwrk/midnight-js-types',
      '@midnight-ntwrk/midnight-js-level-private-state-provider',
      '@paima/midnight-vm-bindings',
    ],
    esbuildOptions: {
      target: 'esnext',
      define: {
        global: 'globalThis',
      },
    },
  },
  resolve: {
    dedupe: [
      "effect",
      "@effect/platform",
      "@midnight-ntwrk/compact-js",
      "@midnight-ntwrk/ledger-v8",
      "@midnight-ntwrk/onchain-runtime-v3",
      "@midnight-ntwrk/onchain-runtime",
      "@midnight-ntwrk/compact-runtime",
      "@midnight-ntwrk/midnight-js-contracts",
    ],
    alias: {
      crypto: cryptoShimPath,
      'node:crypto': cryptoShimPath,
      level: levelShimPath,
      'isomorphic-ws': wsBrowserPath,
      'npm:viem': 'viem',
      'npm:viem/accounts': 'viem/accounts',
      'npm:viem@2.37.3': 'viem',
      'npm:viem@2.37.3/accounts': 'viem/accounts',
      'npm:@sinclair/typebox@^0.34.41': '@sinclair/typebox',
      'npm:@sinclair/typebox@0.34.41': '@sinclair/typebox',
      'npm:@sinclair/typebox@^0.34.30': '@sinclair/typebox',
      '@midnight-ntwrk/onchain-runtime': path.resolve(__dirname, 'node_modules/@midnight-ntwrk/onchain-runtime-v3'),
      '@midnight-ntwrk/onchain-runtime-v3': path.resolve(__dirname, 'node_modules/@midnight-ntwrk/onchain-runtime-v3'),
    },
  },
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
    global: 'globalThis',
  },
});

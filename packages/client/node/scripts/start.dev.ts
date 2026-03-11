import { OrchestratorConfig, start } from "@paimaexample/orchestrator";
import { ComponentNames } from "@paimaexample/log";
import { Value } from "@sinclair/typebox/value";
import { launchEvm } from "@paimaexample/orchestrator/start-evm";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// Get absolute path to the midnight contracts directory
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const midnightContractsDir = path.resolve(__dirname, "../../../shared/contracts/midnight");
const indexerConfigPath = path.join(midnightContractsDir, "indexer-standalone/config.yaml");

// Check if we should skip Midnight infrastructure (when using TypeScript contract)
const useTypescriptContract = Deno.env.get("USE_TYPESCRIPT_CONTRACT") === "true";

// Check if batcher mode is enabled (run frontend in batcher mode, no Lace wallet needed)
const useBatcherMode = Deno.env.get("USE_BATCHER_MODE") === "true";

// Check if we should deploy the Midnight contract at startup (takes ~6 minutes)
// Set DEPLOY_MIDNIGHT_CONTRACT=true to deploy, otherwise assumes contract is already deployed
const deployMidnightContract = Deno.env.get("DEPLOY_MIDNIGHT_CONTRACT") === "true";

// Check if Midnight infrastructure is already running (via midnight:setup)
// Set SKIP_MIDNIGHT_INFRA=true to skip starting node/indexer/proof-server
const skipMidnightInfra = Deno.env.get("SKIP_MIDNIGHT_INFRA") === "true";

// Check if EVM/Hardhat is already running externally
// Set SKIP_EVM_LAUNCH=true to skip launching Hardhat node and deployment
// This is useful when multiple programs share a single Hardhat instance
// Example: SKIP_EVM_LAUNCH=true USE_TYPESCRIPT_CONTRACT=true deno task dev
const skipEvmLaunch = Deno.env.get("SKIP_EVM_LAUNCH") === "true";

// Check if pglite database should be skipped (for shared infrastructure environments)
// Set SKIP_PGLITE=true to skip launching pglite database
const skipPglite = Deno.env.get("SKIP_PGLITE") === "true";

// Suppress noisy infrastructure logs (hardhat-evmMain, effectstream-sync-block-merge, etc.)
// Set QUIET_LOGS=true to hide these and keep only batcher/node/game-relevant output
const quietLogs = Deno.env.get("QUIET_LOGS") === "true";

// Debug logging
console.log(`[Orchestrator] USE_TYPESCRIPT_CONTRACT=${useTypescriptContract}, USE_BATCHER_MODE=${useBatcherMode}, DEPLOY_MIDNIGHT_CONTRACT=${deployMidnightContract}, SKIP_MIDNIGHT_INFRA=${skipMidnightInfra}, SKIP_EVM_LAUNCH=${skipEvmLaunch}, SKIP_PGLITE=${skipPglite}`);

// Path to GraphQL proxy (translates SDK v2.0.0 queries to indexer v3 schema)
// Note: With SDK v3, this may no longer be needed
const graphqlProxyScript = path.resolve(__dirname, "graphql-proxy.ts");

// Path to cleanup script for indexer database
const cleanupIndexerScript = path.resolve(__dirname, "cleanup-indexer-db.ts");

// Midnight infrastructure processes (skipped when using TypeScript contract or SKIP_MIDNIGHT_INFRA=true)
const midnightProcesses = (useTypescriptContract || skipMidnightInfra) ? [] : [
  /** MIDNIGHT-NODE-BLOCK */
  {
    name: "midnight-node",
    args: [
      "run", "-A", "--unstable-detect-cjs",
      "npm:@paimaexample/npm-midnight-node@0.7.0",
      "--dev", "--rpc-port", "9944",
      "--state-pruning", "archive",
      "--blocks-pruning", "archive",
      "--public-addr", "/ip4/127.0.0.1",
      "--unsafe-rpc-external"
    ],
    env: { CFG_PRESET: "dev" },
    waitToExit: false,
    type: "system-dependency",
    link: "http://localhost:9944",
    stopProcessAtPort: [9944],
    dependsOn: [],
  },
  /** MIDNIGHT-NODE-BLOCK */

  /** MIDNIGHT-INDEXER-CLEANUP-BLOCK */
  // Clear stale indexer database before starting - the database becomes invalid
  // when the midnight-node restarts with a fresh chain state
  {
    name: "cleanup-indexer-db",
    args: [
      "run", "-A", "--unstable-detect-cjs",
      cleanupIndexerScript,
    ],
    waitToExit: true,
    type: "system-dependency",
    dependsOn: ["midnight-node"],
  },
  /** MIDNIGHT-INDEXER-CLEANUP-BLOCK */

  /** MIDNIGHT-INDEXER-BLOCK */
  // Note: Using npm package which provides indexer v3.0.0-alpha.21 binary.
  // The npm package handles all configuration automatically.
  // Uses /api/v3/graphql endpoint - SDK v2.0.0 may have compatibility issues.
  {
    name: "midnight-indexer",
    args: [
      "run", "-A", "--unstable-detect-cjs",
      "npm:@paimaexample/npm-midnight-indexer@0.7.0",
      "--standalone",
      "--binary",  // Use binary instead of Docker to avoid interactive prompt
    ],
    env: {
      LEDGER_NETWORK_ID: "Undeployed",
      SUBSTRATE_NODE_WS_URL: "ws://localhost:9944",
      // Secret must be a valid hex string with even number of digits (32 bytes = 64 hex chars)
      APP__INFRA__SECRET: "0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF",
    },
    waitToExit: false,
    type: "system-dependency",
    link: "http://localhost:8088",
    stopProcessAtPort: [8088],
    dependsOn: ["cleanup-indexer-db"],
  },
  /** MIDNIGHT-INDEXER-BLOCK */

  /** MIDNIGHT-PROOF-SERVER-BLOCK */
  {
    name: "midnight-proof-server",
    args: [
      "run", "-A", "--unstable-detect-cjs",
      "npm:@paimaexample/npm-midnight-proof-server@0.7.0"
    ],
    env: {
      LEDGER_NETWORK_ID: "Undeployed",
      RUST_BACKTRACE: "full",
      SUBSTRATE_NODE_WS_URL: "ws://localhost:9944",
    },
    waitToExit: false,
    type: "system-dependency",
    link: "http://localhost:6300",
    stopProcessAtPort: [6300],
    dependsOn: ["midnight-node"],
  },
  /** MIDNIGHT-PROOF-SERVER-BLOCK */
];

// GraphQL proxy (translates SDK v2.0.0 queries to indexer v3 schema)
// This is necessary because SDK v2.0.0 expects 'contractAction' but indexer v3 has 'contract'
const graphqlProxyProcesses = useBatcherMode && !useTypescriptContract ? [
  /** GRAPHQL-PROXY-BLOCK */
  {
    name: "graphql-proxy",
    args: [
      "run", "-A", "--unstable-detect-cjs",
      graphqlProxyScript,
    ],
    env: {
      INDEXER_HTTP_URL: "http://127.0.0.1:8088/api/v3/graphql",
      INDEXER_WS_URL: "ws://127.0.0.1:8088/api/v3/graphql/ws",
    },
    waitToExit: false,
    type: "system-dependency",
    link: "http://localhost:8089",
    stopProcessAtPort: [8089],
    // Only depend on indexer if we're managing it here
    dependsOn: skipMidnightInfra ? [] : ["midnight-indexer"],
  },
  /** GRAPHQL-PROXY-BLOCK */
] : [];

// Note: The old midnight-batcher (ts-batcher on port 8000) has been removed.
// Midnight transactions are now handled by the Paima batcher (@go-fish/batcher on port 3336)
// which uses MidnightAdapter for Midnight blockchain integration.

// Midnight contract deployment (runs after infrastructure is ready)
// Only deploys if DEPLOY_MIDNIGHT_CONTRACT=true AND we're managing the infra (not SKIP_MIDNIGHT_INFRA)
// Using MIDNIGHT_DEPLOY_VERIFIER_KEYS_LIMIT=1 for faster deployment (only 1 verifier key)
// Note: If using SKIP_MIDNIGHT_INFRA, the contract was already deployed by midnight:setup
const midnightContractDeployment = deployMidnightContract && useBatcherMode && !useTypescriptContract && !skipMidnightInfra ? [
  {
    name: "midnight-contract-deploy",
    args: [
      "--unstable-detect-cjs", "-A",
      "deploy.ts",
    ],
    env: {
      MIDNIGHT_DEPLOY_VERIFIER_KEYS_LIMIT: "1",  // Quick deploy - only upload 1 verifier key
    },
    cwd: midnightContractsDir,  // Run from the midnight contracts directory
    waitToExit: true,  // Wait for deployment to complete before starting batcher
    type: "system-dependency",
    dependsOn: ["midnight-proof-server", "midnight-indexer"],
  },
] : [];

// Debug: log which processes will be launched
console.log(`[Orchestrator] midnightProcesses: ${midnightProcesses.length} processes`);
console.log(`[Orchestrator] graphqlProxyProcesses: ${graphqlProxyProcesses.length} processes`);

const customProcesses = [
  // Midnight infrastructure (skipped when USE_TYPESCRIPT_CONTRACT=true)
  ...midnightProcesses,
  // Deploy Midnight contract after infrastructure is ready (only in batcher mode)
  ...midnightContractDeployment,
  // GraphQL proxy for SDK v2 to indexer v3 translation (only when USE_BATCHER_MODE=true)
  ...graphqlProxyProcesses,

  /** FRONTEND-BLOCK */
  {
    name: "install-frontend",
    command: "npm",
    cwd: "../../frontend/",
    args: ["install"],
    waitToExit: true,
    type: "system-dependency",
    dependsOn: [],
  },
  {
    name: "serve-frontend",
    command: "npm",
    cwd: "../../frontend",
    // Use batcher mode script when USE_BATCHER_MODE=true (no Lace wallet needed)
    args: useBatcherMode ? ["run", "dev:batcher"] : ["run", "dev"],
    waitToExit: false,
    link: "http://localhost:3000",
    type: "system-dependency",
    dependsOn: useBatcherMode ? ["install-frontend", "batcher"] : ["install-frontend"],
    logs: "none",
  },
  /** FRONTEND-BLOCK */

  /** EXPLORER-BLOCK */
  {
    name: "explorer",
    args: ["run", "-A", "--unstable-detect-cjs", "@paimaexample/explorer"],
    waitToExit: false,
    type: "system-dependency",
    link: "http://localhost:10590",
    stopProcessAtPort: [10590],
  },
  /** EXPLORER-BLOCK */

  /** BATCHER-BLOCK */
  {
    name: "batcher",
    args: ["task", "-f", "@go-fish/batcher", "start"],
    waitToExit: false,
    type: "system-dependency",
    link: "http://localhost:3336",
    stopProcessAtPort: [3336],
    // Dependencies:
    // - If deploying contract: wait for deployment
    // - If midnight infra managed here: wait for proof server
    // - If midnight infra external (SKIP_MIDNIGHT_INFRA): no midnight dependencies
    dependsOn: deployMidnightContract && useBatcherMode && !useTypescriptContract && !skipMidnightInfra
      ? ["midnight-contract-deploy"]
      : (useBatcherMode && !useTypescriptContract && !skipMidnightInfra ? ["midnight-proof-server"] : []),
  },
  /** BATCHER-BLOCK */
];

const config = Value.Parse(OrchestratorConfig, {
  // Launch system processes
  packageName: "jsr:@paimaexample",
  processes: {
    [ComponentNames.TMUX]: true,
    [ComponentNames.TUI]: true,
    // Launch Dev DB & Collector (skip pglite if SKIP_PGLITE=true)
    [ComponentNames.EFFECTSTREAM_PGLITE]: !skipPglite,
    [ComponentNames.COLLECTOR]: true,
  },

  // Launch my processes
  processesToLaunch: [
    // Launch EVM contracts (Hardhat node + deploy)
    // Skip if SKIP_EVM_LAUNCH=true (when using external Hardhat instance)
    ...(skipEvmLaunch ? [] : launchEvm("@go-fish/evm-contracts").map(p => {
      // QUIET_LOGS=true: suppress hardhat chain logs (evmMain, evmParallel, block-merge, etc.)
      if (!quietLogs) return p;
      const q: typeof p = { ...p, logs: "none" };
      return q;
    })),
    ...customProcesses,
  ],
});

if (Deno.env.get("EFFECTSTREAM_STDOUT")) {
  config.logs = "stdout";
  config.processes[ComponentNames.TMUX] = false;
  config.processes[ComponentNames.TUI] = false;
  config.processes[ComponentNames.COLLECTOR] = false;
}

// Write runtime config file for the backend to read
// This is needed because env vars don't always propagate through the orchestrator
const runtimeConfig = {
  useTypescriptContract: Deno.env.get("USE_TYPESCRIPT_CONTRACT") === "true",
  useBatcherMode: Deno.env.get("USE_BATCHER_MODE") === "true",
};
const configPath = new URL("../runtime-config.json", import.meta.url);
await Deno.writeTextFile(configPath, JSON.stringify(runtimeConfig, null, 2));
console.log(`[Orchestrator] Runtime config written: useTypescriptContract=${runtimeConfig.useTypescriptContract}, useBatcherMode=${runtimeConfig.useBatcherMode}`);

await start(config);

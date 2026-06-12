import { OrchestratorConfig, start } from "@effectstream/orchestrator";
import { ComponentNames } from "@effectstream/log";
import { Value } from "@sinclair/typebox/value";
import { launchEvm } from "@effectstream/orchestrator/start-evm";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// Get absolute path to the midnight contracts directory
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const midnightContractsDir = path.resolve(__dirname, "../../../shared/contracts/midnight");
const indexerConfigPath = path.join(midnightContractsDir, "indexer-standalone/config.yaml");
// Path to cleanup script for indexer database
const cleanupIndexerScript = path.resolve(__dirname, "cleanup-indexer-db.ts");


// Midnight infrastructure processes (skipped when using TypeScript contract or SKIP_MIDNIGHT_INFRA=true)
const midnightProcesses = [
  /** MIDNIGHT-NODE-BLOCK */
  {
    name: "midnight-node",
    args: [
      "run", "-A", "--unstable-detect-cjs",
      "npm:@effectstream/npm-midnight-node@0.9.0",
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
      "npm:@effectstream/npm-midnight-indexer@0.9.0",
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
      "npm:@effectstream/npm-midnight-proof-server@0.9.0"
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

// Note: The old midnight-batcher (ts-batcher on port 8000) has been removed.
// Midnight transactions are now handled by the Paima batcher (@go-fish/batcher on port 3336)
// which uses MidnightAdapter for Midnight blockchain integration.

// Midnight contract deployment (runs after infrastructure is ready)
// Only deploys if DEPLOY_MIDNIGHT_CONTRACT=true AND we're managing the infra (not SKIP_MIDNIGHT_INFRA)
// Using MIDNIGHT_DEPLOY_VERIFIER_KEYS_LIMIT=1 for faster deployment (only 1 verifier key)
// Note: If using SKIP_MIDNIGHT_INFRA, the contract was already deployed by midnight:setup
const midnightContractDeployment = [
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
];


const customProcesses = [
  // Midnight infrastructure (skipped when USE_TYPESCRIPT_CONTRACT=true)
  ...midnightProcesses,
  // Deploy Midnight contract after infrastructure is ready (only in batcher mode)
  ...midnightContractDeployment,

  /** FRONTEND-BLOCK */
  // {
  //   name: "install-frontend",
  //   command: "npm",
  //   cwd: "../../frontend/",
  //   args: ["install"],
  //   waitToExit: true,
  //   type: "system-dependency",
  //   dependsOn: [],
  // },
  // {
  //   name: "serve-frontend",
  //   command: "npm",
  //   cwd: "../../frontend",
  //   // Use batcher mode script when USE_BATCHER_MODE=true (no Lace wallet needed)
  //   args: useBatcherMode ? ["run", "dev:batcher"] : ["run", "dev"],
  //   waitToExit: false,
  //   link: "http://localhost:3000",
  //   type: "system-dependency",
  //   dependsOn: useBatcherMode ? ["install-frontend", "batcher"] : ["install-frontend"],
  //   logs: "none",
  // },
  /** FRONTEND-BLOCK */

  /** EXPLORER-BLOCK */
  // {
  //   name: "explorer",
  //   args: ["run", "-A", "--unstable-detect-cjs", "@effectstream/explorer"],
  //   waitToExit: false,
  //   type: "system-dependency",
  //   link: "http://localhost:10590",
  //   stopProcessAtPort: [10590],
  // },
  /** EXPLORER-BLOCK */

  /** BATCHER-BLOCK */
  {
    name: "batcher",
    args: ["run", "--filter", "@go-fish/batcher", "start"],
    waitToExit: false,
    type: "system-dependency",
    link: "http://localhost:3336",
    stopProcessAtPort: [3336],
    // Dependencies:
    // - If deploying contract: wait for deployment
    // - If midnight infra managed here: wait for proof server
    // - If midnight infra external (SKIP_MIDNIGHT_INFRA): no midnight dependencies
    dependsOn: 
      // ["midnight-proof-server"],
      ["midnight-contract-deploy"],
  },
  /** BATCHER-BLOCK */
];

const config = Value.Parse(OrchestratorConfig, {
  // Launch system processes
  packageName: "@effectstream",
  processes: {
    [ComponentNames.TMUX]: true,
    [ComponentNames.TUI]: true,
    [ComponentNames.EFFECTSTREAM_PGLITE]: true,
    [ComponentNames.COLLECTOR]: true,
  },

  // Launch my processes
  processesToLaunch: [
    // Launch EVM contracts (Hardhat node + deploy)
    // Skip if SKIP_EVM_LAUNCH=true (when using external Hardhat instance)
    ...launchEvm("@go-fish/evm-contracts"),
    ...customProcesses,
  ],
});

if (process.env.EFFECTSTREAM_STDOUT) {
  config.logs = "stdout";
  config.processes[ComponentNames.TMUX] = false;
  config.processes[ComponentNames.TUI] = false;
  config.processes[ComponentNames.COLLECTOR] = false;
}

await start(config);

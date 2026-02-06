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

// Path to midnight-batcher wrapper script (waits for indexer before starting)
const midnightBatcherScript = path.resolve(__dirname, "start-midnight-batcher.ts");

// Midnight infrastructure processes (only when not using TypeScript contract)
const midnightProcesses = useTypescriptContract ? [] : [
  /** MIDNIGHT-NODE-BLOCK */
  {
    name: "midnight-node",
    args: [
      "run", "-A", "--unstable-detect-cjs",
      "npm:@paimaexample/npm-midnight-node@0.3.129",
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

  /** MIDNIGHT-INDEXER-BLOCK */
  {
    name: "midnight-indexer",
    args: [
      "run", "-A", "--unstable-detect-cjs",
      "npm:@paimaexample/npm-midnight-indexer@0.3.129",
      "--binary", "--clean"
    ],
    env: {
      CONFIG_FILE: indexerConfigPath,
      LEDGER_NETWORK_ID: "Undeployed",
      SUBSTRATE_NODE_WS_URL: "ws://localhost:9944",
      // Secret must be at least 32 bytes (64 hex chars) - generate two UUIDs
      APP__INFRA__SECRET: (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, "").toUpperCase(),
      FEATURES_WALLET_ENABLED: "true",
      APP__INFRA__NODE__URL: "ws://localhost:9944",
    },
    waitToExit: false,
    type: "system-dependency",
    link: "http://localhost:8088",
    stopProcessAtPort: [8088],
    dependsOn: ["midnight-node"],
  },
  /** MIDNIGHT-INDEXER-BLOCK */

  /** MIDNIGHT-PROOF-SERVER-BLOCK */
  {
    name: "midnight-proof-server",
    args: [
      "run", "-A", "--unstable-detect-cjs",
      "npm:@paimaexample/npm-midnight-proof-server@0.3.129"
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

// Midnight batcher service (only when batcher mode is enabled)
// This is a Rust service that handles Midnight ZK transactions without requiring Lace wallet
// Uses a wrapper script that waits for the indexer to be ready before starting
const midnightBatcherProcesses = useBatcherMode && !useTypescriptContract ? [
  /** MIDNIGHT-BATCHER-BLOCK */
  {
    name: "midnight-batcher",
    args: [
      "run", "-A", "--unstable-detect-cjs",
      midnightBatcherScript,
    ],
    waitToExit: false,
    type: "system-dependency",
    link: "http://localhost:8000",
    stopProcessAtPort: [8000],
    dependsOn: ["midnight-node", "midnight-indexer"],
  },
  /** MIDNIGHT-BATCHER-BLOCK */
] : [];

const customProcesses = [
  // Midnight infrastructure (skipped when USE_TYPESCRIPT_CONTRACT=true)
  ...midnightProcesses,
  // Midnight batcher for wallet-less mode (only when USE_BATCHER_MODE=true)
  ...midnightBatcherProcesses,

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
    dependsOn: useBatcherMode ? ["install-frontend", "midnight-batcher"] : ["install-frontend"],
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
    link: "http://localhost:3334",
    stopProcessAtPort: [3334],
    dependsOn: [],
  },
  /** BATCHER-BLOCK */
];

const config = Value.Parse(OrchestratorConfig, {
  // Launch system processes
  packageName: "jsr:@paimaexample",
  processes: {
    [ComponentNames.TMUX]: true,
    [ComponentNames.TUI]: true,
    // Launch Dev DB & Collector
    [ComponentNames.EFFECTSTREAM_PGLITE]: true,
    [ComponentNames.COLLECTOR]: true,
  },

  // Launch my processes
  processesToLaunch: [
    // Launch EVM contracts (Hardhat node + deploy)
    ...launchEvm("@go-fish/evm-contracts"),
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

/**
 * Midnight Infrastructure Setup & Contract Deployment
 *
 * This script starts the Midnight node, indexer, proof server, and deploys the contract.
 * Run this once before starting the dev server in batcher mode.
 *
 * Usage:
 *   deno task midnight:setup    # Start infrastructure and deploy contract
 *
 * The Midnight infrastructure will keep running after deployment completes.
 * Use Ctrl+C to stop when you're done developing.
 *
 * Note: This takes ~6 minutes for contract deployment. Once deployed, the contract
 * address is saved to go-fish-contract.undeployed.json and the dev server can
 * connect to the existing contract without redeploying.
 */

import { OrchestratorConfig, start } from "@paimaexample/orchestrator";
import { ComponentNames } from "@paimaexample/log";
import { Value } from "@sinclair/typebox/value";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// Get absolute path to the midnight contracts directory
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const midnightContractsDir = path.resolve(__dirname, "../../../shared/contracts/midnight");

console.log("🌙 Starting Midnight Infrastructure Setup...");
console.log("   This will start the node, indexer, proof server, and deploy the contract.");
console.log("   Contract deployment takes ~6 minutes.\n");

const config = Value.Parse(OrchestratorConfig, {
  packageName: "jsr:@paimaexample",
  processes: {
    [ComponentNames.TMUX]: true,
    [ComponentNames.TUI]: true,
  },

  processesToLaunch: [
    // Midnight Node
    {
      name: "midnight-node",
      args: [
        "run", "-A", "--unstable-detect-cjs",
        "npm:@paimaexample/npm-midnight-node@0.9.0",
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

    // Cleanup stale indexer database
    {
      name: "cleanup-indexer-db",
      args: [
        "run", "-A", "--unstable-detect-cjs",
        path.resolve(__dirname, "cleanup-indexer-db.ts"),
      ],
      waitToExit: true,
      type: "system-dependency",
      dependsOn: ["midnight-node"],
    },

    // Midnight Indexer
    {
      name: "midnight-indexer",
      args: [
        "run", "-A", "--unstable-detect-cjs",
        "npm:@paimaexample/npm-midnight-indexer@0.9.0",
        "--standalone",
        "--binary",
      ],
      env: {
        LEDGER_NETWORK_ID: "Undeployed",
        SUBSTRATE_NODE_WS_URL: "ws://localhost:9944",
        APP__INFRA__SECRET: "0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF",
      },
      waitToExit: false,
      type: "system-dependency",
      link: "http://localhost:8088",
      stopProcessAtPort: [8088],
      dependsOn: ["cleanup-indexer-db"],
    },

    // Midnight Proof Server
    {
      name: "midnight-proof-server",
      args: [
        "run", "-A", "--unstable-detect-cjs",
        "npm:@paimaexample/npm-midnight-proof-server@0.9.0"
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

    // Deploy Contract (waits for completion)
    {
      name: "midnight-contract-deploy",
      args: ["--unstable-detect-cjs", "-A", "deploy.ts"],
      env: {
        MIDNIGHT_DEPLOY_VERIFIER_KEYS_LIMIT: "1",  // Quick deploy
      },
      cwd: midnightContractsDir,
      waitToExit: true,
      type: "system-dependency",
      dependsOn: ["midnight-proof-server", "midnight-indexer"],
    },

    // Keep-alive process - waits forever to keep the orchestrator running
    // This shows a message and then sleeps indefinitely
    {
      name: "keep-alive",
      command: "sh",
      args: ["-c", "echo '✅ Midnight infrastructure ready! Contract deployed.' && echo '   Keep this running and start SKIP_MIDNIGHT_INFRA=true USE_BATCHER_MODE=true deno task dev in another terminal.' && echo '   Press Ctrl+C to stop.' && while true; do sleep 86400; done"],
      waitToExit: true,  // Keep the orchestrator alive
      type: "system-dependency",
      dependsOn: ["midnight-contract-deploy"],
    },
  ],
});

if (Deno.env.get("EFFECTSTREAM_STDOUT")) {
  config.logs = "stdout";
  config.processes[ComponentNames.TMUX] = false;
  config.processes[ComponentNames.TUI] = false;
}

await start(config);

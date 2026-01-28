/**
 * Development entry point for Paima Engine node
 *
 * Environment Variables:
 *   USE_TYPESCRIPT_CONTRACT=true - Use local TypeScript-compiled contract (testing)
 *   (default) - Use deployed Midnight contract (production)
 */

import { init, start } from "@paimaexample/runtime";
import { main, suspend } from "effection";
import { config } from "@go-fish/data-types/config-dev";
import {
  toSyncProtocolWithNetwork,
  withEffectstreamStaticConfig,
} from "@paimaexample/config";
import { migrationTable } from "@go-fish/database";
import { gameStateTransitions } from "./state-machine.ts";
import { apiRouter } from "./api.ts";
import { grammar } from "@go-fish/data-types/grammar";
import { initializeQueryContract } from "./midnight-query.ts";
import { initializeActionContract } from "./midnight-actions.ts";

// Check if we should use the TypeScript-compiled contract (for local testing)
const USE_TYPESCRIPT_CONTRACT = Deno.env.get("USE_TYPESCRIPT_CONTRACT") === "true";

main(function* () {
  yield* init();
  console.log("Starting Go Fish Game - Paima Engine Node (Development Mode)");

  if (USE_TYPESCRIPT_CONTRACT) {
    console.log("📝 Using TypeScript-compiled contract (local testing mode)");

    // Initialize Midnight query contract (async init before starting server)
    initializeQueryContract()
      .then(() => console.log("✓ Midnight query contract initialized (TypeScript mode)"))
      .catch((error) => {
        console.error("⚠ Failed to initialize Midnight query contract:", error);
        console.error("  Game state queries will return fallback values");
      });

    // Initialize Midnight action contract
    initializeActionContract()
      .then(() => console.log("✓ Midnight action contract initialized (TypeScript mode)"))
      .catch((error) => {
        console.error("⚠ Failed to initialize Midnight action contract:", error);
        console.error("  Midnight actions will not be available");
      });
  } else {
    console.log("🌙 Using deployed Midnight contract (production mode)");
    console.log("   Backend will query indexer for contract state");
    console.log("   Frontend should connect via Lace wallet for transactions");

    // In production mode, backend acts as a read-only state synchronizer
    // It queries the indexer for contract state but does NOT execute circuits
    // All write operations (transactions) go through the frontend via Lace wallet
    initializeQueryContract()
      .then(() => console.log("✓ Midnight indexer connection ready"))
      .catch((error) => {
        console.error("⚠ Failed to connect to Midnight indexer:", error);
        console.error("  Ensure indexer is running: deno task midnight:indexer");
      });
  }

  yield* withEffectstreamStaticConfig(config, function* () {
    yield* start({
      appName: "go-fish-game",
      appVersion: "0.1.0",
      syncInfo: toSyncProtocolWithNetwork(config),
      gameStateTransitions,
      migrations: migrationTable,
      apiRouter,
      grammar,
      userDefinedPrimitives: {},
    });
  });

  yield* suspend();
});

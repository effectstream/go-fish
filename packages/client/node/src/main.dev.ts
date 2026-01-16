/**
 * Development entry point for Paima Engine node
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

main(function* () {
  yield* init();
  console.log("Starting Go Fish Game - Paima Engine Node (Development Mode)");

  // Initialize Midnight query contract (async init before starting server)
  initializeQueryContract()
    .then(() => console.log("✓ Midnight query contract initialized"))
    .catch((error) => {
      console.error("⚠ Failed to initialize Midnight query contract:", error);
      console.error("  Game state queries will return fallback values");
    });

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

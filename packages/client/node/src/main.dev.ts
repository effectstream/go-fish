/**
 * Development entry point for Paima Engine node
 */

import { init, start } from "@paimaexample/runtime";
import { main, suspend } from "effection";
import { config } from "@werewolf/data-types/config-dev";
import {
  toSyncProtocolWithNetwork,
  withEffectstreamStaticConfig,
} from "@paimaexample/config";
import { migrationTable } from "@werewolf/database";
import { gameStateTransitions } from "./state-machine.ts";
import { apiRouter } from "./api.ts";
import { grammar } from "@werewolf/data-types/grammar";

main(function* () {
  yield* init();
  console.log("Starting Werewolf Game - Paima Engine Node (Development Mode)");

  yield* withEffectstreamStaticConfig(config, function* () {
    yield* start({
      appName: "werewolf-game",
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

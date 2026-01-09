/**
 * Transaction Batcher - Batches user transactions to reduce on-chain costs
 */

import { main, suspend } from "effection";
import { createNewBatcher } from "@paimaexample/batcher";
import { config, storage } from "./config.ts";
import { effectstreaml2Adapter } from "./adapter-effectstreaml2.ts";

const batcher = createNewBatcher(config, storage);
const batchIntervalMs = 100;

batcher
  .addBlockchainAdapter("effectstreaml2", effectstreaml2Adapter, {
    criteriaType: "time",
    timeWindowMs: batchIntervalMs,
  })
  .setDefaultTarget("effectstreaml2");

// Startup banner via state transition
batcher
  .addStateTransition("startup", ({ publicConfig }) => {
    const banner =
      `🎮 Werewolf Batcher startup - polling every ${publicConfig.pollingIntervalMs} ms\n` +
      `      | 📍 Default Target: ${publicConfig.defaultTarget}\n` +
      `      | ⛓️ Blockchain Adapter Targets: ${publicConfig.adapterTargets.join(", ")}\n` +
      `      | 📋 Press Ctrl+C to stop gracefully`;
    console.log(banner);
  })
  .addStateTransition("http:start", ({ port }) => {
    const publicConfig = batcher.getPublicConfig();
    const httpInfo =
      `🌐 HTTP Server started\n` +
      `      | URL: http://localhost:${port}\n` +
      `      | Confirmation: ${publicConfig.confirmationLevel}\n` +
      `      | Events Enabled: ${publicConfig.enableEventSystem}\n` +
      `      | Polling: ${publicConfig.pollingIntervalMs} ms`;
    console.log(httpInfo);
  });

main(function* () {
  console.log("🚀 Starting Werewolf Batcher...");
  try {
    yield* batcher.runBatcher();
  } catch (error) {
    console.error("❌ Batcher error:", error);
    yield* batcher.gracefulShutdownOp();
  }
  yield* suspend();
});

/**
 * Go Fish Transaction Batcher
 *
 * Batches user transactions for both EffectStream L2 and Midnight networks.
 */

import { main, suspend } from "effection";
import { createNewBatcher } from "@effectstream/batcher-sdk";
import { config, storage, BATCHER_DATA_DIR } from "./config.ts";
import { rm } from "node:fs/promises";

import { midnightBalancingAdapter } from "./adapter-midnight-balancing.ts";
import { effectstreaml2Adapter } from "./adapter-effectstreaml2.ts";

try {
  await rm(BATCHER_DATA_DIR, { recursive: true, force: true });
  console.log("🧹 Cleared stale batcher data from previous session");
} catch (error) {
  console.warn("⚠️ Could not clear batcher data:", error);
}

const batcher = createNewBatcher(config, storage);
const batchIntervalMs = 100;

batcher
  .addBlockchainAdapter("effectstreaml2", effectstreaml2Adapter, {
    criteriaType: "time",
    timeWindowMs: batchIntervalMs,
  })
  .addBlockchainAdapter("midnight_balancing", midnightBalancingAdapter, {
    criteriaType: "time",
    timeWindowMs: batchIntervalMs,
  })
  .setDefaultTarget("effectstreaml2");

batcher
  .addStateTransition("startup", ({ publicConfig }) => {
    const banner =
      `🎮 Go Fish Batcher startup - polling every ${publicConfig.pollingIntervalMs} ms\n` +
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
      `      | Confirmation: ${JSON.stringify(publicConfig.confirmationLevel)}\n` +
      `      | Events Enabled: ${publicConfig.enableEventSystem}\n` +
      `      | Polling: ${publicConfig.pollingIntervalMs} ms`;
    console.log(httpInfo);
  });

main(function* () {
  console.log("🚀 Starting Go Fish Batcher...");
  try {
    yield* batcher.runBatcher();
  } catch (error) {
    console.error("❌ Batcher error:", error);
    yield* batcher.gracefulShutdownOp();
  }
  yield* suspend();
});

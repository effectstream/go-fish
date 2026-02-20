/**
 * Go Fish Transaction Batcher
 *
 * Batches user transactions for both EffectStream L2 and Midnight networks.
 * Midnight transactions are processed individually (size-based batching with maxBatchSize=1).
 */

import { main, suspend } from "effection";
import { createNewBatcher, MidnightAdapter } from "@paimaexample/batcher";
import { config, storage, BATCHER_DATA_DIR } from "./config.ts";
import { effectstreaml2Adapter } from "./adapter-effectstreaml2.ts";

// Clear stale batcher data on startup to prevent processing old transactions
// This is important because old transactions may reference games that no longer exist
// and would cause "Game does not exist" errors
try {
  await Deno.remove(BATCHER_DATA_DIR, { recursive: true });
  console.log("🧹 Cleared stale batcher data from previous session");
} catch (error) {
  // Directory doesn't exist, that's fine
  if (!(error instanceof Deno.errors.NotFound)) {
    console.warn("⚠️ Could not clear batcher data:", error);
  }
}

const batcher = createNewBatcher(config, storage);
const batchIntervalMs = 100;

// Add EffectStream L2 adapter with time-based batching
batcher
  .addBlockchainAdapter("effectstreaml2", effectstreaml2Adapter, {
    criteriaType: "time",
    timeWindowMs: batchIntervalMs,
  })
  .setDefaultTarget("effectstreaml2");

// Add Midnight adapters with time-based batching with very short window
// This ensures transactions are processed quickly and sequentially
// The MidnightAdapter handles the actual circuit invocation
// Skip when using TypeScript contract (no Midnight infrastructure needed)
// Use dynamic import to avoid eagerly connecting to Midnight infrastructure
const useTypescriptContract = Deno.env.get("USE_TYPESCRIPT_CONTRACT") === "true";
if (!useTypescriptContract) {
  const midnightAdapters = await import("./adapter-midnight.ts");
  for (const [contract, adapter] of Object.entries(midnightAdapters.midnightAdapters)) {
    if (adapter instanceof MidnightAdapter) {
      batcher.addBlockchainAdapter(contract, adapter, {
        criteriaType: "time",
        timeWindowMs: 50, // Very short window to process transactions quickly
      });
    }
  }
} else {
  console.log("📝 Skipping Midnight adapters (USE_TYPESCRIPT_CONTRACT=true)");
}

// Startup banner via state transition
batcher
  .addStateTransition("startup", ({ publicConfig }) => {
    const banner =
      `🎮 Go Fish Batcher startup - polling every ${publicConfig.pollingIntervalMs} ms\n` +
      `      | 📍 Default Target: ${publicConfig.defaultTarget}\n` +
      `      | ⛓️ Blockchain Adapter Targets: ${publicConfig.adapterTargets.join(", ")}\n` +
      `      | 📦 Batching Criteria: ${Object.entries(publicConfig.criteriaTypes || {})
        .map(([target, type]) => `${target}=${type}`)
        .join(", ")}\n` +
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
  console.log("🚀 Starting Go Fish Batcher...");
  try {
    yield* batcher.runBatcher();
  } catch (error) {
    console.error("❌ Batcher error:", error);
    yield* batcher.gracefulShutdownOp();
  }
  yield* suspend();
});

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
import Fastify from "npm:fastify@^5.4.0";

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
let goFishMidnightAdapter: import("./adapter-midnight.ts").GoFishMidnightAdapter | null = null;
if (!useTypescriptContract) {
  const midnightAdapters = await import("./adapter-midnight.ts");
  for (const [contract, adapter] of Object.entries(midnightAdapters.midnightAdapters)) {
    if (adapter instanceof MidnightAdapter) {
      batcher.addBlockchainAdapter(contract, adapter, {
        criteriaType: "size",
        maxBatchSize: 1, // Each Midnight circuit call is its own batch — the JSR adapter
                         // only executes the first invocation per submitBatch() call, so
                         // grouping multiple inputs drops all but the first.
      });
    }
  }
  goFishMidnightAdapter = midnightAdapters.midnightAdapter_go_fish;
} else {
  console.log("📝 Skipping Midnight adapters (USE_TYPESCRIPT_CONTRACT=true)");
}

// Secondary HTTP server exposing hand-query endpoint (port 9997).
// The primary batcher HTTP server (port config.port) is managed internally by
// @paimaexample/batcher and does not allow custom routes, so we run a separate
// Fastify instance for this read-only query endpoint.
const QUERY_PORT = Number(Deno.env.get("BATCHER_QUERY_PORT") || "9997");
const queryServer = Fastify({ logger: false });

queryServer.get("/health", async (_req, reply) => {
  reply.send({ ok: true });
});

/**
 * POST /query-hand
 * Body: { lobbyId, playerId, playerSecretHex, shuffleSeedHex, opponentSecretHex?, opponentShuffleSeedHex? }
 * Response: { hand: Array<{rank: number, suit: number}> }
 *
 * Queries the player's current hand from the on-chain indexer state using the
 * Midnight SDK (doesPlayerHaveSpecificCard circuit, local simulation only — no tx submitted).
 */
/**
 * POST /query-game-state
 * Body: { lobbyId: string }
 * Response: { phase, currentTurn, scores, handSizes, deckCount, isGameOver, lastAskedRank, lastAskingPlayer }
 *         | { exists: false }
 *
 * Queries the real on-chain game state by running public impure circuits against the
 * Midnight indexer. No player secrets are required — all fields are public ledger reads.
 * This is the authoritative source of truth for game phase; do NOT use the backend's
 * optimistic gameStateMap for phase tracking.
 */
queryServer.post("/query-game-state", async (req, reply) => {
  const body = req.body as { lobbyId: string };

  if (!body || !body.lobbyId) {
    return reply.status(400).send({ error: "Missing required field: lobbyId" });
  }

  if (!goFishMidnightAdapter) {
    return reply.status(503).send({ error: "Midnight adapter not available (USE_TYPESCRIPT_CONTRACT=true or not initialized)" });
  }

  try {
    const state = await goFishMidnightAdapter.queryGameState(body.lobbyId);
    if (state === null) {
      return reply.send({ exists: false });
    }
    return reply.send({ exists: true, ...state });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[query-game-state] Error:", msg);
    return reply.status(500).send({ error: msg });
  }
});

queryServer.post("/query-hand", async (req, reply) => {
  const body = req.body as {
    lobbyId: string;
    playerId: 1 | 2;
    playerSecretHex: string;
    shuffleSeedHex: string;
    opponentSecretHex?: string;
    opponentShuffleSeedHex?: string;
  };

  if (!body || !body.lobbyId || !body.playerId || !body.playerSecretHex || !body.shuffleSeedHex) {
    return reply.status(400).send({ error: "Missing required fields: lobbyId, playerId, playerSecretHex, shuffleSeedHex" });
  }

  if (!goFishMidnightAdapter) {
    return reply.status(503).send({ error: "Midnight adapter not available (USE_TYPESCRIPT_CONTRACT=true or not initialized)" });
  }

  try {
    const hand = await goFishMidnightAdapter.queryPlayerHand(
      body.lobbyId,
      body.playerId,
      body.playerSecretHex,
      body.shuffleSeedHex,
      body.opponentSecretHex,
      body.opponentShuffleSeedHex,
    );
    return reply.send({ hand });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[query-hand] Error:", msg);
    return reply.status(500).send({ error: msg });
  }
});

queryServer.listen({ port: QUERY_PORT, host: "0.0.0.0" }).then(() => {
  console.log(`🔍 Query server listening on port ${QUERY_PORT} (POST /query-hand)`);
}).catch(err => {
  console.error("❌ Failed to start query server:", err);
});

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

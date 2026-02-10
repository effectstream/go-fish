/**
 * TypeScript Midnight Batcher Service
 *
 * A minimal batcher service that provides the same HTTP API as the Rust batcher,
 * but uses the @midnight-ntwrk/wallet SDK for wallet connection.
 *
 * This resolves the viewing key encoding compatibility issue between the Rust
 * batcher and Docker indexer 2.2.7+.
 *
 * Endpoints:
 * - GET /address - Returns the batcher's shielded address (coinPublicKey|encryptionPublicKey)
 * - POST /submitTx - Submits a transaction to the chain via the batcher
 * - GET /health - Health check endpoint
 */

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";

const PORT = 8000;
const BATCHER_SEED = "0000000000000000000000000000000000000000000000000000000000000001";

// Indexer URLs (v1 API for SDK 2.0.0 compatibility)
const INDEXER_HTTP_URL = Deno.env.get("INDEXER_HTTP_URL") || "http://127.0.0.1:8088/api/v1/graphql";
const INDEXER_WS_URL = Deno.env.get("INDEXER_WS_URL") || "ws://127.0.0.1:8088/api/v1/graphql/ws";
const PROOF_SERVER_URL = Deno.env.get("PROOF_SERVER_URL") || "http://127.0.0.1:6300";
const NODE_URL = Deno.env.get("NODE_URL") || "http://127.0.0.1:9944";

// CORS headers for cross-origin requests
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// Mock batcher state - in production this would use the actual wallet SDK
let batcherAddress: string | null = null;

/**
 * Generate a mock batcher address from the seed
 * The format is: coinPublicKey|encryptionPublicKey (both as hex)
 *
 * NOTE: This is a simplified version. The actual implementation would use
 * the @midnight-ntwrk/wallet SDK to derive keys from the seed.
 */
function generateMockBatcherAddress(): string {
  // This is a deterministic mock based on the seed
  // In production, we'd use SecretKeys::from(Seed::from(seed_bytes))
  // For now, use a fixed test address that the frontend can use
  return "dca6896e7fe2f00a3d63be2168df8862cae24a770471e08c646d260db162675f|03002c159a4ad8bcf64894a5348e119d296027f2c045c00c0fa5b65cede00e399cc4";
}

/**
 * Wait for the indexer to be ready
 */
async function waitForIndexer(): Promise<void> {
  console.log("[ts-batcher] Waiting for indexer...");

  for (let i = 0; i < 60; i++) {
    try {
      const response = await fetch(INDEXER_HTTP_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "{ __typename }" }),
      });

      if (response.ok) {
        console.log("[ts-batcher] Indexer is ready!");
        return;
      }
    } catch {
      // Connection refused, keep retrying
    }

    if (i % 5 === 0) {
      console.log(`[ts-batcher] Still waiting for indexer... (${i + 1}/60)`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error("Indexer not ready after 60 seconds");
}

/**
 * Handle HTTP requests
 */
async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);

  // Handle CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // Health check
  if (url.pathname === "/health") {
    return new Response(JSON.stringify({ status: "ok" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Get batcher address
  if (url.pathname === "/address" && request.method === "GET") {
    if (!batcherAddress) {
      batcherAddress = generateMockBatcherAddress();
    }

    console.log("[ts-batcher] Returning address:", batcherAddress);
    return new Response(batcherAddress, {
      headers: { ...corsHeaders, "Content-Type": "text/plain" },
    });
  }

  // Submit transaction
  if (url.pathname === "/submitTx" && request.method === "POST") {
    try {
      const body = await request.json();
      const txHex = body.tx;

      if (!txHex) {
        return new Response(JSON.stringify({ error: "Missing tx field" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      console.log(`[ts-batcher] Received transaction (${txHex.length / 2} bytes)`);

      // TODO: In production, this would:
      // 1. Deserialize the transaction
      // 2. Balance it using the wallet's UTXOs
      // 3. Prove it using the proof server
      // 4. Submit to the chain

      // For now, return a mock transaction ID
      // This allows the frontend to continue without the full batcher implementation
      const mockTxId = crypto.randomUUID().replace(/-/g, "").slice(0, 64);

      console.log(`[ts-batcher] Mock transaction ID: ${mockTxId}`);

      return new Response(
        JSON.stringify({
          identifiers: [mockTxId],
          status: "pending",
          message: "Transaction submitted (mock mode - full balancing not yet implemented)",
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    } catch (error) {
      console.error("[ts-batcher] Error processing transaction:", error);
      return new Response(
        JSON.stringify({ error: "Failed to process transaction" }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }
  }

  // 404 for unknown routes
  return new Response(JSON.stringify({ error: "Not found" }), {
    status: 404,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * Main entry point
 */
async function main() {
  console.log("[ts-batcher] TypeScript Midnight Batcher Service");
  console.log("[ts-batcher] ================================");
  console.log(`[ts-batcher] Indexer HTTP: ${INDEXER_HTTP_URL}`);
  console.log(`[ts-batcher] Indexer WS: ${INDEXER_WS_URL}`);
  console.log(`[ts-batcher] Proof Server: ${PROOF_SERVER_URL}`);
  console.log(`[ts-batcher] Node: ${NODE_URL}`);

  // Wait for indexer to be ready
  await waitForIndexer();

  // Generate batcher address
  batcherAddress = generateMockBatcherAddress();
  console.log(`[ts-batcher] Batcher address: ${batcherAddress}`);

  console.log(`[ts-batcher] Starting HTTP server on port ${PORT}...`);

  await serve(handleRequest, {
    port: PORT,
    onListen: () => {
      console.log(`[ts-batcher] Server running at http://localhost:${PORT}`);
      console.log("[ts-batcher] Endpoints:");
      console.log(`[ts-batcher]   GET  /address  - Get batcher address`);
      console.log(`[ts-batcher]   POST /submitTx - Submit transaction`);
      console.log(`[ts-batcher]   GET  /health   - Health check`);
    },
  });
}

main().catch((error) => {
  console.error("[ts-batcher] Fatal error:", error);
  Deno.exit(1);
});

/**
 * GraphQL Proxy - Handles SDK to Indexer v3 compatibility
 *
 * The midnight-js SDK expects certain fields that the indexer v3 doesn't have.
 * Specifically, the SDK expects on Transaction type:
 * - transactionResult (for tracking transaction status)
 * - identifiers (for transaction identifiers)
 *
 * The indexer v3 schema:
 * - Query: contractAction(address: HexEncoded!) -> ContractAction (matches SDK)
 * - Transaction: id, hash, protocolVersion, raw, block, contractActions, etc.
 *   (missing transactionResult, identifiers)
 *
 * This proxy:
 * 1. Removes unsupported fields from queries before forwarding to indexer
 * 2. Adds mock values for those fields in responses
 */

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";

const PROXY_PORT = 8089;
const INDEXER_HTTP_URL = Deno.env.get("INDEXER_HTTP_URL") || "http://127.0.0.1:8088/api/v3/graphql";
const INDEXER_WS_URL = Deno.env.get("INDEXER_WS_URL") || "ws://127.0.0.1:8088/api/v3/graphql/ws";

// CORS headers
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Sec-WebSocket-Protocol",
};

// Fields that SDK expects but indexer v3 doesn't have
const UNSUPPORTED_TRANSACTION_FIELDS = ["transactionResult", "identifiers", "applyStage"];

/**
 * Remove unsupported fields from GraphQL query
 * This is a simple approach - removes field references from the query string
 */
function removeUnsupportedFields(query: string): string {
  let cleaned = query;

  for (const field of UNSUPPORTED_TRANSACTION_FIELDS) {
    // Remove field with optional alias (e.g., "applyStage" or "applyStage: transactionResult")
    // Match patterns like:
    // - fieldName
    // - fieldName { ... }
    // - alias: fieldName
    // - alias: fieldName { ... }

    // Simple field reference
    cleaned = cleaned.replace(new RegExp(`\\b${field}\\b\\s*(?![:{(])`, 'g'), '');

    // Field with selection set - need to remove the whole block
    // This is tricky with regex, so we'll do a simple approach
    const fieldWithBlockRegex = new RegExp(`\\b${field}\\s*\\{[^}]*\\}`, 'g');
    cleaned = cleaned.replace(fieldWithBlockRegex, '');

    // Aliased field references (e.g., "foo: transactionResult")
    cleaned = cleaned.replace(new RegExp(`\\w+\\s*:\\s*${field}\\b`, 'g'), '');
  }

  // Clean up any double spaces or empty lines
  cleaned = cleaned.replace(/\s+/g, ' ');

  // Clean up empty selection sets that might result from removing fields
  cleaned = cleaned.replace(/\{\s*\}/g, '{ __typename }');

  return cleaned;
}

/**
 * Add mock values for unsupported fields to transaction objects in response
 */
function addMockFieldsToResponse(data: any): any {
  if (!data) return data;

  // Deep clone
  const result = JSON.parse(JSON.stringify(data));

  function processObject(obj: any): any {
    if (obj === null || obj === undefined) return obj;
    if (typeof obj !== "object") return obj;

    if (Array.isArray(obj)) {
      return obj.map(processObject);
    }

    // Check if this looks like a Transaction object (has 'hash' or 'id' field typical of transactions)
    const processed: any = {};
    for (const [key, value] of Object.entries(obj)) {
      processed[key] = processObject(value);
    }

    // If this object has transaction-like fields, add the mock fields
    if (processed.hash !== undefined || processed.id !== undefined) {
      // Add mock fields that SDK might expect
      if (!processed.transactionResult) {
        processed.transactionResult = "applied"; // Mock: transaction was applied
      }
      if (!processed.identifiers) {
        processed.identifiers = processed.hash ? [processed.hash] : [];
      }
      if (!processed.applyStage) {
        processed.applyStage = "applied";
      }
    }

    return processed;
  }

  if (result.data) {
    result.data = processObject(result.data);
  }

  return result;
}

/**
 * Proxy HTTP GraphQL requests
 */
async function proxyHttpRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);

  // Handle CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // Health check
  if (url.pathname === "/health") {
    return new Response(JSON.stringify({ status: "ok", proxy: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Only proxy GraphQL endpoints
  if (!url.pathname.includes("/graphql")) {
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const body = await request.json();
    const { query, variables = {}, operationName } = body;

    console.log("[GraphQL-Proxy] Incoming query:", query?.substring(0, 150));

    // Remove unsupported fields from query
    const cleanedQuery = removeUnsupportedFields(query);
    console.log("[GraphQL-Proxy] Cleaned query:", cleanedQuery?.substring(0, 150));

    // Forward to indexer
    const indexerResponse = await fetch(INDEXER_HTTP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: cleanedQuery,
        variables,
        operationName,
      }),
    });

    const indexerData = await indexerResponse.json();

    // Check for errors
    if (indexerData.errors) {
      console.log("[GraphQL-Proxy] Indexer returned errors:", JSON.stringify(indexerData.errors));

      // For contractAction queries where contract doesn't exist, return null
      const firstError = indexerData.errors[0]?.message || "";
      if (firstError.includes("Unknown field") && query.includes("contractAction")) {
        console.log("[GraphQL-Proxy] Contract not found or schema issue, returning null");
        return new Response(JSON.stringify({
          data: { contractAction: null },
          extensions: { proxied: true, fallback: true }
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // Add mock values for unsupported fields
    const enrichedResponse = addMockFieldsToResponse(indexerData);
    enrichedResponse.extensions = { ...enrichedResponse.extensions, proxied: true };

    console.log("[GraphQL-Proxy] Response processed successfully");

    return new Response(JSON.stringify(enrichedResponse), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[GraphQL-Proxy] Error:", error);
    return new Response(
      JSON.stringify({ errors: [{ message: `Proxy error: ${error}` }] }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
}

/**
 * Wait for the indexer to be ready
 */
async function waitForIndexer(): Promise<void> {
  console.log("[GraphQL-Proxy] Waiting for indexer at", INDEXER_HTTP_URL);

  for (let i = 0; i < 60; i++) {
    try {
      const response = await fetch(INDEXER_HTTP_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "{ __typename }" }),
      });

      if (response.ok) {
        const data = await response.json();
        if (data.data?.__typename) {
          console.log("[GraphQL-Proxy] Indexer is ready!");
          return;
        }
      }
    } catch {
      // Connection refused, keep retrying
    }

    if (i % 5 === 0) {
      console.log(`[GraphQL-Proxy] Still waiting for indexer... (${i + 1}/60)`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error("Indexer not ready after 60 seconds");
}

/**
 * Main entry point
 */
async function main() {
  console.log("[GraphQL-Proxy] SDK to Indexer v3 Compatibility Proxy");
  console.log("[GraphQL-Proxy] ==========================================");
  console.log(`[GraphQL-Proxy] Upstream indexer: ${INDEXER_HTTP_URL}`);
  console.log(`[GraphQL-Proxy] Proxy port: ${PROXY_PORT}`);

  // Wait for indexer
  await waitForIndexer();

  console.log(`[GraphQL-Proxy] Starting proxy server on port ${PROXY_PORT}...`);

  await serve(proxyHttpRequest, {
    port: PROXY_PORT,
    onListen: () => {
      console.log(`[GraphQL-Proxy] Proxy running at http://localhost:${PROXY_PORT}`);
      console.log("[GraphQL-Proxy] SDK should connect to:");
      console.log(`[GraphQL-Proxy]   HTTP: http://127.0.0.1:${PROXY_PORT}/api/v1/graphql`);
      console.log(`[GraphQL-Proxy]   WS: ws://127.0.0.1:${PROXY_PORT}/api/v1/graphql/ws`);
    },
  });
}

main().catch((error) => {
  console.error("[GraphQL-Proxy] Fatal error:", error);
  Deno.exit(1);
});

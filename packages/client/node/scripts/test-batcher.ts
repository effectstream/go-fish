#!/usr/bin/env -S deno run --allow-net --allow-env
/**
 * CLI test script: Sends circuit calls to the batcher and runs
 * through the full game setup flow (init_deck → applyMask × 2 → dealCards × 2).
 *
 * Usage:
 *   deno run --allow-net --allow-env packages/client/node/scripts/test-batcher.ts
 *
 * Prerequisites:
 *   - Midnight infra running (node, indexer, proof server)
 *   - Batcher running on port 3336
 *
 * This script does NOT use the frontend or backend — it talks directly to
 * the batcher's /send-input endpoint, just like BatcherMidnightService does.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const BATCHER_URL = Deno.env.get("BATCHER_URL") || "http://localhost:3336";
const INDEXER_URL = Deno.env.get("INDEXER_URL") || "http://localhost:8088/api/v3/graphql";
const TARGET = "go-fish";
const ADDRESS_TYPE_EVM = 0;
const CONFIRMATION_LEVEL = "wait-receipt";

// Two distinct "wallets" (just addresses — sig verification is skipped in dev)
const PLAYER1_ADDRESS = "0x1111111111111111111111111111111111111111";
const PLAYER2_ADDRESS = "0x2222222222222222222222222222222222222222";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a random bigint secret key (same range as the frontend PlayerKeyManager) */
function randomSecret(): bigint {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  let val = 0n;
  for (const b of buf) val = (val << 8n) | BigInt(b);
  // Keep it in a reasonable range — the contract just needs a non-zero scalar
  // BLS12-381 scalar field modulus (Midnight's actual ecMul modulus)
  return val % 52435875175126190479447740508185965837690552500527637822603658699938581184513n;
}

/** Generate a random 32-byte shuffle seed */
function randomSeed(): Uint8Array {
  const seed = new Uint8Array(32);
  crypto.getRandomValues(seed);
  return seed;
}

/** Convert bigint to 64-char hex string */
function bigintToHex(n: bigint): string {
  return n.toString(16).padStart(64, "0");
}

/** Convert Uint8Array to hex string */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

/** Convert a lobby/game ID string to 0x-prefixed hex Bytes<32> */
function lobbyIdToGameIdHex(lobbyId: string): string {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(lobbyId);
  const bytes = new Uint8Array(32);
  bytes.set(encoded.slice(0, 32));
  return "0x" + Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

/** Query indexer for latest block height */
async function getIndexerBlock(): Promise<number> {
  try {
    const res = await fetch(INDEXER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "{ block { height } }" }),
    });
    const data = await res.json();
    return data?.data?.block?.height ?? -1;
  } catch {
    return -1;
  }
}

/** Sleep for ms milliseconds */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Batcher RPC
// ---------------------------------------------------------------------------

interface CircuitCallResult {
  success: boolean;
  message?: string;
  transactionHash?: string;
  error?: string;
  rawResponse?: unknown;
}

async function callCircuit(
  circuit: string,
  args: unknown[],
  address: string,
  secrets?: { playerSecret: bigint; shuffleSeed: Uint8Array },
): Promise<CircuitCallResult> {
  const timestamp = Date.now();

  // Serialize bigints in args
  const serializedArgs = args.map(a => typeof a === "bigint" ? a.toString() : a);

  const circuitCall: Record<string, unknown> = { circuit, args: serializedArgs };
  if (secrets) {
    circuitCall.playerSecret = bigintToHex(secrets.playerSecret);
    circuitCall.shuffleSeed = bytesToHex(secrets.shuffleSeed);
  }

  const input = JSON.stringify(circuitCall);

  // Signature is skipped in dev mode, but the field must be present
  const body = {
    data: {
      target: TARGET,
      address,
      addressType: ADDRESS_TYPE_EVM,
      input,
      timestamp,
      signature: "0x" + "00".repeat(65),
    },
    confirmationLevel: CONFIRMATION_LEVEL,
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 600_000); // 10 min

  try {
    const res = await fetch(`${BATCHER_URL}/send-input`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const result = await res.json();
    if (res.ok) {
      return {
        success: true,
        message: result.message,
        transactionHash: result.transactionHash,
      };
    }
    return { success: false, error: result.message || JSON.stringify(result), rawResponse: result };
  } catch (err: unknown) {
    clearTimeout(timeoutId);
    if (err instanceof DOMException && err.name === "AbortError") {
      return { success: false, error: "Request timed out (10 min)" };
    }
    return { success: false, error: String(err) };
  }
}

// ---------------------------------------------------------------------------
// Test Steps
// ---------------------------------------------------------------------------

function logStep(step: string) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ${step}`);
  console.log("=".repeat(60));
}

function logResult(label: string, result: CircuitCallResult, startMs: number) {
  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  if (result.success) {
    console.log(`  ✓ ${label} succeeded (${elapsed}s) tx=${result.transactionHash ?? "?"}`);
  } else {
    console.log(`  ✗ ${label} FAILED (${elapsed}s): ${result.error}`);
  }
}

async function main() {
  const gameId = `test_${Date.now()}`;
  const gameIdHex = lobbyIdToGameIdHex(gameId);

  // Per-player secrets (consistent across applyMask and dealCards)
  const p1Secret = randomSecret();
  const p1Seed = randomSeed();
  const p2Secret = randomSecret();
  const p2Seed = randomSeed();

  console.log(`\nBatcher test — game: ${gameId}`);
  console.log(`  Batcher:  ${BATCHER_URL}`);
  console.log(`  Indexer:  ${INDEXER_URL}`);
  console.log(`  GameID:   ${gameIdHex}`);
  console.log(`  P1 addr:  ${PLAYER1_ADDRESS}`);
  console.log(`  P2 addr:  ${PLAYER2_ADDRESS}`);

  const block0 = await getIndexerBlock();
  console.log(`  Indexer block: ${block0}`);

  // ── Step 1: init_deck (P1) ──────────────────────────────────────────────
  logStep("Step 1: init_deck (Player 1)");
  let t = Date.now();
  const initResult = await callCircuit("init_deck", [], PLAYER1_ADDRESS);
  logResult("init_deck", initResult, t);
  if (!initResult.success) {
    // May already be initialized — check error
    if (initResult.error?.includes("already") || initResult.error?.includes("Static deck")) {
      console.log("  (deck already initialized — continuing)");
    } else {
      console.log("\n  ABORT: init_deck failed. Is the batcher running?");
      Deno.exit(1);
    }
  }

  // ── Step 2: applyMask — Player 1 ───────────────────────────────────────
  logStep("Step 2: applyMask (Player 1)");
  let block = await getIndexerBlock();
  console.log(`  Indexer block before: ${block}`);
  t = Date.now();
  const mask1 = await callCircuit(
    "applyMask",
    [gameIdHex, 1],
    PLAYER1_ADDRESS,
    { playerSecret: p1Secret, shuffleSeed: p1Seed },
  );
  logResult("applyMask P1", mask1, t);
  if (!mask1.success) {
    console.log("\n  ABORT: applyMask P1 failed");
    Deno.exit(1);
  }

  block = await getIndexerBlock();
  console.log(`  Indexer block after P1 mask: ${block}`);

  // ── Step 3: applyMask — Player 2 ───────────────────────────────────────
  logStep("Step 3: applyMask (Player 2)");
  t = Date.now();
  const mask2 = await callCircuit(
    "applyMask",
    [gameIdHex, 2],
    PLAYER2_ADDRESS,
    { playerSecret: p2Secret, shuffleSeed: p2Seed },
  );
  logResult("applyMask P2", mask2, t);
  if (!mask2.success) {
    console.log("\n  ABORT: applyMask P2 failed");
    Deno.exit(1);
  }

  block = await getIndexerBlock();
  console.log(`  Indexer block after P2 mask: ${block}`);

  // ── Step 4: Wait for indexer to catch up ────────────────────────────────
  logStep("Step 4: Waiting for indexer sync (15s)");
  console.log(`  Both masks confirmed on-chain. Waiting for indexer to catch up...`);
  await sleep(15_000);
  block = await getIndexerBlock();
  console.log(`  Indexer block after wait: ${block}`);

  // ── Step 5: dealCards — Player 1 ────────────────────────────────────────
  logStep("Step 5: dealCards (Player 1 — must go first)");
  t = Date.now();
  const deal1 = await callCircuit(
    "dealCards",
    [gameIdHex, 1],
    PLAYER1_ADDRESS,
    { playerSecret: p1Secret, shuffleSeed: p1Seed },
  );
  logResult("dealCards P1", deal1, t);
  if (!deal1.success) {
    console.log(`\n  dealCards P1 FAILED. This is the bug we're investigating.`);
    block = await getIndexerBlock();
    console.log(`  Indexer block at failure: ${block}`);
    console.log(`  Error: ${deal1.error}`);
    Deno.exit(1);
  }

  block = await getIndexerBlock();
  console.log(`  Indexer block after P1 deal: ${block}`);

  // ── Step 6: dealCards — Player 2 ────────────────────────────────────────
  logStep("Step 6: dealCards (Player 2)");
  console.log("  Waiting 15s for indexer sync...");
  await sleep(15_000);
  t = Date.now();
  const deal2 = await callCircuit(
    "dealCards",
    [gameIdHex, 2],
    PLAYER2_ADDRESS,
    { playerSecret: p2Secret, shuffleSeed: p2Seed },
  );
  logResult("dealCards P2", deal2, t);

  if (deal2.success) {
    console.log("\n  ✓ Game setup complete! Both players have their cards.");
    block = await getIndexerBlock();
    console.log(`  Final indexer block: ${block}`);
  } else {
    console.log(`\n  dealCards P2 FAILED: ${deal2.error}`);
    Deno.exit(1);
  }

  // ── Done ────────────────────────────────────────────────────────────────
  logStep("All steps passed!");
  console.log(`  Game ${gameId} is ready for gameplay.\n`);
}

main().catch(err => {
  console.error("Fatal error:", err);
  Deno.exit(1);
});

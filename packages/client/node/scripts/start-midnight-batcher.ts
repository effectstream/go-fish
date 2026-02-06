/**
 * Wrapper script to start midnight-batcher after waiting for indexer to be ready
 *
 * The midnight-batcher needs the indexer to be accepting connections before it starts,
 * but the orchestrator's dependsOn only waits for process launch, not readiness.
 */

import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const midnightBatcherDir = path.resolve(__dirname, "../../../../../midnight-batcher/local-chain-setup");

const INDEXER_URL = "http://127.0.0.1:8088/api/v3/graphql";
const MAX_RETRIES = 60; // 60 seconds max wait
const RETRY_DELAY_MS = 1000;

async function waitForIndexer(): Promise<void> {
  console.log(`[midnight-batcher] Waiting for indexer at ${INDEXER_URL}...`);

  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      const response = await fetch(INDEXER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "{ __typename }" }),
      });

      if (response.ok) {
        console.log(`[midnight-batcher] Indexer is ready!`);
        return;
      }
    } catch {
      // Connection refused or other error, keep retrying
    }

    if (i % 5 === 0) {
      console.log(`[midnight-batcher] Still waiting for indexer... (${i + 1}/${MAX_RETRIES})`);
    }
    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
  }

  throw new Error(`Indexer not ready after ${MAX_RETRIES} seconds`);
}

async function startBatcher(): Promise<void> {
  await waitForIndexer();

  console.log(`[midnight-batcher] Starting cargo run --release in ${midnightBatcherDir}`);

  const child = spawn("cargo", [
    "run", "--release", "--",
    // WebSocket endpoint has /ws suffix, HTTP endpoint doesn't
    "--indexer-ws", "ws://127.0.0.1:8088/api/v3/graphql/ws",
    "--indexer-http", "http://127.0.0.1:8088/api/v3/graphql",
    "--node", "ws://127.0.0.1:9944",
  ], {
    cwd: midnightBatcherDir,
    stdio: "inherit",
    env: {
      ...process.env,
      RUST_BACKTRACE: "full",
    },
  });

  child.on("error", (err) => {
    console.error(`[midnight-batcher] Failed to start: ${err.message}`);
    process.exit(1);
  });

  child.on("exit", (code) => {
    process.exit(code ?? 0);
  });
}

startBatcher().catch((err) => {
  console.error(`[midnight-batcher] Error: ${err.message}`);
  process.exit(1);
});

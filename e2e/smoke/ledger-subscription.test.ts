/**
 * Step 3 smoke test — live WS subscription to the Midnight indexer.
 *
 * Verifies we can:
 *   1. Connect to the Midnight indexer via indexerPublicDataProvider
 *   2. Subscribe to contractStateObservable and receive at least one emission
 *   3. Also query the state once via queryContractState for comparison
 *
 * PREREQS — the following must be running:
 *   - Midnight indexer (default http://127.0.0.1:8088)
 *   - Midnight node
 *   - Go Fish contract deployed at the address in go-fish-contract.undeployed.json
 *
 * Start with: bun run --filter @go-fish/node midnight:setup
 *
 * Run: bun run --filter @go-fish/e2e smoke:ledger
 *
 * Note on ledger decoding: the compiled ledger() function for go-fish returns
 * {} because the contract doesn't declare typed ledger blocks — state lives in
 * module ledgers (go_fish_*). Reading specific fields therefore requires either
 *   (a) raw VM query ops: contractState.query([...ops], CostModel)
 *   (b) locally instantiating Contract and calling impureCircuits.getGamePhase
 *       (and friends) with a QueryContext hydrated from indexer state.
 *
 * This smoke test only proves the pipe is open — field decoding comes in Step 9.
 */

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { firstValueFrom, take, timeout } from "rxjs";

// Match packages/shared/contracts/midnight/midnight-env.ts — /api/v1 triggers
// an infinite-redirect bug in this indexer build.
const INDEXER_HTTP_URL =
  process.env.INDEXER_HTTP_URL ?? "http://127.0.0.1:8088/api/v3/graphql";
const INDEXER_WS_URL =
  process.env.INDEXER_WS_URL ?? "ws://127.0.0.1:8088/api/v3/graphql/ws";

const REPO_ROOT = process.env.GO_FISH_REPO_ROOT ?? process.cwd().replace(/\/e2e\/?$/, "");
const CONTRACT_ADDRESS_FILE = resolve(
  REPO_ROOT,
  "packages/shared/contracts/midnight/go-fish-contract.undeployed.json",
);

function loadContractAddress(): string {
  const raw = readFileSync(CONTRACT_ADDRESS_FILE, "utf-8");
  const parsed = JSON.parse(raw);
  return parsed.contractAddress.replace(/^0x/, "");
}

test("indexer: queryContractState returns current state", async () => {
    setNetworkId("undeployed");
    const provider = indexerPublicDataProvider(INDEXER_HTTP_URL, INDEXER_WS_URL);
    const addr = loadContractAddress();
    console.log(`  contract address = ${addr}`);

    const state = await provider.queryContractState(addr as any);
    expect(state).toBeDefined();
    console.log(`  state exists: ${typeof state}, keys=${Object.keys(state).join(",")}`);
    if ("data" in state) {
      console.log(`  state.data type: ${typeof state.data}`);
    }
}, { timeout: 600_000 });

test("indexer: contractStateObservable emits at least once", async () => {
    setNetworkId("undeployed");
    const provider = indexerPublicDataProvider(INDEXER_HTTP_URL, INDEXER_WS_URL);
    const addr = loadContractAddress();

    const observable = provider.contractStateObservable(addr as any, { type: "latest" });
    console.log(`  subscribed; awaiting first emission (10s timeout)...`);

    const firstState = await firstValueFrom(
      observable.pipe(
        take(1),
        timeout({ first: 10_000 }),
      ),
    );

    expect(firstState).toBeDefined();
    console.log(`  received emission: ${typeof firstState}`);
    console.log(`  emission keys: ${Object.keys(firstState as any).join(",")}`);
}, { timeout: 600_000 });

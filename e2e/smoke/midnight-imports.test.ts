/**
 * Step 1 smoke test — Bun compat for Midnight JS libs + rxjs.
 *
 * Verifies every package the full e2e test needs can be imported and its
 * main export is callable / constructible under Bun. No external services
 * required.
 *
 * Run: bun run --filter @go-fish/e2e smoke:imports
 */

import { test, expect } from "bun:test";

import { findDeployedContract } from "@midnight-ntwrk/midnight-js-contracts";
import { httpClientProofProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { NodeZkConfigProvider } from "@midnight-ntwrk/midnight-js-node-zk-config-provider";
import { setNetworkId, getNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import type { NetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { filter, firstValueFrom, map, shareReplay, timeout, Subject } from "rxjs";

test("Midnight JS libs import cleanly under Bun", () => {
  expect(findDeployedContract).toBeDefined();
  expect(httpClientProofProvider).toBeDefined();
  expect(indexerPublicDataProvider).toBeDefined();
  expect(NodeZkConfigProvider).toBeDefined();
  expect(setNetworkId).toBeDefined();
  expect(getNetworkId).toBeDefined();
  const _id: NetworkId = "undeployed";  // type-only use
});

test("rxjs pipes work", async () => {
  const s = new Subject<number>();
  const out$ = s.pipe(
    map(n => n * 2),
    filter(n => n > 4),
    shareReplay(1),
    timeout({ first: 5_000 }),
  );
  queueMicrotask(() => { s.next(1); s.next(2); s.next(3); });
  const first = await firstValueFrom(out$);
  if (first !== 6) throw new Error(`expected 6, got ${first}`);
});

test("NodeZkConfigProvider constructs with a path", () => {
  const provider = new NodeZkConfigProvider<string>(
    "/tmp/does-not-exist-yet",
  );
  expect(provider).toBeDefined();
});

test("httpClientProofProvider constructs with a URL", () => {
  const fakeZkConfig = new NodeZkConfigProvider<string>("/tmp/placeholder");
  const provider = httpClientProofProvider("http://127.0.0.1:6300", fakeZkConfig);
  expect(provider).toBeDefined();
});

test("indexerPublicDataProvider constructs with URLs", () => {
  const provider = indexerPublicDataProvider(
    "http://127.0.0.1:8088/api/v1/graphql",
    "ws://127.0.0.1:8088/api/v1/graphql/ws",
  );
  expect(provider).toBeDefined();
  expect(provider.queryContractState).toBeDefined();
  expect(provider.contractStateObservable).toBeDefined();
});

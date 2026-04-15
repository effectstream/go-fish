/**
 * Step 1 smoke test — Deno compat for Midnight JS libs + rxjs.
 *
 * Verifies every package the full e2e test needs can be imported and its
 * main export is callable / constructible under Deno. No external services
 * required.
 *
 * Run: deno task --filter @go-fish/e2e smoke:imports
 */

import { assertExists } from "jsr:@std/assert";

import { findDeployedContract } from "@midnight-ntwrk/midnight-js-contracts";
import { httpClientProofProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { NodeZkConfigProvider } from "@midnight-ntwrk/midnight-js-node-zk-config-provider";
import { setNetworkId, getNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import type { NetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { filter, firstValueFrom, map, shareReplay, timeout, Subject } from "rxjs";

Deno.test("Midnight JS libs import cleanly under Deno", () => {
  assertExists(findDeployedContract, "findDeployedContract");
  assertExists(httpClientProofProvider, "httpClientProofProvider");
  assertExists(indexerPublicDataProvider, "indexerPublicDataProvider");
  assertExists(NodeZkConfigProvider, "NodeZkConfigProvider");
  assertExists(setNetworkId, "setNetworkId");
  assertExists(getNetworkId, "getNetworkId");
  const _id: NetworkId = "undeployed";  // type-only use
});

Deno.test("rxjs pipes work", async () => {
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

Deno.test("NodeZkConfigProvider constructs with a path", () => {
  const provider = new NodeZkConfigProvider<string>(
    "/tmp/does-not-exist-yet",
  );
  assertExists(provider, "NodeZkConfigProvider instance");
});

Deno.test("httpClientProofProvider constructs with a URL", () => {
  const fakeZkConfig = new NodeZkConfigProvider<string>("/tmp/placeholder");
  const provider = httpClientProofProvider("http://127.0.0.1:6300", fakeZkConfig);
  assertExists(provider, "httpClientProofProvider instance");
});

Deno.test("indexerPublicDataProvider constructs with URLs", () => {
  const provider = indexerPublicDataProvider(
    "http://127.0.0.1:8088/api/v1/graphql",
    "ws://127.0.0.1:8088/api/v1/graphql/ws",
  );
  assertExists(provider, "indexerPublicDataProvider instance");
  assertExists(provider.queryContractState, "queryContractState method");
  assertExists(provider.contractStateObservable, "contractStateObservable method");
});

/**
 * Step 6 smoke test — real init_deck circuit via HTTP prover + batcher.
 *
 * Exercises the full Midnight flow end-to-end for a single circuit:
 *   1. findDeployedContract with NodeZkConfigProvider + httpClientProofProvider
 *      + indexerPublicDataProvider + in-memory private state + delegating
 *      wallet provider.
 *   2. Call contract.callTx.init_deck() — compact-js WASM-simulates the
 *      circuit, httpClientProofProvider generates the ZK proof against the
 *      prover at :6300, produces an UnboundTransaction.
 *   3. The delegating balanceTx hook intercepts the UnboundTransaction,
 *      serializes it, and POSTs to the batcher's /send-input with
 *      target="midnight_balancing". Then throws DELEGATED_SENTINEL to abort
 *      the SDK pipeline (we don't want it to try to call submitTx).
 *   4. Wait for the WS contract-state subscription to emit a new state whose
 *      staticDeckInitialized flag is true — indicates the transaction was
 *      balanced, submitted, and indexed.
 *
 * PREREQS:
 *   - Midnight node + indexer (:8088) + proof server (:6300) running
 *   - Hardhat + Paima node + batcher (:3336) running
 *   - Contract deployed (go-fish-contract.undeployed.json up to date)
 *
 * Run: deno task --filter @go-fish/e2e smoke:init-deck
 */

import { assertEquals } from "jsr:@std/assert";
import { resolve } from "jsr:@std/path";
import {
  toHex,
  CompactTypeBoolean,
  CompactTypeUnsignedInteger,
  CostModel,
} from "@midnight-ntwrk/compact-runtime";
import { CompiledContract } from "@midnight-ntwrk/compact-js";
import { findDeployedContract } from "@midnight-ntwrk/midnight-js-contracts";
import { httpClientProofProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { NodeZkConfigProvider } from "@midnight-ntwrk/midnight-js-node-zk-config-provider";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { firstValueFrom, timeout } from "rxjs";

import { Contract as GoFishContract } from "@go-fish/midnight-contract/contract";
import { witnesses } from "@go-fish/midnight-contract";
import { createInMemoryPrivateStateProvider } from "../../frontend/src/services/midnightInMemoryPrivateStateProvider.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const REPO_ROOT = Deno.env.get("GO_FISH_REPO_ROOT") ?? Deno.cwd().replace(/\/e2e\/?$/, "");
const BATCHER_URL = Deno.env.get("BATCHER_URL") ?? "http://localhost:3336";
const PROOF_URL = Deno.env.get("PROOF_URL") ?? "http://127.0.0.1:6300";
const INDEXER_HTTP_URL =
  Deno.env.get("INDEXER_HTTP_URL") ?? "http://127.0.0.1:8088/api/v3/graphql";
const INDEXER_WS_URL =
  Deno.env.get("INDEXER_WS_URL") ?? "ws://127.0.0.1:8088/api/v3/graphql/ws";

const CONTRACT_ADDRESS_FILE = resolve(
  REPO_ROOT,
  "packages/shared/contracts/midnight/go-fish-contract.undeployed.json",
);
const ZK_CONFIG_PATH = resolve(
  REPO_ROOT,
  "packages/shared/contracts/midnight/go-fish-contract/src/managed",
);

const DELEGATED_SENTINEL = "GoFish: delegated to midnight_balancing batcher";

function loadContractAddress(): string {
  const parsed = JSON.parse(Deno.readTextFileSync(CONTRACT_ADDRESS_FILE));
  return parsed.contractAddress.replace(/^0x/, "");
}

// ---------------------------------------------------------------------------
// Batcher POST — midnight_balancing (unsigned, no target field)
// ---------------------------------------------------------------------------

function detectTxStage(serializedTx: string): "unproven" | "unbound" | "finalized" {
  const prefixBytes = new Uint8Array(
    serializedTx.slice(0, 600).padEnd(600, "0").match(/.{2}/g)!.map(b => parseInt(b, 16)),
  );
  const header = new TextDecoder().decode(prefixBytes);
  const m = header.match(/midnight:(?:transaction|intent)\[v\d+\]\(signature\[v\d+\],([^,]+),([^)]+)\):/);
  if (!m) throw new Error(`detectTxStage: cannot parse header: ${header.slice(0, 80)}`);
  if (m[1]!.includes("proof-preimage")) return "unproven";
  if (m[2]!.includes("embedded-fr")) return "unbound";
  if (m[2]!.includes("pedersen-schnorr")) return "finalized";
  throw new Error(`detectTxStage: unknown stage markers: ${m[1]} / ${m[2]}`);
}

/**
 * Read the `staticDeckInitialized` boolean from the on-chain contract state
 * by running VM query ops at path [1n, 0n]. Mirrors
 * frontend/src/services/GoFishContractService.ts `queryIsStaticDeckInitialized`.
 * Returns `true` once init_deck has landed, `false` before, `null` on read error.
 */
async function queryStaticDeckInitialized(
  publicDataProvider: any,
  contractAddress: string,
): Promise<boolean | null> {
  try {
    const contractState = await publicDataProvider.queryContractState(contractAddress);
    if (!contractState) return null;

    // Contract V3: ledger layout restructure moved staticDeckInitialized.
    // Current compiled path = [0n, 2n] (see managed/contract/index.js
    // `_init_static_deck_0` queryLedgerState ops at ~line 2524). Keep in
    // sync with that accessor after every `deno task compact`.
    const keyType = new CompactTypeUnsignedInteger(255n, 1);
    const keyOuter = { value: keyType.toValue(0n), alignment: keyType.alignment() };
    const keyInner = { value: keyType.toValue(2n), alignment: keyType.alignment() };

    const results = contractState.query(
      [
        { dup: { n: 0 } },
        {
          idx: {
            cached: false,
            pushPath: false,
            path: [
              { tag: "value" as const, value: keyOuter },
              { tag: "value" as const, value: keyInner },
            ],
          },
        },
        { popeq: { cached: false, result: null } },
      ],
      CostModel.initialCostModel(),
    );

    const gatherResults = (results as any)[1];
    const first = Array.isArray(gatherResults) ? gatherResults[0] : null;
    if (!first || first.tag !== "read") return null;
    return CompactTypeBoolean.fromValue(first.content.value);
  } catch (err) {
    console.warn(`  queryStaticDeckInitialized error:`, (err as Error).message);
    return null;
  }
}

async function postMidnightTx(
  serializedTx: string,
  circuitId: string,
): Promise<void> {
  const txStage = detectTxStage(serializedTx);
  console.log(`  [batcher] ${circuitId}: txStage=${txStage}, len=${serializedTx.length / 2}B`);

  const body = {
    data: {
      // target omitted — batcher's default would be effectstreaml2 which is
      // wrong, so we DO specify target here. The midnight_balancing adapter
      // provides its own signature verification (or none), so we don't need
      // to sign.
      target: "midnight_balancing",
      addressType: 0,
      address: "go_fish_player",
      input: JSON.stringify({ tx: serializedTx, txStage, circuitId }),
      timestamp: Date.now(),
    },
    confirmationLevel: "no-wait",
  };

  const res = await fetch(`${BATCHER_URL}/send-input`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  console.log(`  [batcher] ${circuitId} response: ${res.status} ${text.slice(0, 200)}`);
  if (!res.ok) {
    throw new Error(`batcher rejected ${circuitId}: ${text}`);
  }
}

// ---------------------------------------------------------------------------
// Delegating provider — intercepts balanceTx, POSTs, throws sentinel
// ---------------------------------------------------------------------------

function makeDelegatingProvider() {
  const provider: any = {
    getCoinPublicKey() {
      // Return a dummy 32-byte zero coin public key. The midnight_balancing
      // adapter handles balancing with the batcher's own wallet, so this
      // value doesn't affect the output.
      return "00".repeat(32);
    },
    getEncryptionPublicKey() {
      return "00".repeat(32);
    },
    async balanceTx(tx: any) {
      if (typeof provider.__delegatedBalanceHook === "function") {
        await provider.__delegatedBalanceHook(tx);
        throw new Error(DELEGATED_SENTINEL);
      }
      throw new Error("balanceTx called without hook");
    },
    submitTx(_tx: any) {
      throw new Error("submitTx should never be called — balanceTx delegates");
    },
    __delegatedBalanceHook: undefined as undefined | ((tx: any) => Promise<void>),
  };
  return provider;
}

function isDelegationError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  let e: Error | undefined = err;
  while (e) {
    if (e.message.includes(DELEGATED_SENTINEL)) return true;
    e = e.cause instanceof Error ? e.cause : undefined;
  }
  return false;
}

async function callDelegated(
  provider: any,
  circuitId: string,
  invoke: () => Promise<any>,
): Promise<void> {
  let delegated = false;
  provider.__delegatedBalanceHook = async (tx: any) => {
    const serializedTx = toHex((tx as any).serialize());
    await postMidnightTx(serializedTx, circuitId);
    delegated = true;
  };
  try {
    await invoke();
  } catch (err) {
    if (isDelegationError(err) || delegated) return;
    throw err;
  } finally {
    delete provider.__delegatedBalanceHook;
  }
}

// ---------------------------------------------------------------------------
// The test
// ---------------------------------------------------------------------------

Deno.test({
  name: "circuit: init_deck via real prover + batcher",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // Case-sensitive: must be lowercase "undeployed" — the Midnight node
    // compares IDs literally and rejects txs proven with the wrong casing.
    setNetworkId("undeployed");

    const contractAddress = loadContractAddress();
    console.log(`  contractAddress = ${contractAddress}`);

    const zkConfigProvider = new NodeZkConfigProvider<string>(ZK_CONFIG_PATH);
    console.log(`  zk config path = ${ZK_CONFIG_PATH}`);

    const proofProvider = httpClientProofProvider(PROOF_URL, zkConfigProvider);
    console.log(`  proof server = ${PROOF_URL}`);

    const publicDataProvider = indexerPublicDataProvider(INDEXER_HTTP_URL, INDEXER_WS_URL);

    const privateStateProvider = createInMemoryPrivateStateProvider("smoke-init-deck");

    const walletProvider = makeDelegatingProvider();

    const compiledContract = CompiledContract.make("go-fish", GoFishContract as any)
      .pipe(
        CompiledContract.withWitnesses(witnesses as any),
        CompiledContract.withCompiledFileAssets(ZK_CONFIG_PATH),
      );

    console.log("  joining deployed contract...");
    const contract: any = await findDeployedContract(
      {
        privateStateProvider,
        zkConfigProvider,
        proofProvider,
        publicDataProvider,
        walletProvider,
        midnightProvider: walletProvider,
      } as any,
      {
        contractAddress: contractAddress as any,
        compiledContract: compiledContract as any,
        privateStateId: "smoke-init-deck" as any,
        initialPrivateState: {},
      } as any,
    );
    console.log("  ✓ contract joined");

    // `init_deck()` is a one-shot circuit: it wraps `deck_init_static_deck()`
    // which sets the `staticDeckInitialized` flag globally (not per-game).
    // Once true, it stays true forever — calling it again would fail the
    // internal assert. So the smoke test is idempotent:
    //   - If already true: skip submission (plumbing still verified above
    //     via findDeployedContract, queryContractState, VM ops query)
    //   - If false: invoke and wait for the flip
    // The full e2e test will follow the same pattern: read the flag once,
    // call init_deck only if needed, then proceed to per-game setup
    // (applyMask with a fresh random gameId creates the per-game state
    // automatically inside the contract).
    const initializedBefore = await queryStaticDeckInitialized(
      publicDataProvider,
      contractAddress,
    );
    console.log(`  staticDeckInitialized before: ${initializedBefore}`);

    if (initializedBefore === true) {
      console.log("  ✓ already initialized (one-shot already done) — smoke skips submission");
      return;
    }

    // Invoke the circuit end-to-end:
    //   1. WASM simulation of init_deck
    //   2. HTTP prover at :6300 generates the ZK proof
    //   3. balanceTx hook POSTs the UnboundTransaction to the batcher
    //   4. Batcher's midnight_balancing adapter balances + submits on-chain
    console.log("  invoking contract.callTx.init_deck() ...");
    const t0 = Date.now();
    await callDelegated(walletProvider, "init_deck", () => contract.callTx.init_deck());
    console.log(`  ✓ init_deck submitted to batcher in ${Math.round((Date.now() - t0) / 1000)}s`);

    // Poll until staticDeckInitialized flips false → true. Real semantic read
    // (VM query ops), not an opaque ptr comparison.
    console.log("  polling indexer for staticDeckInitialized==true (120s timeout)...");
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 2_000));
      const flag = await queryStaticDeckInitialized(publicDataProvider, contractAddress);
      if (flag === true) {
        console.log(`  ✓ staticDeckInitialized: false → true`);
        return;
      }
      console.log(`  [poll] flag=${flag} (${Math.round((deadline - Date.now()) / 1000)}s left)`);
    }
    throw new Error("Timed out waiting for staticDeckInitialized to flip to true");
  },
});

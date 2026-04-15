/**
 * Step 8 smoke test — full per-game setup sequence:
 *   applyMask(1) → applyMask(2) → dealCards(1) → dealCards(2)
 *
 * End state: phase == TurnStart (1), both players have 4-card hands, the
 * 21-card deck has 13 remaining (21 - 8 dealt).
 *
 * Uses ONE contract instance + ONE delegating provider for both players.
 * Both players' secrets are set in the shared witness module upfront (the
 * contract's dealCards / respondToAsk circuits consult BOTH players'
 * secrets during proving — this is a contract-level design choice, not
 * something we can fix in the test layer).
 *
 * State reads use `localContract.impureCircuits` against a QueryContext
 * hydrated from fresh indexer state — no VM-ops path tables, just typed
 * circuit results.
 *
 * PREREQS: full stack running, staticDeckInitialized == true, all three
 * smokes (ledger, lobby, init-deck, apply-mask) passing.
 *
 * Run: deno task --filter @go-fish/e2e smoke:setup
 */

import { assertEquals } from "jsr:@std/assert";
import { resolve } from "jsr:@std/path";
import {
  toHex,
  QueryContext,
  CostModel,
  sampleContractAddress,
  createConstructorContext,
} from "@midnight-ntwrk/compact-runtime";
import { CompiledContract } from "@midnight-ntwrk/compact-js";
import { findDeployedContract } from "@midnight-ntwrk/midnight-js-contracts";
import { httpClientProofProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { NodeZkConfigProvider } from "@midnight-ntwrk/midnight-js-node-zk-config-provider";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";

import { Contract as GoFishContract } from "@go-fish/midnight-contract/contract";
import {
  witnesses,
  setPlayerSecrets,
  clearPlayerSecrets,
} from "@go-fish/midnight-contract";
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
const JUBJUB_R = 0x0e7db4ea6533afa906673b0101343b00a6682093ccc81082d0970e5ed6f72cb7n;

// GamePhase enum values (from go_fish_GamePhase in GoFish.compact)
const PHASE_SETUP = 0;
const PHASE_TURN_START = 1;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadContractAddress(): string {
  return JSON.parse(Deno.readTextFileSync(CONTRACT_ADDRESS_FILE)).contractAddress.replace(/^0x/, "");
}

function generatePlayerSecret(): bigint {
  while (true) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const n = BigInt("0x" + Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join(""));
    if (n >= 1n && n < JUBJUB_R) return n;
  }
}

function generateShuffleSeed(): Uint8Array {
  const seed = new Uint8Array(32);
  crypto.getRandomValues(seed);
  return seed;
}

function randomGameId(): Uint8Array {
  const id = new Uint8Array(32);
  crypto.getRandomValues(id);
  return id;
}

function gameIdToHex(gameId: Uint8Array): string {
  return "0x" + Array.from(gameId).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Batcher POST — midnight_balancing
// ---------------------------------------------------------------------------

function detectTxStage(serializedTx: string): "unproven" | "unbound" | "finalized" {
  const prefixBytes = new Uint8Array(
    serializedTx.slice(0, 600).padEnd(600, "0").match(/.{2}/g)!.map(b => parseInt(b, 16)),
  );
  const header = new TextDecoder().decode(prefixBytes);
  const m = header.match(/midnight:(?:transaction|intent)\[v\d+\]\(signature\[v\d+\],([^,]+),([^)]+)\):/);
  if (!m) throw new Error(`detectTxStage: cannot parse: ${header.slice(0, 80)}`);
  if (m[1]!.includes("proof-preimage")) return "unproven";
  if (m[2]!.includes("embedded-fr")) return "unbound";
  if (m[2]!.includes("pedersen-schnorr")) return "finalized";
  throw new Error(`detectTxStage: unknown: ${m[1]} / ${m[2]}`);
}

async function postMidnightTx(
  serializedTx: string,
  circuitId: string,
  meta: { playerId?: number } = {},
): Promise<void> {
  const txStage = detectTxStage(serializedTx);
  console.log(`  [batcher] ${circuitId}: txStage=${txStage}, len=${serializedTx.length / 2}B`);

  const res = await fetch(`${BATCHER_URL}/send-input`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      data: {
        target: "midnight_balancing",
        addressType: 0,
        address: "go_fish_player",
        input: JSON.stringify({ tx: serializedTx, txStage, circuitId, ...meta }),
        timestamp: Date.now(),
      },
      confirmationLevel: "no-wait",
    }),
  });
  const text = await res.text();
  console.log(`  [batcher] ${circuitId} → ${res.status} ${text.slice(0, 120)}`);
  if (!res.ok) throw new Error(`batcher rejected ${circuitId}: ${text}`);
}

// ---------------------------------------------------------------------------
// Delegating provider
// ---------------------------------------------------------------------------

function makeDelegatingProvider() {
  const provider: any = {
    getCoinPublicKey: () => "00".repeat(32),
    getEncryptionPublicKey: () => "00".repeat(32),
    async balanceTx(tx: any) {
      if (typeof provider.__delegatedBalanceHook === "function") {
        await provider.__delegatedBalanceHook(tx);
        throw new Error(DELEGATED_SENTINEL);
      }
      throw new Error("balanceTx called without hook");
    },
    submitTx(_tx: any) {
      throw new Error("submitTx should never be called");
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
  meta: { playerId?: number } = {},
): Promise<void> {
  let delegated = false;
  provider.__delegatedBalanceHook = async (tx: any) => {
    const serializedTx = toHex((tx as any).serialize());
    await postMidnightTx(serializedTx, circuitId, meta);
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
// Semantic reads via local Contract + hydrated QueryContext
// ---------------------------------------------------------------------------

function buildLocalContract() {
  const localContract: any = new GoFishContract(witnesses as any);
  const init = localContract.initialState(createConstructorContext({}, "0".repeat(64)));
  return { localContract, initialPrivateState: init.currentPrivateState, initialZswap: init.currentZswapLocalState };
}

function makeReadCtx(
  initialPrivateState: any,
  initialZswap: any,
  contractStateData: any,
): any {
  return {
    currentPrivateState: initialPrivateState,
    currentZswapLocalState: initialZswap,
    currentQueryContext: new QueryContext(contractStateData, sampleContractAddress()),
    costModel: CostModel.initialCostModel(),
  };
}

async function readCircuit<T = any>(
  publicDataProvider: any,
  contractAddress: string,
  localContract: any,
  initialPrivateState: any,
  initialZswap: any,
  circuitName: string,
  ...args: any[]
): Promise<T | { __missing: true }> {
  const cs = await publicDataProvider.queryContractState(contractAddress);
  if (!cs) throw new Error("queryContractState returned null");
  const ctx = makeReadCtx(initialPrivateState, initialZswap, cs.data);
  try {
    const r = localContract.impureCircuits[circuitName](ctx, ...args);
    return r.result as T;
  } catch (err) {
    const msg = (err as Error).message ?? "";
    // Fresh gameId: map lookups throw "expected a cell, received null" or
    // "not present". Callers interpret this as "not yet set".
    if (msg.includes("expected a cell, received null") || msg.includes("not present")) {
      return { __missing: true };
    }
    throw err;
  }
}

async function waitFor<T>(
  label: string,
  timeoutMs: number,
  fetch: () => Promise<T>,
  predicate: (v: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fetch();
    if (predicate(v)) {
      console.log(`  ✓ ${label}: matched (${JSON.stringify(v)})`);
      return v;
    }
    const remaining = Math.round((deadline - Date.now()) / 1000);
    console.log(`  [poll] ${label} pending (${JSON.stringify(v)}, ${remaining}s left)`);
    await new Promise(r => setTimeout(r, 2_000));
  }
  throw new Error(`Timeout: ${label}`);
}

// ---------------------------------------------------------------------------
// The test
// ---------------------------------------------------------------------------

Deno.test({
  name: "setup: applyMask×2 + dealCards×2 → phase=TurnStart, hands=4/4",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    setNetworkId("undeployed");

    const contractAddress = loadContractAddress();
    const gameId = randomGameId();
    const gameIdHex = gameIdToHex(gameId);
    const p1Secret = generatePlayerSecret();
    const p1Seed = generateShuffleSeed();
    const p2Secret = generatePlayerSecret();
    const p2Seed = generateShuffleSeed();

    console.log(`  contractAddress = ${contractAddress}`);
    console.log(`  gameId = ${gameIdHex.slice(0, 22)}...`);
    console.log(`  p1 secret = ${p1Secret.toString(16).slice(0, 12)}..., p2 secret = ${p2Secret.toString(16).slice(0, 12)}...`);

    const zkConfigProvider = new NodeZkConfigProvider<string>(ZK_CONFIG_PATH);
    const proofProvider = httpClientProofProvider(PROOF_URL, zkConfigProvider);
    const publicDataProvider = indexerPublicDataProvider(INDEXER_HTTP_URL, INDEXER_WS_URL);
    const privateStateProvider = createInMemoryPrivateStateProvider("smoke-setup");
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
        privateStateId: "smoke-setup" as any,
        initialPrivateState: {},
      } as any,
    );
    console.log("  ✓ contract joined");

    // Local contract instance for read-only circuit evaluation against
    // indexer state. Witnesses are shared with the deployed contract so
    // doesPlayerHaveSpecificCard / etc. will use whatever secrets are
    // currently set via setPlayerSecrets.
    const { localContract, initialPrivateState, initialZswap } = buildLocalContract();

    const read = async <T = any>(name: string, ...args: any[]) =>
      readCircuit<T>(
        publicDataProvider,
        contractAddress,
        localContract,
        initialPrivateState,
        initialZswap,
        name,
        ...args,
      );

    // Load BOTH players' secrets into the shared witness module. The
    // contract's dealCards / respondToAsk circuits consult both during
    // proving (see witnesses.ts `getSecretKey`). They'll be cleared in
    // the finally block.
    setPlayerSecrets(gameIdHex, 1, p1Secret, p1Seed);
    setPlayerSecrets(gameIdHex, 2, p2Secret, p2Seed);

    try {
      // ─── applyMask(1) ──────────────────────────────────────────────
      console.log("\n── applyMask(gameId, 1n) ──");
      const t0 = Date.now();
      await callDelegated(
        walletProvider,
        "applyMask:1",
        () => contract.callTx.applyMask(gameId, 1n),
        { playerId: 1 },
      );
      console.log(`  ✓ proven + queued in ${Math.round((Date.now() - t0) / 1000)}s`);

      await waitFor(
        "hasMaskApplied(1)",
        120_000,
        () => read<boolean>("hasMaskApplied", gameId, 1n),
        v => v === true,
      );

      // ─── applyMask(2) ──────────────────────────────────────────────
      console.log("\n── applyMask(gameId, 2n) ──");
      const t1 = Date.now();
      await callDelegated(
        walletProvider,
        "applyMask:2",
        () => contract.callTx.applyMask(gameId, 2n),
        { playerId: 2 },
      );
      console.log(`  ✓ proven + queued in ${Math.round((Date.now() - t1) / 1000)}s`);

      await waitFor(
        "hasMaskApplied(2)",
        120_000,
        () => read<boolean>("hasMaskApplied", gameId, 2n),
        v => v === true,
      );

      // ─── dealCards(1) ──────────────────────────────────────────────
      console.log("\n── dealCards(gameId, 1n) ──");
      const t2 = Date.now();
      await callDelegated(
        walletProvider,
        "dealCards:1",
        () => contract.callTx.dealCards(gameId, 1n),
        { playerId: 1 },
      );
      console.log(`  ✓ proven + queued in ${Math.round((Date.now() - t2) / 1000)}s`);

      await waitFor(
        "hasDealt(1)",
        180_000,
        () => read<boolean>("hasDealt", gameId, 1n),
        v => v === true,
      );

      // ─── dealCards(2) ──────────────────────────────────────────────
      console.log("\n── dealCards(gameId, 2n) ──");
      const t3 = Date.now();
      await callDelegated(
        walletProvider,
        "dealCards:2",
        () => contract.callTx.dealCards(gameId, 2n),
        { playerId: 2 },
      );
      console.log(`  ✓ proven + queued in ${Math.round((Date.now() - t3) / 1000)}s`);

      // Phase should transition to TurnStart after second dealCards.
      // getGamePhase's return is the Compact enum compiled to JS number,
      // not bigint — just compare numerically.
      await waitFor(
        "phase == TurnStart",
        180_000,
        () => read<number | bigint>("getGamePhase", gameId),
        v => Number(v) === PHASE_TURN_START,
      );

      // Final assertions
      const handSizes = await read<[bigint | number, bigint | number]>("getHandSizes", gameId);
      const h1 = Number((handSizes as any)[0]);
      const h2 = Number((handSizes as any)[1]);
      console.log(`\n  final hand sizes: P1=${h1}, P2=${h2}`);
      assertEquals(h1, 4, "P1 should have 4 cards");
      assertEquals(h2, 4, "P2 should have 4 cards");

      const finalPhase = Number(await read<number | bigint>("getGamePhase", gameId));
      console.log(`  final phase: ${finalPhase}`);
      assertEquals(finalPhase, PHASE_TURN_START);

      console.log(`\n  ✓ setup complete — game ${gameIdHex.slice(0, 18)}... ready for play`);
    } finally {
      clearPlayerSecrets(gameIdHex, 1);
      clearPlayerSecrets(gameIdHex, 2);
    }
  },
});

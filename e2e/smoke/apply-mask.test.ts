/**
 * Step 7 smoke test — applyMask(gameId, 1) via setPlayerSecrets +
 * real prover + batcher. First circuit that actually consumes player
 * secrets through the witness module.
 *
 * Flow:
 *   1. Generate a random 32-byte gameId (per run, so we always exercise
 *      the "first caller for a new game" branch of applyMask which
 *      implicitly calls go_fish_init_game + deck_init_deck + hand_init_hands)
 *   2. Generate a P1 secret (rejection-sampled to [1, JUBJUB_R)) and shuffle seed
 *   3. setPlayerSecrets(gameIdHex, 1, secret, seed) — writes to the shared
 *      witness module's dynamicSecrets map
 *   4. contract.callTx.applyMask(gameId, 1n) — WASM simulates the circuit
 *      (consulting player_secret_key and shuffle_seed witnesses), prover
 *      generates the proof, balanceTx delegates to the batcher
 *   5. Poll hasMaskApplied(gameId, 1) via VM ops until true
 *   6. clearPlayerSecrets(gameIdHex, 1) in finally
 *
 * PREREQS:
 *   - Midnight node + indexer + proof server running
 *   - Batcher running with midnight_balancing adapter
 *   - staticDeckInitialized flag is true (otherwise applyMask's internal
 *     assertions may fail)
 *
 * Run: bun run --filter @go-fish/e2e smoke:apply-mask
 */

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  toHex,
  CompactTypeBoolean,
  CompactTypeBytes,
  CompactTypeUnsignedInteger,
  CostModel,
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

const REPO_ROOT = process.env.GO_FISH_REPO_ROOT ?? process.cwd().replace(/\/e2e\/?$/, "");
const BATCHER_URL = process.env.BATCHER_URL ?? "http://localhost:3336";
const PROOF_URL = process.env.PROOF_URL ?? "http://127.0.0.1:6300";
const INDEXER_HTTP_URL =
  process.env.INDEXER_HTTP_URL ?? "http://127.0.0.1:8088/api/v3/graphql";
const INDEXER_WS_URL =
  process.env.INDEXER_WS_URL ?? "ws://127.0.0.1:8088/api/v3/graphql/ws";

const CONTRACT_ADDRESS_FILE = resolve(
  REPO_ROOT,
  "packages/shared/contracts/midnight/go-fish-contract.undeployed.json",
);
const ZK_CONFIG_PATH = resolve(
  REPO_ROOT,
  "packages/shared/contracts/midnight/go-fish-contract/src/managed",
);

const DELEGATED_SENTINEL = "GoFish: delegated to midnight_balancing batcher";

// Jubjub prime-order subgroup order — secrets must be in [1, r)
const JUBJUB_R = 0x0e7db4ea6533afa906673b0101343b00a6682093ccc81082d0970e5ed6f72cb7n;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadContractAddress(): string {
  const parsed = JSON.parse(readFileSync(CONTRACT_ADDRESS_FILE, "utf-8"));
  return parsed.contractAddress.replace(/^0x/, "");
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
  throw new Error(`detectTxStage: unknown stage: ${m[1]} / ${m[2]}`);
}

async function postMidnightTx(
  serializedTx: string,
  circuitId: string,
  meta: { lobbyId?: string; playerId?: number } = {},
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
  console.log(`  [batcher] ${circuitId} → ${res.status} ${text.slice(0, 160)}`);
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
  meta: { lobbyId?: string; playerId?: number } = {},
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
// Semantic reads (VM query ops) — ported from GoFishContractService.ts
// ---------------------------------------------------------------------------

async function queryHasMaskApplied(
  publicDataProvider: any,
  contractAddress: string,
  gameId: Uint8Array,
  playerId: 1 | 2,
): Promise<boolean | null> {
  try {
    const cs = await publicDataProvider.queryContractState(contractAddress);
    if (!cs) return null;

    const keyType = new CompactTypeUnsignedInteger(255n, 1);
    // maskAppliedP1 path = [2n, 5n][gameId], maskAppliedP2 = [2n, 6n][gameId]
    const outerKey = { value: keyType.toValue(2n), alignment: keyType.alignment() };
    const innerKey = {
      value: keyType.toValue(playerId === 1 ? 5n : 6n),
      alignment: keyType.alignment(),
    };
    const gameIdKey = {
      value: new CompactTypeBytes(32).toValue(gameId),
      alignment: new CompactTypeBytes(32).alignment(),
    };

    const results = cs.query(
      [
        { dup: { n: 0 } },
        {
          idx: {
            cached: false,
            pushPath: false,
            path: [
              { tag: "value" as const, value: outerKey },
              { tag: "value" as const, value: innerKey },
            ],
          },
        },
        {
          idx: {
            cached: false,
            pushPath: false,
            path: [{ tag: "value" as const, value: gameIdKey }],
          },
        },
        { popeq: { cached: false, result: undefined } },
      ],
      CostModel.initialCostModel(),
    );

    const gatherResults = (results as any)[1];
    const first = Array.isArray(gatherResults) ? gatherResults[0] : null;
    if (!first || first.tag !== "read") return false;
    return CompactTypeBoolean.fromValue(first.content.value);
  } catch (err) {
    // If the gameId key doesn't exist in the maskApplied map yet, the VM
    // throws `expected a cell, received null` when it tries to idx into a
    // missing entry. That's semantically "not yet applied" — return false.
    const msg = (err as Error).message ?? "";
    if (msg.includes("expected a cell, received null") || msg.includes("not present")) {
      return false;
    }
    console.warn(`  queryHasMaskApplied error:`, msg);
    return null;
  }
}

// ---------------------------------------------------------------------------
// The test
// ---------------------------------------------------------------------------

test("circuit: applyMask(gameId, 1) with setPlayerSecrets", async () => {
    setNetworkId("undeployed");

    const contractAddress = loadContractAddress();
    const gameId = randomGameId();
    const gameIdHex = gameIdToHex(gameId);
    const p1Secret = generatePlayerSecret();
    const p1Seed = generateShuffleSeed();

    console.log(`  contractAddress = ${contractAddress}`);
    console.log(`  gameId = ${gameIdHex.slice(0, 20)}...`);
    console.log(`  p1 secret = ${p1Secret.toString(16).slice(0, 16)}...`);

    const zkConfigProvider = new NodeZkConfigProvider<string>(ZK_CONFIG_PATH);
    const proofProvider = httpClientProofProvider(PROOF_URL, zkConfigProvider);
    const publicDataProvider = indexerPublicDataProvider(INDEXER_HTTP_URL, INDEXER_WS_URL);
    const privateStateProvider = createInMemoryPrivateStateProvider("smoke-apply-mask-p1");
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
        privateStateId: "smoke-apply-mask-p1" as any,
        initialPrivateState: {},
      } as any,
    );
    console.log("  ✓ contract joined");

    // Precondition: hasMaskApplied(gameId, 1) should be false for a fresh gameId.
    const before = await queryHasMaskApplied(publicDataProvider, contractAddress, gameId, 1);
    console.log(`  hasMaskApplied(p1) before: ${before}`);
    expect(before).toBe(false);

    // Load player secrets into the shared witness module. The witness
    // functions (player_secret_key, shuffle_seed) consult dynamicSecrets
    // keyed by `${gameIdHex}-${playerId}`.
    setPlayerSecrets(gameIdHex, 1, p1Secret, p1Seed);

    try {
      console.log("  invoking contract.callTx.applyMask(gameId, 1n) ...");
      const t0 = Date.now();
      await callDelegated(
        walletProvider,
        "applyMask",
        () => contract.callTx.applyMask(gameId, 1n),
        { playerId: 1 },
      );
      console.log(`  ✓ applyMask proven + submitted in ${Math.round((Date.now() - t0) / 1000)}s`);
    } finally {
      clearPlayerSecrets(gameIdHex, 1);
    }

    // Poll until hasMaskApplied(gameId, 1) flips to true. 120s is generous
    // for the batcher to balance, submit, and the indexer to catch up.
    console.log("  polling indexer for hasMaskApplied(p1)==true (120s timeout)...");
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 2_000));
      const flag = await queryHasMaskApplied(publicDataProvider, contractAddress, gameId, 1);
      if (flag === true) {
        console.log(`  ✓ hasMaskApplied(p1): false → true`);
        return;
      }
      console.log(`  [poll] flag=${flag} (${Math.round((deadline - Date.now()) / 1000)}s left)`);
    }
    throw new Error("Timed out waiting for hasMaskApplied(p1) to flip to true");
}, { timeout: 600_000 });

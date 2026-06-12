/**
 * Shared helpers for the Go Fish smoke tests.
 *
 * Factored out of the one-off smokes once we hit 3+ files with 90% overlap.
 * Existing smokes (midnight-imports, contract-config, ledger-subscription,
 * lobby-batcher, init-deck-circuit, apply-mask, setup-sequence) predate
 * this and duplicate most of the content — they're left alone to not
 * risk breaking green tests. Future smokes import from here.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ethers } from "ethers";
import { generateStmInput } from "@effectstream/concise";
import { grammar } from "@go-fish/data-types";
import {
  toHex,
  QueryContext,
  CostModel,
  sampleContractAddress,
  createConstructorContext,
  CompactTypeBoolean,
  CompactTypeUnsignedInteger,
} from "@midnight-ntwrk/compact-runtime";
import { CompiledContract } from "@midnight-ntwrk/compact-js";
import { findDeployedContract } from "@midnight-ntwrk/midnight-js-contracts";
import { httpClientProofProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { NodeZkConfigProvider } from "@midnight-ntwrk/midnight-js-node-zk-config-provider";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";

import { Contract as GoFishContract } from "@go-fish/midnight-contract/contract";
import { createInMemoryPrivateStateProvider } from "../../frontend/src/services/midnightInMemoryPrivateStateProvider.ts";
import { makeTestWitnesses, WitnessState } from "./test-witnesses.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const REPO_ROOT =
  process.env.GO_FISH_REPO_ROOT ?? process.cwd().replace(/\/e2e\/?$/, "");
export const BATCHER_URL = process.env.BATCHER_URL ?? "http://localhost:3336";
export const PROOF_URL = process.env.PROOF_URL ?? "http://127.0.0.1:6300";
export const INDEXER_HTTP_URL =
  process.env.INDEXER_HTTP_URL ?? "http://127.0.0.1:8088/api/v3/graphql";
export const INDEXER_WS_URL =
  process.env.INDEXER_WS_URL ?? "ws://127.0.0.1:8088/api/v3/graphql/ws";
export const PAIMA_API_URL = process.env.API_URL ?? "http://localhost:9996";
export const EVM_RPC_URL = process.env.EVM_RPC_URL ?? "http://localhost:8545";

export const CONTRACT_ADDRESS_FILE = resolve(
  REPO_ROOT,
  "packages/shared/contracts/midnight/go-fish-contract.undeployed.json",
);
export const ZK_CONFIG_PATH = resolve(
  REPO_ROOT,
  "packages/shared/contracts/midnight/go-fish-contract/src/managed",
);

export const DELEGATED_SENTINEL = "GoFish: delegated to midnight_balancing batcher";

/** Jubjub prime-order subgroup order — secrets must be in [1, r) */
export const JUBJUB_R =
  0x0e7db4ea6533afa906673b0101343b00a6682093ccc81082d0970e5ed6f72cb7n;

/**
 * Fixed scalar used as the admin witness in e2e tests. Reproducible across
 * runs so that a later run against the same deploy picks up its own prior
 * `initialize()` (stored `owner == h_hashField(TEST_ADMIN_SECRET)`).
 *
 * Value is arbitrary — any non-zero scalar in [1, JUBJUB_R). Override via
 * `TEST_ADMIN_SECRET` env var if you need to impersonate a different admin.
 */
export const TEST_ADMIN_SECRET: bigint = (() => {
  const raw = process.env.TEST_ADMIN_SECRET;
  if (raw && /^0x[0-9a-fA-F]+$/.test(raw)) return BigInt(raw);
  // Default: a readable constant in the Jubjub scalar field.
  return 0x5e1c33e17a1e600d5eed9a1c01f135cf5e1e7a5e1f1e5e1e5e1e5e1e5e1e5e1en;
})();

/**
 * Wait timing budgets — based on observed backend latencies.
 * EVM (lobby): ~5s typical → 30s headroom.
 * Midnight (indexer / API / DB): up to 2 minutes for state confirmation.
 */
export const EVM_WAIT_MS = 30_000;
export const MIDNIGHT_WAIT_MS = 120_000;

/** Hardhat default test accounts — index 0 is reserved for the batcher. */
export const HARDHAT_KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", // #0 batcher
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", // #1 P1
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", // #2 P2
];

/** Address-type enum value for EVM (matches paima-engine CryptoManager). */
export const ADDRESS_TYPE_EVM = 0;

/**
 * GamePhase enum values (from GoFish.compact:4 — authoritative order).
 *
 * Contract V3.3: `WaitForDraw` is active again — it's set by
 * `requestToDrawCard` (empty-handed player with a non-empty deck) and
 * cleared by the opponent's `drawCard`. `WaitForDrawCheck` still covers
 * the post-`respondToAsk` go-fish branch resolved by `afterGoFish`.
 */
export const PHASE = {
  Setup: 0,
  TurnStart: 1,
  WaitForResponse: 2,
  WaitForTransfer: 3,
  WaitForDraw: 4, // V3.3: requestToDrawCard → drawCard flow
  WaitForDrawCheck: 5,
  GameOver: 6,
} as const;

/** Simplified 21-card deck: 7 ranks (A,2-7) × 3 suits (h,d,c) */
export const RANKS = ["A", "2", "3", "4", "5", "6", "7"] as const;
export const SUITS = ["h", "d", "c"] as const;
export function cardName(idx: number): string {
  return `${RANKS[idx % 7]}${SUITS[Math.floor(idx / 7)]}`;
}

// ---------------------------------------------------------------------------
// Filesystem + crypto helpers
// ---------------------------------------------------------------------------

export function loadContractAddress(): string {
  return JSON.parse(readFileSync(CONTRACT_ADDRESS_FILE, "utf-8"))
    .contractAddress.replace(/^0x/, "");
}

export function generatePlayerSecret(): bigint {
  while (true) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const n = BigInt(
      "0x" + Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join(""),
    );
    if (n >= 1n && n < JUBJUB_R) return n;
  }
}

export function generateShuffleSeed(): Uint8Array {
  const seed = new Uint8Array(32);
  crypto.getRandomValues(seed);
  return seed;
}

export function randomGameId(): Uint8Array {
  const id = new Uint8Array(32);
  crypto.getRandomValues(id);
  return id;
}

export function gameIdToHex(gameId: Uint8Array): string {
  return (
    "0x" + Array.from(gameId).map(b => b.toString(16).padStart(2, "0")).join("")
  );
}

/** Contract's `now` parameter is seconds since epoch (matches frontend). */
export function nowSeconds(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}

/**
 * Encode a Paima-issued lobbyId string into the contract's 32-byte gameId.
 * UTF-8 encode the lobbyId, copy up to 32 bytes, zero-pad the rest.
 * Matches the convention in the old in-process simulator.
 */
export function lobbyIdToGameId(lobbyId: string): Uint8Array {
  const enc = new TextEncoder().encode(lobbyId);
  const g = new Uint8Array(32);
  g.set(enc.slice(0, 32));
  return g;
}

// ---------------------------------------------------------------------------
// Lobby POST — batcher /send-input with effectstreaml2 target (signed)
// ---------------------------------------------------------------------------

export const SECURITY_NAMESPACE = "evm-midnight-node";

/**
 * Port of effectstream's `createMessageForBatcher` (`@effectstream/concise`).
 * The batcher and the node both rebuild this exact string and verify the
 * signature against it.
 *
 * IMPORTANT — `namespace` must match `evm-midnight-node` on batcher, frontend,
 * and node. `target` is omitted (treated as "") so routing uses defaultTarget.
 */
export function createMessageForBatcher(
  namespace: string | null,
  millisecondTimestamp: string,
  walletAddress: string,
  _addressType: number,
  inputData: string,
  target: string | undefined = undefined,
): string {
  return ((namespace ?? "") + (target ?? "") + millisecondTimestamp + walletAddress + inputData)
    .replace(/[^a-zA-Z0-9]/g, "-")
    .toLocaleLowerCase();
}

/**
 * POST a concise lobby command to the batcher. Signs with an ethers wallet
 * and lets the batcher route to its `defaultTarget` (effectstreaml2) by
 * omitting the `target` field — see notes on createMessageForBatcher.
 *
 * Use generateStmInput(grammar, "createdLobby", { ... }) to construct the
 * conciseData tuple from the typed grammar.
 */
export async function postLobby(
  wallet: ethers.Wallet,
  conciseData: unknown[],
): Promise<void> {
  const timestamp = Date.now().toString();
  const inputStr = JSON.stringify(conciseData);
  const message = createMessageForBatcher(
    SECURITY_NAMESPACE,
    timestamp,
    wallet.address,
    ADDRESS_TYPE_EVM,
    inputStr,
    undefined, // target omitted (paima-engine 0.10.24 quirk)
  );
  const signature = await wallet.signMessage(message);

  const body = {
    data: {
      // target intentionally omitted — batcher uses defaultTarget
      addressType: ADDRESS_TYPE_EVM,
      address: wallet.address,
      signature,
      input: inputStr,
      timestamp,
    },
    confirmationLevel: "no-wait",
  };

  console.log(`  [batcher] lobby ${conciseData[0]} (${wallet.address.slice(0, 8)}…)`);
  const res = await fetch(`${BATCHER_URL}/send-input`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`batcher rejected lobby ${conciseData[0]}: ${text}`);
  }
}

// ---------------------------------------------------------------------------
// Paima REST API — read EVM lobby metadata
// ---------------------------------------------------------------------------

export async function getUserLobbies(walletAddress: string): Promise<any[]> {
  const res = await fetch(
    `${PAIMA_API_URL}/user_lobbies?wallet=${walletAddress.toLowerCase()}&page=0&count=50`,
  );
  if (!res.ok) throw new Error(`user_lobbies: ${res.status}`);
  return (await res.json()).lobbies ?? [];
}

export async function getLobbyState(lobbyId: string): Promise<any> {
  const res = await fetch(`${PAIMA_API_URL}/lobby_state?lobby_id=${lobbyId}`);
  if (!res.ok) throw new Error(`lobby_state: ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Lobby flow — createdLobby → joinedLobby (auto-starts the game)
// ---------------------------------------------------------------------------

/**
 * Drive the full EVM lobby flow through the batcher. Returns the lobbyId
 * once the game is `in_progress`.
 *
 * Go Fish is a 2-player game with auto-start: the second joinedLobby
 * transition flips the lobby to in_progress in the same state-machine step.
 * There are no separate ready/start commands.
 */
export async function runLobbyFlow(
  p1Wallet: ethers.Wallet,
  p2Wallet: ethers.Wallet,
  lobbyName: string,
): Promise<string> {
  console.log(`\n── Lobby flow: "${lobbyName}" ──`);

  // Snapshot existing lobbies so we can detect the new one
  const before = await getUserLobbies(p1Wallet.address);
  const beforeIds = new Set(before.map((l: any) => l.lobby_id));

  // P1 creates
  const conciseCreate = generateStmInput(grammar, "createdLobby", {
    playerName: "P1",
    lobbyName,
  });
  await postLobby(p1Wallet, conciseCreate as unknown as unknown[]);

  const newLobby = await waitFor(
    "lobby created",
    EVM_WAIT_MS,
    async () => {
      const lobbies = await getUserLobbies(p1Wallet.address);
      return lobbies.find((l: any) => !beforeIds.has(l.lobby_id)) ?? null;
    },
    v => v != null,
  );
  const lobbyId = String((newLobby as any).lobby_id);
  console.log(`  ✓ lobby created: ${lobbyId}`);

  // P2 joins — this auto-starts the game in the same state transition.
  const conciseJoin = generateStmInput(grammar, "joinedLobby", {
    playerName: "P2",
    lobbyID: lobbyId,
  });
  await postLobby(p2Wallet, conciseJoin as unknown as unknown[]);

  await waitFor(
    "game in_progress",
    EVM_WAIT_MS,
    async () => (await getLobbyState(lobbyId)).status,
    v => v === "in_progress",
  );

  console.log(`  ✓ game in_progress (lobbyId=${lobbyId})`);
  return lobbyId;
}

// ---------------------------------------------------------------------------
// Batcher POST — midnight_balancing
// ---------------------------------------------------------------------------

export function detectTxStage(
  serializedTx: string,
): "unproven" | "unbound" | "finalized" {
  const prefixBytes = new Uint8Array(
    serializedTx
      .slice(0, 600)
      .padEnd(600, "0")
      .match(/.{2}/g)!
      .map(b => parseInt(b, 16)),
  );
  const header = new TextDecoder().decode(prefixBytes);
  const m = header.match(
    /midnight:(?:transaction|intent)\[v\d+\]\(signature\[v\d+\],([^,]+),([^)]+)\):/,
  );
  if (!m) throw new Error(`detectTxStage: cannot parse: ${header.slice(0, 80)}`);
  if (m[1]!.includes("proof-preimage")) return "unproven";
  if (m[2]!.includes("embedded-fr")) return "unbound";
  if (m[2]!.includes("pedersen-schnorr")) return "finalized";
  throw new Error(`detectTxStage: unknown: ${m[1]} / ${m[2]}`);
}

export async function postMidnightTx(
  serializedTx: string,
  circuitId: string,
  meta: { playerId?: number; lobbyId?: string } = {},
): Promise<void> {
  const txStage = detectTxStage(serializedTx);
  console.log(
    `  [batcher] ${circuitId}: txStage=${txStage}, len=${serializedTx.length / 2}B`,
  );

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
// Delegating provider — intercepts balanceTx, POSTs to batcher, throws sentinel
// ---------------------------------------------------------------------------

export function makeDelegatingProvider() {
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
      throw new Error("submitTx should never be called — delegated");
    },
    __delegatedBalanceHook: undefined as undefined | ((tx: any) => Promise<void>),
  };
  return provider;
}

export function isDelegationError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  let e: Error | undefined = err;
  while (e) {
    if (e.message.includes(DELEGATED_SENTINEL)) return true;
    e = e.cause instanceof Error ? e.cause : undefined;
  }
  return false;
}

export async function callDelegated(
  provider: any,
  circuitId: string,
  invoke: () => Promise<any>,
  meta: { playerId?: number; lobbyId?: string } = {},
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
// Local Contract reader (runs impure circuits against indexer state)
// ---------------------------------------------------------------------------

/**
 * Build a local Contract instance for read-only impureCircuit evaluation.
 * Both this local contract AND the deployed contract (via CompiledContract)
 * MUST share the same witness state — otherwise reads and submissions can
 * see different secrets, which is exactly BACKEND_ISSUES #1.
 */
export function buildLocalContract(witnessState: WitnessState) {
  const localContract: any = new GoFishContract(makeTestWitnesses(witnessState) as any);
  const init = localContract.initialState(
    createConstructorContext({}, "0".repeat(64)),
  );
  return {
    localContract,
    initialPrivateState: init.currentPrivateState,
    initialZswap: init.currentZswapLocalState,
  };
}

/** Sentinel returned when a map lookup fails because the key doesn't exist. */
export type Missing = { __missing: true };
export function isMissing<T>(v: T | Missing): v is Missing {
  return typeof v === "object" && v !== null && (v as any).__missing === true;
}

export async function readCircuit<T = any>(
  publicDataProvider: any,
  contractAddress: string,
  localContract: any,
  initialPrivateState: any,
  initialZswap: any,
  circuitName: string,
  ...args: any[]
): Promise<T | Missing> {
  const cs = await publicDataProvider.queryContractState(contractAddress);
  if (!cs) throw new Error("queryContractState returned null");
  const ctx = {
    currentPrivateState: initialPrivateState,
    currentZswapLocalState: initialZswap,
    currentQueryContext: new QueryContext(cs.data, sampleContractAddress()),
    costModel: CostModel.initialCostModel(),
  };
  try {
    return localContract.impureCircuits[circuitName](ctx, ...args).result as T;
  } catch (err) {
    const msg = (err as Error).message ?? "";
    if (
      msg.includes("expected a cell, received null") ||
      msg.includes("not present")
    ) {
      return { __missing: true };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// waitFor — poll a fetcher until a predicate matches
// ---------------------------------------------------------------------------

export async function waitFor<T>(
  label: string,
  timeoutMs: number,
  fetcher: () => Promise<T>,
  predicate: (v: T) => boolean,
  intervalMs = 2000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fetcher();
    if (predicate(v)) {
      console.log(`  ✓ ${label}: matched (${safeJson(v)})`);
      return v;
    }
    const remaining = Math.round((deadline - Date.now()) / 1000);
    console.log(`  [poll] ${label} pending (${safeJson(v)}, ${remaining}s left)`);
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`Timeout: ${label}`);
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, (_k, val) =>
      typeof val === "bigint" ? val.toString() + "n" : val,
    );
  } catch {
    return String(v);
  }
}

// ---------------------------------------------------------------------------
// One-shot session bootstrapper — sets up providers, joins contract,
// returns a `read` function and the deployed contract + delegating provider.
// ---------------------------------------------------------------------------

export interface SmokeSession {
  contractAddress: string;
  contract: any;
  walletProvider: any;
  publicDataProvider: any;
  read: <T = any>(name: string, ...args: any[]) => Promise<T | Missing>;
  /** Test-owned witness state — set/clear secrets here, never via the
   *  default `@go-fish/midnight-contract` setPlayerSecrets module global. */
  witnessState: WitnessState;
}

export async function createSmokeSession(
  privateStateId: string,
): Promise<SmokeSession> {
  setNetworkId("undeployed");

  const contractAddress = loadContractAddress();
  const zkConfigProvider = new NodeZkConfigProvider<string>(ZK_CONFIG_PATH);
  const proofProvider = httpClientProofProvider(PROOF_URL, zkConfigProvider);
  const publicDataProvider = indexerPublicDataProvider(
    INDEXER_HTTP_URL,
    INDEXER_WS_URL,
  );
  const privateStateProvider = createInMemoryPrivateStateProvider(privateStateId);
  const walletProvider = makeDelegatingProvider();

  // Test-owned witness state. Both the deployed contract and the local
  // read contract use the SAME instance — they cannot diverge on what a
  // player's secret is.
  const witnessState = new WitnessState();
  witnessState.setAdminSecret(TEST_ADMIN_SECRET);
  const testWitnesses = makeTestWitnesses(witnessState);

  const compiledContract = CompiledContract.make("go-fish", GoFishContract as any)
    .pipe(
      CompiledContract.withWitnesses(testWitnesses as any),
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
      privateStateId: privateStateId as any,
      initialPrivateState: {},
    } as any,
  );
  console.log("  ✓ contract joined");

  const { localContract, initialPrivateState, initialZswap } =
    buildLocalContract(witnessState);

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

  return {
    contractAddress,
    contract,
    walletProvider,
    publicDataProvider,
    read,
    witnessState,
  };
}

// ---------------------------------------------------------------------------
// One-shot deploy-time init_deck — must run once per contract deployment
// ---------------------------------------------------------------------------

/**
 * Query the `staticDeckInitialized` Boolean via raw VM query ops. The
 * go-fish contract uses module-scoped ledger storage (module `GoFish`,
 * `GoFish.compact:4`), so we can't reach the field through the typed
 * `ledger()` decoder (which is empty for module-based contracts). Reading
 * it as VM ops on the indexer's `ContractState` is how the frontend's
 * `GoFishContractService.queryIsStaticDeckInitialized` does it.
 *
 * Path is the compiled accessor for `Deck::staticDeckInitialized` in the
 * current contract build. Contract V3 restructured the ledger layout (added
 * booksP1/P2 + initialBooksScoredP1/P2), shifting slot indices — the
 * compiled `_init_static_deck_0` now reads at `[0n, 2n]` (see
 * managed/contract/index.js:2523 `queryLedgerState` ops). Keep this path in
 * sync with that function after every `bun run --filter @go-fish/midnight-contract compact`.
 */
async function queryStaticDeckInitialized(
  publicDataProvider: any,
  contractAddress: string,
): Promise<boolean> {
  const contractState = await publicDataProvider.queryContractState(contractAddress);
  if (!contractState) return false;

  const keyType = new CompactTypeUnsignedInteger(255n, 1);
  const keyOuter = { value: keyType.toValue(0n), alignment: keyType.alignment() };
  const keyInner = { value: keyType.toValue(2n), alignment: keyType.alignment() };

  try {
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
    if (!first || first.tag !== "read") return false;
    return CompactTypeBoolean.fromValue(first.content.value);
  } catch {
    return false;
  }
}

/**
 * Make sure the contract's global `staticDeckInitialized` flag is true.
 * Called once at the start of the e2e — on a fresh deploy the flag is
 * false and `applyMask` would fail its internal assert "Static deck not
 * initialized - call init_static_deck first".
 *
 * `init_deck()` is a one-shot wrapper around `init_static_deck()`: the
 * body is idempotent internally (it checks the flag and returns early),
 * but calling it unconditionally still costs a full proof round-trip,
 * so we skip when the flag is already true.
 */
export async function ensureStaticDeckInitialized(
  session: SmokeSession,
): Promise<void> {
  const already = await queryStaticDeckInitialized(
    session.publicDataProvider,
    session.contractAddress,
  );
  if (already) {
    console.log("  staticDeckInitialized: already true (skipping init_deck)");
    return;
  }

  console.log("\n── init_deck() (first run on this deploy) ──");
  await callDelegated(
    session.walletProvider,
    "init_deck",
    () => session.contract.callTx.init_deck(),
  );
  await waitFor(
    "staticDeckInitialized: false → true",
    MIDNIGHT_WAIT_MS,
    () =>
      queryStaticDeckInitialized(
        session.publicDataProvider,
        session.contractAddress,
      ),
    v => v === true,
  );
}

// ---------------------------------------------------------------------------
// One-shot owner initialization (Contract V4)
// ---------------------------------------------------------------------------

/**
 * Contract V4 adds a one-shot `initialize()` that stores
 * `h_hashField(admin_secret_key())` as the contract `owner`. Subsequent
 * owner-only ops (`cleanupGame(callerPlayerId=0)`) re-derive the hash from
 * the witness and compare.
 *
 * Our test session sets `TEST_ADMIN_SECRET` on the witness state at session
 * construction. This helper:
 *   - Reads `isOwner()` — if true, we're already the registered owner
 *     (same `TEST_ADMIN_SECRET`); nothing to do.
 *   - Otherwise submits `initialize()` and polls until `isOwner()` becomes
 *     true.
 *   - If the call reverts with "Owner already initialized" (somebody else
 *     initialized with a different secret), polls once more; if still
 *     `false`, logs a warning and continues. Gameplay isn't gated on
 *     admin identity — only the owner-path of `cleanupGame` is, so
 *     non-owner sessions can still play but can't run owner-cleanup.
 */
export async function ensureOwnerInitialized(session: SmokeSession): Promise<void> {
  const { contract, walletProvider, read } = session;

  const already = await read<boolean>("isOwner");
  if (!isMissing(already) && already === true) {
    console.log("  owner: already initialized (TEST_ADMIN_SECRET matches stored owner)");
    return;
  }

  console.log("\n── initialize() (V4 one-shot owner setup) ──");
  try {
    await callDelegated(
      walletProvider,
      "initialize",
      () => contract.callTx.initialize(),
    );
  } catch (err) {
    // callDelegated swallows the balance-delegation sentinel; anything
    // that escapes here is a pre-serialization contract assert. Most
    // likely: "Owner already initialized" under a different secret.
    console.log(`  [warn] initialize() threw: ${(err as Error).message}`);
  }

  // Poll — with a shorter budget than MIDNIGHT_WAIT_MS. If this times out
  // the tx landed but our secret doesn't match the stored owner; gameplay
  // still works, only the owner-cleanup path is unreachable.
  const ownerWaitMs = Math.min(MIDNIGHT_WAIT_MS, 90_000);
  try {
    await waitFor(
      "isOwner(): false → true",
      ownerWaitMs,
      () => read<boolean>("isOwner"),
      v => v === true,
    );
  } catch {
    console.log(
      "  [warn] isOwner() did not flip to true — session is not the registered owner.\n" +
      "          Gameplay proceeds; owner-path cleanupGame will be unavailable.",
    );
  }
}

// ---------------------------------------------------------------------------
// Cleanup (Contract V4) — optional post-game tidy
// ---------------------------------------------------------------------------

/**
 * Submit `cleanupGame(gameId, callerPlayerId)`. Two modes:
 *   - `callerPlayerId = 0n` — owner path. Requires the session's admin
 *     secret to match the stored owner hash (see `ensureOwnerInitialized`).
 *     Works at any phase, any game.
 *   - `callerPlayerId = 1n | 2n` — participant path. The contract requires
 *     `phase == GameOver`. Caller's player-secret hash must match the
 *     player slot's registered hash (our test witness provides it).
 *
 * Gated in the full e2e by env flag `RUN_CLEANUP=1` to avoid adding a
 * ~2-min tx to every run.
 */
export async function runCleanupGame(
  session: SmokeSession,
  gameId: Uint8Array,
  callerPlayerId: 0n | 1n | 2n = 0n,
): Promise<void> {
  console.log(`\n── cleanupGame (callerPlayerId=${callerPlayerId}) ──`);
  await callDelegated(
    session.walletProvider,
    `cleanupGame:${callerPlayerId}`,
    () => session.contract.callTx.cleanupGame(gameId, callerPlayerId),
  );
  // No direct ledger flag to poll — confirm via doesGameExist flipping false.
  await waitFor(
    "doesGameExist → false",
    MIDNIGHT_WAIT_MS,
    () => session.read<boolean>("doesGameExist", gameId),
    v => v === false || isMissing(v),
  );
  console.log("  ✓ cleanupGame settled; game state removed from ledger");
}

// ---------------------------------------------------------------------------
// Full per-game setup: applyMask×2 → dealCards×2, ending at TurnStart
// ---------------------------------------------------------------------------

export interface SetupResult {
  gameId: Uint8Array;
  gameIdHex: string;
  p1Secret: bigint;
  p2Secret: bigint;
  p1Seed: Uint8Array;
  p2Seed: Uint8Array;
}

export async function runFullSetup(
  session: SmokeSession,
  options: {
    gameId?: Uint8Array;
    p1Secret?: bigint;
    p2Secret?: bigint;
    p1Seed?: Uint8Array;
    p2Seed?: Uint8Array;
  } = {},
): Promise<SetupResult> {
  const gameId = options.gameId ?? randomGameId();
  const gameIdHex = gameIdToHex(gameId);
  const p1Secret = options.p1Secret ?? generatePlayerSecret();
  const p2Secret = options.p2Secret ?? generatePlayerSecret();
  const p1Seed = options.p1Seed ?? generateShuffleSeed();
  const p2Seed = options.p2Seed ?? generateShuffleSeed();

  console.log(`  gameId = ${gameIdHex.slice(0, 22)}...`);

  // Test-owned witness state: explicit set, no global, no fallback.
  // Both `session.contract` (deployed) and the local read contract share
  // this WitnessState, so reads and submissions cannot diverge.
  session.witnessState.set(gameIdHex, 1, p1Secret, p1Seed);
  session.witnessState.set(gameIdHex, 2, p2Secret, p2Seed);

  // Deploy-time one-shot: initialize the static deck if it hasn't been
  // done yet. Needed for applyMask's internal assert to pass.
  await ensureStaticDeckInitialized(session);

  // V4 deploy-time one-shot: establish owner hash so owner-scoped
  // circuits (cleanupGame with callerPlayerId=0) work later. Fine to
  // call after static-deck init since the two don't interact.
  await ensureOwnerInitialized(session);

  const { contract, walletProvider, read } = session;

  console.log("\n── applyMask(gameId, 1n) ──");
  await callDelegated(
    walletProvider,
    "applyMask:1",
    () => contract.callTx.applyMask(gameId, 1n),
    { playerId: 1 },
  );
  await waitFor(
    "hasMaskApplied(1)",
    MIDNIGHT_WAIT_MS,
    () => read<boolean>("hasMaskApplied", gameId, 1n),
    v => v === true,
  );

  console.log("\n── applyMask(gameId, 2n) ──");
  await callDelegated(
    walletProvider,
    "applyMask:2",
    () => contract.callTx.applyMask(gameId, 2n),
    { playerId: 2 },
  );
  await waitFor(
    "hasMaskApplied(2)",
    MIDNIGHT_WAIT_MS,
    () => read<boolean>("hasMaskApplied", gameId, 2n),
    v => v === true,
  );

  console.log("\n── dealCards(gameId, 1n) ──");
  await callDelegated(
    walletProvider,
    "dealCards:1",
    () => contract.callTx.dealCards(gameId, 1n),
    { playerId: 1 },
  );
  await waitFor(
    "hasDealt(1)",
    MIDNIGHT_WAIT_MS,
    () => read<boolean>("hasDealt", gameId, 1n),
    v => v === true,
  );

  console.log("\n── dealCards(gameId, 2n) ──");
  await callDelegated(
    walletProvider,
    "dealCards:2",
    () => contract.callTx.dealCards(gameId, 2n),
    { playerId: 2 },
  );
  await waitFor(
    "hasDealt(2)",
    MIDNIGHT_WAIT_MS,
    () => read<boolean>("hasDealt", gameId, 2n),
    v => v === true,
  );

  // V4.3: dealCards no longer flips phase — call the separate startGame
  // circuit to transition Setup → TurnStart once both hasDealt flags are on-chain.
  console.log("\n── startGame(gameId, 1n) ──");
  await callDelegated(
    walletProvider,
    "startGame:1",
    () => contract.callTx.startGame(gameId, 1n),
    { playerId: 1 },
  );
  await waitFor(
    "phase == TurnStart",
    MIDNIGHT_WAIT_MS,
    () => read<number | bigint>("getGamePhase", gameId),
    v => !isMissing(v) && Number(v) === PHASE.TurnStart,
  );

  // Contract V3.3: `scoreInitialBooks` is optional and no longer gates
  // `askForCard`. Setup returns at TurnStart and the turn loop proceeds
  // directly. Callers that want to claim an opening book can invoke
  // `runInitialBookScoring(session, gameId)` explicitly after setup.

  return { gameId, gameIdHex, p1Secret, p2Secret, p1Seed, p2Seed };
}

/**
 * Clear both players' witness secrets from the session-owned WitnessState.
 * Call from a `finally` block. After this, any further circuit call that
 * needs P1 or P2's secret for `gameIdHex` will throw immediately rather
 * than silently using a fallback.
 */
export function clearAllSecrets(session: SmokeSession, gameIdHex: string): void {
  session.witnessState.clearAll(gameIdHex);
}

// ---------------------------------------------------------------------------
// Hand reading — iterate 0..20 calling doesPlayerHaveSpecificCard
// ---------------------------------------------------------------------------

/**
 * Read a player's hand (their own private cards) by enumerating all 21
 * possible card indices via `doesPlayerHaveSpecificCard`. Requires the
 * player's secret to be set in the witness module before calling.
 */
export async function readHand(
  session: SmokeSession,
  gameId: Uint8Array,
  playerId: 1 | 2,
): Promise<number[]> {
  const hand: number[] = [];
  for (let i = 0; i < 21; i++) {
    const has = await session.read<boolean>(
      "doesPlayerHaveSpecificCard",
      gameId,
      BigInt(playerId),
      BigInt(i),
    );
    if (has === true) hand.push(i);
  }
  return hand;
}

export function handRanks(cards: number[]): number[] {
  return [...new Set(cards.map(c => c % 7))].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Initial book scoring — mandatory post-deal scan (Contract V3)
// ---------------------------------------------------------------------------

/** Sentinel passed when a player's 4-card deal has no 3-of-a-rank book. */
export const NO_INITIAL_BOOK: [bigint, bigint, bigint] = [255n, 255n, 255n];

/**
 * From a 4-card initial hand (indices 0..20), detect the 3 cards forming a
 * book and return their indices as bigints; return `NO_INITIAL_BOOK`
 * (`[255,255,255]`) when no three share a rank.
 *
 * Returns the lowest-indexed book when multiple exist. A 4-card hand can
 * at most contain one book (needs 3 of one rank; the 4th card takes the
 * remaining slot), so that tie-break is essentially defensive.
 */
export function computeInitialBookIndices(
  hand: number[],
): [bigint, bigint, bigint] {
  const byRank = new Map<number, number[]>();
  for (const idx of hand) {
    const rank = idx % 7;
    const bucket = byRank.get(rank) ?? [];
    bucket.push(idx);
    byRank.set(rank, bucket);
  }
  for (const [, indices] of [...byRank.entries()].sort((a, b) => a[0] - b[0])) {
    if (indices.length >= 3) {
      const sorted = [...indices].sort((a, b) => a - b);
      return [BigInt(sorted[0]!), BigInt(sorted[1]!), BigInt(sorted[2]!)];
    }
  }
  return NO_INITIAL_BOOK;
}

/**
 * If the player's initial hand contains a book (3 of a rank), submit
 * `scoreInitialBooks` to claim it. Otherwise skip — Contract V3.3 makes
 * this circuit optional, and the sentinel path exists only for cases
 * where a frontend wants to set the `initialBooksScoredP<id>` flag
 * without claiming anything (no longer useful in V3.3 since the flag
 * doesn't gate `askForCard`).
 *
 * Reference behavior the frontend ports from:
 *   1. Read the post-deal hand (here via `readHand`; frontend uses the
 *      cheaper `discoverHand` batch circuit).
 *   2. Compute `bookIndices` off-chain — three card indices if 3 of the 4
 *      cards share a rank, else `NO_INITIAL_BOOK`.
 *   3. If a book exists: submit `scoreInitialBooks(gameId, playerId, bookIndices, now)`
 *      and poll `hasInitialBooksScored` / `getBookedRanks` until settled.
 *   4. Otherwise: do nothing.
 *
 * Parallel-safe across players when both are submitting (per-player
 * ledger slots don't conflict), but we run sequentially for reproducible
 * logs.
 */
export async function scoreInitialBooksForPlayer(
  session: SmokeSession,
  gameId: Uint8Array,
  playerId: 1 | 2,
): Promise<{
  playerId: 1 | 2;
  bookIndices: [bigint, bigint, bigint];
  bookedRank: number | null;
  submitted: boolean;
}> {
  const { contract, walletProvider, read } = session;

  const hand = await readHand(session, gameId, playerId);
  const bookIndices = computeInitialBookIndices(hand);

  if (bookIndices === NO_INITIAL_BOOK) {
    console.log(
      `  P${playerId} initial hand [${hand.map(cardName).join(" ")}] — no book, skipping scoreInitialBooks`,
    );
    return { playerId, bookIndices, bookedRank: null, submitted: false };
  }

  const bookedRank = Number(bookIndices[0]) % 7;
  console.log(
    `  P${playerId} initial hand [${hand.map(cardName).join(" ")}] — book of ${RANKS[bookedRank]} at [${bookIndices.map(String).join(",")}], submitting`,
  );

  await callDelegated(
    walletProvider,
    `scoreInitialBooks:${playerId}`,
    () =>
      contract.callTx.scoreInitialBooks(
        gameId,
        BigInt(playerId),
        bookIndices as unknown as bigint[],
        nowSeconds(),
      ),
    { playerId },
  );
  await waitFor(
    `hasInitialBooksScored(${playerId})`,
    MIDNIGHT_WAIT_MS,
    () => read<boolean>("hasInitialBooksScored", gameId, BigInt(playerId)),
    v => v === true,
  );

  return { playerId, bookIndices, bookedRank, submitted: true };
}

/**
 * Optionally claim opening books for both players.
 *
 * Contract V3.3 does NOT require `scoreInitialBooks` — `askForCard` no
 * longer asserts `initialBooksScoredP1/P2`. This helper is now a
 * best-effort convenience: each player submits only if their initial
 * hand has 3-of-a-rank. Sentinel cases are skipped to avoid a ~2-min
 * no-op tx in the common case (~97% of random 4-card deals).
 *
 * Call this from a test explicitly when you want to exercise the
 * opening-book scoring path; `runFullSetup` no longer invokes it
 * automatically.
 */
export async function runInitialBookScoring(
  session: SmokeSession,
  gameId: Uint8Array,
): Promise<{
  p1: Awaited<ReturnType<typeof scoreInitialBooksForPlayer>>;
  p2: Awaited<ReturnType<typeof scoreInitialBooksForPlayer>>;
}> {
  console.log("\n── scoreInitialBooks (post-deal scan, both players) ──");
  const p1 = await scoreInitialBooksForPlayer(session, gameId, 1);
  const p2 = await scoreInitialBooksForPlayer(session, gameId, 2);
  return { p1, p2 };
}

/**
 * Read a player's booked ranks as a 7-wide boolean vector. `result[r] ===
 * true` means the player has scored a book for rank `r` (A,2..7). Total
 * books for a player = number of `true` entries (≤ 4 by game construction).
 */
export async function readBookedRanks(
  session: SmokeSession,
  gameId: Uint8Array,
  playerId: 1 | 2,
): Promise<boolean[]> {
  const v = await session.read<boolean[]>(
    "getBookedRanks",
    gameId,
    BigInt(playerId),
  );
  if (isMissing(v)) return [false, false, false, false, false, false, false];
  return v;
}

/** Pretty-print a 7-wide booked-ranks vector: `[A,3,6]` for ranks at true. */
export function formatBookedRanks(vec: boolean[]): string {
  const names: string[] = [];
  for (let r = 0; r < vec.length; r++) {
    if (vec[r]) names.push(RANKS[r] ?? String(r));
  }
  return names.length === 0 ? "(none)" : `[${names.join(",")}]`;
}

// ---------------------------------------------------------------------------
// Turn loop primitives — playOneTurn, runFullGame
// ---------------------------------------------------------------------------

/**
 * `action` distinguishes which V3.3 flow a turn took:
 *   - "ask":          normal askForCard → respondToAsk → optional
 *                      afterGoFish / checkAndScoreBook
 *   - "drawFromDeck": caller's hand was empty and deck had cards —
 *                      requestToDrawCard + opponent's drawCard
 *   - "skipTurn":     caller's hand AND deck both empty — bare switch-turn
 *   - "noop":         turn didn't execute (e.g. phase already GameOver)
 */
export type TurnAction = "ask" | "drawFromDeck" | "skipTurn" | "noop";

export interface TurnResult {
  turn: number;
  action: TurnAction;
  playerId: 1 | 2;
  opponent: 1 | 2;
  askRank: number | null;
  handBefore: number[];
  oppHandBefore: number[];
  handAfter: number[];
  oppHandAfter: number[];
  gotCards: boolean;
  wentFishing: boolean;
  /** For "ask" with transfer: whether the follow-up checkAndScoreBook reported a book. */
  bookScored: boolean;
  ended: boolean;
  endReason?: string;
}

/**
 * Drive one full turn. Contract V3.3 has three distinct per-turn flows:
 *
 *   1. "ask" — hand is non-empty. Normal askForCard → respondToAsk. On
 *      a successful transfer (phase → TurnStart) the client then calls
 *      `checkAndScoreBook(gameId, asker, askedRank)` to score any book
 *      the transferred card completed (V3.1 bug fix: respondToAsk no
 *      longer inlines the asker-side book scoring because the opponent's
 *      secret isn't real in the responder's circuit context). On a
 *      go-fish transition (phase → WaitForDrawCheck), `afterGoFish` is
 *      called and auto-books any rank the drawn card completes.
 *
 *   2. "drawFromDeck" — hand is empty but the deck still has cards.
 *      `askForCard` strictly rejects empty-hand calls in V3.3, so the
 *      caller uses `requestToDrawCard` (phase → WaitForDraw), and the
 *      opponent finishes with `drawCard` (strips their mask from the
 *      top deck card and inserts it into the asker's hand). No book
 *      check needed — a single new card in a previously empty hand
 *      can't complete a book. Turn switches internally.
 *
 *   3. "skipTurn" — hand AND deck are both empty. `skipTurn` bare
 *      switches the turn; no card movement.
 *
 * Returns a `TurnResult` describing what happened. When `ended === true`
 * the caller should break the loop (phase already GameOver, unexpected
 * state, etc.).
 */
export async function playOneTurn(
  session: SmokeSession,
  gameId: Uint8Array,
  turnNumber: number,
): Promise<TurnResult> {
  const { contract, walletProvider, read } = session;

  const baseEmpty: TurnResult = {
    turn: turnNumber,
    action: "noop",
    playerId: 1,
    opponent: 2,
    askRank: null,
    handBefore: [],
    oppHandBefore: [],
    handAfter: [],
    oppHandAfter: [],
    gotCards: false,
    wentFishing: false,
    bookScored: false,
    ended: true,
  };

  // Phase check
  const phaseRaw = await read<number | bigint>("getGamePhase", gameId);
  if (isMissing(phaseRaw)) {
    return { ...baseEmpty, endReason: "getGamePhase missing" };
  }
  const phase = Number(phaseRaw);
  if (phase === PHASE.GameOver) {
    return { ...baseEmpty, endReason: "phase == GameOver" };
  }
  if (phase !== PHASE.TurnStart) {
    return { ...baseEmpty, endReason: `unexpected phase ${phase} at turn start` };
  }

  // Whose turn?
  const playerId = Number(await read<number | bigint>("getCurrentTurn", gameId)) as 1 | 2;
  const opponent = (playerId === 1 ? 2 : 1) as 1 | 2;

  // Read both hands (debug visibility — prints on the test stdout)
  const handBefore = await readHand(session, gameId, playerId);
  const oppHandBefore = await readHand(session, gameId, opponent);

  console.log(`\n══ Turn ${turnNumber} ══`);
  console.log(`  P${playerId} hand: ${handBefore.map(cardName).join(" ") || "(empty)"} [${handBefore.length}]`);
  console.log(`  P${opponent} hand: ${oppHandBefore.map(cardName).join(" ") || "(empty)"} [${oppHandBefore.length}]`);

  // ─── Branch 2 + 3: empty hand → drawFromDeck or skipTurn ─────────────
  if (handBefore.length === 0) {
    const deckEmptyRaw = await read<boolean>("isDeckEmpty", gameId);
    const deckEmpty = !isMissing(deckEmptyRaw) && deckEmptyRaw === true;

    if (deckEmpty) {
      return runSkipTurn({
        session,
        gameId,
        turnNumber,
        playerId,
        opponent,
        handBefore,
        oppHandBefore,
      });
    }
    return runDrawFromDeck({
      session,
      gameId,
      turnNumber,
      playerId,
      opponent,
      handBefore,
      oppHandBefore,
    });
  }

  // ─── Branch 1: non-empty hand → normal ask flow ──────────────────────
  const askRank = handRanks(handBefore)[0]!;
  console.log(`  → P${playerId} asks P${opponent} for ${RANKS[askRank]}`);

  await callDelegated(
    walletProvider,
    `askForCard:t${turnNumber}`,
    () => contract.callTx.askForCard(gameId, BigInt(playerId), BigInt(askRank), nowSeconds()),
    { playerId },
  );
  await waitFor(
    "phase == WaitForResponse",
    MIDNIGHT_WAIT_MS,
    () => read<number | bigint>("getGamePhase", gameId),
    v => !isMissing(v) && Number(v) === PHASE.WaitForResponse,
  );

  // Opponent responds
  await callDelegated(
    walletProvider,
    `respondToAsk:t${turnNumber}`,
    () => contract.callTx.respondToAsk(gameId, BigInt(opponent), nowSeconds()),
    { playerId: opponent },
  );
  const postRespondRaw = await waitFor(
    "phase != WaitForResponse",
    MIDNIGHT_WAIT_MS,
    () => read<number | bigint>("getGamePhase", gameId),
    v => !isMissing(v) && Number(v) !== PHASE.WaitForResponse,
  );
  const postRespond = Number(postRespondRaw);

  let gotCards = false;
  let wentFishing = false;
  let bookScored = false;

  if (postRespond === PHASE.WaitForDrawCheck) {
    // Go Fish: respondToAsk auto-drew a card from the deck for the asker.
    // afterGoFish decrypts it + auto-books at the drawn rank if completed.
    wentFishing = true;
    console.log(`  → Go Fish (P${playerId} drew from deck)`);
    await callDelegated(
      walletProvider,
      `afterGoFish:t${turnNumber}`,
      () => contract.callTx.afterGoFish(gameId, BigInt(playerId), nowSeconds()),
      { playerId },
    );
    await waitFor(
      "phase out of WaitForDrawCheck",
      MIDNIGHT_WAIT_MS,
      () => read<number | bigint>("getGamePhase", gameId),
      v => !isMissing(v) && Number(v) !== PHASE.WaitForDrawCheck,
    );
  } else if (postRespond === PHASE.TurnStart) {
    gotCards = true;
    console.log(`  → P${opponent} had cards, transferred`);

    // V3.1 asker-side book follow-up: re-read the asker's hand and check
    // if the transfer completed a book at askRank. If so, submit
    // checkAndScoreBook (the responder couldn't inline it because their
    // circuit context sees a dummy asker-secret).
    const handPostTransfer = await readHand(session, gameId, playerId);
    const countAtAsked = handPostTransfer.filter(c => c % 7 === askRank).length;
    if (countAtAsked >= 3) {
      console.log(
        `  ★ P${playerId} now has ${countAtAsked}× ${RANKS[askRank]} — calling checkAndScoreBook`,
      );
      await callDelegated(
        walletProvider,
        `checkAndScoreBook:t${turnNumber}:r${askRank}`,
        () =>
          contract.callTx.checkAndScoreBook(
            gameId,
            BigInt(playerId),
            BigInt(askRank),
          ),
        { playerId },
      );
      await waitFor(
        `booksP${playerId}[${RANKS[askRank]}] == true`,
        MIDNIGHT_WAIT_MS,
        () => read<boolean[]>("getBookedRanks", gameId, BigInt(playerId)),
        v => !isMissing(v) && v[askRank] === true,
      );
      bookScored = true;
    }
  } else if (postRespond === PHASE.GameOver) {
    return {
      ...baseEmpty,
      action: "ask",
      ended: true,
      playerId,
      opponent,
      askRank,
      handBefore,
      oppHandBefore,
      endReason: "GameOver via respondToAsk",
    };
  } else {
    console.log(`  [warn] unexpected postRespond phase: ${postRespond}`);
  }

  // Read final hands for this turn
  const handAfter = await readHand(session, gameId, playerId);
  const oppHandAfter = await readHand(session, gameId, opponent);

  return {
    turn: turnNumber,
    action: "ask",
    playerId,
    opponent,
    askRank,
    handBefore,
    oppHandBefore,
    handAfter,
    oppHandAfter,
    gotCards,
    wentFishing,
    bookScored,
    ended: false,
  };
}

/**
 * V3.3 empty-hand / non-empty-deck flow.
 *
 * Sequence:
 *   1. Asker calls `requestToDrawCard(gameId, askerId, now)` —
 *      phase transitions to `WaitForDraw`.
 *   2. Opponent calls `drawCard(gameId, opponentId, now)` — strips
 *      their mask from the top deck card, inserts it into the asker's
 *      hand, advances the deck, switches turn. No `afterGoFish` needed;
 *      a 0→1 card hand cannot form a book.
 */
async function runDrawFromDeck(args: {
  session: SmokeSession;
  gameId: Uint8Array;
  turnNumber: number;
  playerId: 1 | 2;
  opponent: 1 | 2;
  handBefore: number[];
  oppHandBefore: number[];
}): Promise<TurnResult> {
  const { session, gameId, turnNumber, playerId, opponent, handBefore, oppHandBefore } = args;
  const { contract, walletProvider, read } = session;

  console.log(`  → P${playerId} hand is empty (deck has cards) → requestToDrawCard`);

  await callDelegated(
    walletProvider,
    `requestToDrawCard:t${turnNumber}`,
    () => contract.callTx.requestToDrawCard(gameId, BigInt(playerId), nowSeconds()),
    { playerId },
  );
  await waitFor(
    "phase == WaitForDraw",
    MIDNIGHT_WAIT_MS,
    () => read<number | bigint>("getGamePhase", gameId),
    v => !isMissing(v) && Number(v) === PHASE.WaitForDraw,
  );

  console.log(`  → P${opponent} calls drawCard (strips mask, inserts into P${playerId}'s hand)`);
  await callDelegated(
    walletProvider,
    `drawCard:t${turnNumber}`,
    // opponentPlayerId per game.compact is the CALLER's own id (the non-asker).
    () => contract.callTx.drawCard(gameId, BigInt(opponent), nowSeconds()),
    { playerId: opponent },
  );
  // drawCard internally switches turn and returns to TurnStart.
  await waitFor(
    "phase back to TurnStart after drawCard",
    MIDNIGHT_WAIT_MS,
    () => read<number | bigint>("getGamePhase", gameId),
    v => !isMissing(v) && Number(v) === PHASE.TurnStart,
  );

  const handAfter = await readHand(session, gameId, playerId);
  const oppHandAfter = await readHand(session, gameId, opponent);

  return {
    turn: turnNumber,
    action: "drawFromDeck",
    playerId,
    opponent,
    askRank: null,
    handBefore,
    oppHandBefore,
    handAfter,
    oppHandAfter,
    gotCards: handAfter.length > handBefore.length,
    wentFishing: false,
    bookScored: false,
    ended: false,
  };
}

/**
 * V3.3 empty-hand / empty-deck flow — just switch the turn.
 * `checkAndEndGame` is NOT called inside skipTurn; the outer runFullGame
 * loop invokes it separately when appropriate to detect draw / end.
 */
async function runSkipTurn(args: {
  session: SmokeSession;
  gameId: Uint8Array;
  turnNumber: number;
  playerId: 1 | 2;
  opponent: 1 | 2;
  handBefore: number[];
  oppHandBefore: number[];
}): Promise<TurnResult> {
  const { session, gameId, turnNumber, playerId, opponent, handBefore, oppHandBefore } = args;
  const { contract, walletProvider, read } = session;

  console.log(`  → P${playerId} hand empty + deck empty → skipTurn`);

  await callDelegated(
    walletProvider,
    `skipTurn:t${turnNumber}`,
    () => contract.callTx.skipTurn(gameId, BigInt(playerId), nowSeconds()),
    { playerId },
  );
  // Caller's turn just flipped to the opponent; phase stays at TurnStart.
  await waitFor(
    `currentTurn flipped to P${opponent}`,
    MIDNIGHT_WAIT_MS,
    () => read<number | bigint>("getCurrentTurn", gameId),
    v => !isMissing(v) && Number(v) === opponent,
  );

  const handAfter = await readHand(session, gameId, playerId);
  const oppHandAfter = await readHand(session, gameId, opponent);

  return {
    turn: turnNumber,
    action: "skipTurn",
    playerId,
    opponent,
    askRank: null,
    handBefore,
    oppHandBefore,
    handAfter,
    oppHandAfter,
    gotCards: false,
    wentFishing: false,
    bookScored: false,
    ended: false,
  };
}

export interface GameResult {
  turnsPlayed: number;
  finalPhase: number;
  finalScores: [number, number];
  finalHandSizes: [number, number];
  /** Sum of booked ranks across both players (= sum of scores). */
  totalBooksScored: number;
  /** Per-player booked-ranks bitmask (7-wide) at end of game. */
  finalBookedRanks: [boolean[], boolean[]];
  /**
   * Retained on the result shape for log-line stability. In V3 the client
   * no longer drives per-rank book txs — `respondToAsk` and `afterGoFish`
   * handle scoring internally — so there's nothing left to diverge.
   */
  divergenceCount: number;
  exitReason: string;
  winner: number | null;
}

/**
 * Run the full game loop until the game ends or we hit MAX_TURNS.
 *
 * V4.2: The client is responsible for calling `checkAndEndGame` after
 * each turn — the contract's inline scoring paths (respondToAsk,
 * afterGoFish, checkAndScoreBook) no longer guarantee phase=GameOver
 * even when the 7th book lands. This loop handles that in two places:
 *
 *   1. Per-turn: after a `skipTurn` (V3.3 empty-hand / empty-deck branch),
 *      call checkAndEndGame to detect stalemate. We don't call it after
 *      normal ask-flow turns to avoid ~2-min no-op txs; instead the loop
 *      exits early on `sum >= 7` and the final reconcile (below) flips
 *      phase.
 *   2. End-of-loop reconcile: after the loop exits for any reason except
 *      GameOver, submit one more checkAndEndGame to ensure the final
 *      snapshot has the correct phase. Essential because a natural
 *      7-book finish leaves phase=TurnStart until explicitly checked.
 *
 * Exit reasons:
 *   - phase == GameOver (auto on a skipTurn-then-stalemate, or via final
 *     reconcile when scores sum 7)
 *   - sum of scores == 7 (internal break; final reconcile flips phase)
 *   - playOneTurn returned `ended: true`
 *   - turn >= maxTurns (safety cap)
 */
export async function runFullGame(
  session: SmokeSession,
  gameId: Uint8Array,
  maxTurns: number = 20,
): Promise<GameResult> {
  const { contract, walletProvider, read } = session;
  let turn = 0;
  let exitReason = `MAX_TURNS (${maxTurns}) reached`;

  while (turn < maxTurns) {
    turn++;
    const result = await playOneTurn(session, gameId, turn);

    if (result.ended) {
      exitReason = result.endReason ?? "playOneTurn ended";
      break;
    }

    // End-of-turn telemetry: scores + booked-rank vectors per player.
    const [s1, s2] = (await read<[any, any]>("getScores", gameId)) as [any, any];
    const sum = Number(s1) + Number(s2);
    const books1 = await readBookedRanks(session, gameId, 1);
    const books2 = await readBookedRanks(session, gameId, 2);
    console.log(
      `  scores=${Number(s1)}-${Number(s2)} (total ${sum}/7) booksP1=${formatBookedRanks(books1)} booksP2=${formatBookedRanks(books2)}`,
    );

    if (sum >= 7) {
      exitReason = `all 7 books scored (final ${Number(s1)}-${Number(s2)})`;
      break;
    }

    const phaseRaw = await read<number | bigint>("getGamePhase", gameId);
    if (!isMissing(phaseRaw) && Number(phaseRaw) === PHASE.GameOver) {
      exitReason = "phase → GameOver";
      break;
    }

    // After a skipTurn (V3.3 empty-hand/empty-deck branch), the contract
    // doesn't auto-end — call checkAndEndGame to detect a stalemate and
    // flip phase to GameOver if the deck is exhausted and at least one
    // hand is empty. Skipping this after non-skipTurn actions avoids a
    // costly no-op tx per turn on the normal path.
    if (result.action === "skipTurn") {
      const [h1, h2] = (await read<[any, any]>("getHandSizes", gameId)) as [any, any];
      console.log(
        `  → skipTurn just ran, calling checkAndEndGame (hands=${Number(h1)}/${Number(h2)})`,
      );
      await callDelegated(
        walletProvider,
        `checkAndEndGame:t${turn}`,
        () => contract.callTx.checkAndEndGame(gameId),
      );
      const postPhase = await read<number | bigint>("getGamePhase", gameId);
      if (!isMissing(postPhase) && Number(postPhase) === PHASE.GameOver) {
        exitReason = "checkAndEndGame → GameOver (stalemate)";
        break;
      }
    }
  }

  // V4.2 caveat: "the frontend still has to call [checkAndEndGame] after
  // each turn." The contract's inline scoring paths do NOT reliably set
  // phase=GameOver when the 7th book is scored — the loop above breaks on
  // `sum >= 7`, but finalPhase could still be TurnStart at this point.
  // Submit one authoritative checkAndEndGame so the final phase snapshot
  // below is correct. Safe to call unconditionally: idempotent, no-op if
  // already GameOver, flips phase if conditions are met.
  const phaseBeforeFinalize = await read<number | bigint>("getGamePhase", gameId);
  if (!isMissing(phaseBeforeFinalize) && Number(phaseBeforeFinalize) !== PHASE.GameOver) {
    console.log(
      `\n── final checkAndEndGame (phase=${Number(phaseBeforeFinalize)}, reconciling to GameOver if applicable) ──`,
    );
    try {
      await callDelegated(
        walletProvider,
        "checkAndEndGame:final",
        () => contract.callTx.checkAndEndGame(gameId),
      );
      await waitFor(
        "phase → GameOver (final reconcile)",
        MIDNIGHT_WAIT_MS,
        () => read<number | bigint>("getGamePhase", gameId),
        v => !isMissing(v) && Number(v) === PHASE.GameOver,
        2000,
      ).catch(() => {
        // Didn't flip — game conditions weren't actually end-state (e.g.
        // MAX_TURNS exit with play still ongoing). That's fine; the final
        // snapshot below captures whatever phase is current.
        console.log("  (phase didn't flip — game wasn't actually in an end state)");
      });
    } catch (err) {
      console.log(`  [warn] final checkAndEndGame threw: ${(err as Error).message}`);
    }
  }

  // Final state snapshot
  const [fs1, fs2] = (await read<[any, any]>("getScores", gameId)) as [any, any];
  const [fh1, fh2] = (await read<[any, any]>("getHandSizes", gameId)) as [any, any];
  const finalPhase = Number(await read<number | bigint>("getGamePhase", gameId));
  const finalBooks1 = await readBookedRanks(session, gameId, 1);
  const finalBooks2 = await readBookedRanks(session, gameId, 2);

  // Winner is recorded on-chain when GameOver is reached. getWinner returns
  // 0 for tie/unset, 1 for P1, 2 for P2.
  let winner: number | null = null;
  try {
    const w = await read<number | bigint>("getWinner", gameId);
    if (!isMissing(w)) winner = Number(w);
  } catch {
    /* getWinner not available before GameOver — leave null */
  }

  return {
    turnsPlayed: turn,
    finalPhase,
    finalScores: [Number(fs1), Number(fs2)],
    finalHandSizes: [Number(fh1), Number(fh2)],
    totalBooksScored: Number(fs1) + Number(fs2),
    finalBookedRanks: [finalBooks1, finalBooks2],
    divergenceCount: 0,
    exitReason,
    winner,
  };
}

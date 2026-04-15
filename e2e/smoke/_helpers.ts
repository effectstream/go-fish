/**
 * Shared helpers for the Go Fish smoke tests.
 *
 * Factored out of the one-off smokes once we hit 3+ files with 90% overlap.
 * Existing smokes (midnight-imports, contract-config, ledger-subscription,
 * lobby-batcher, init-deck-circuit, apply-mask, setup-sequence) predate
 * this and duplicate most of the content — they're left alone to not
 * risk breaking green tests. Future smokes import from here.
 */

import { resolve } from "jsr:@std/path";
import { ethers } from "ethers";
import { generateStmInput } from "@paimaexample/concise";
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
  Deno.env.get("GO_FISH_REPO_ROOT") ?? Deno.cwd().replace(/\/e2e\/?$/, "");
export const BATCHER_URL = Deno.env.get("BATCHER_URL") ?? "http://localhost:3336";
export const PROOF_URL = Deno.env.get("PROOF_URL") ?? "http://127.0.0.1:6300";
export const INDEXER_HTTP_URL =
  Deno.env.get("INDEXER_HTTP_URL") ?? "http://127.0.0.1:8088/api/v3/graphql";
export const INDEXER_WS_URL =
  Deno.env.get("INDEXER_WS_URL") ?? "ws://127.0.0.1:8088/api/v3/graphql/ws";
export const PAIMA_API_URL = Deno.env.get("API_URL") ?? "http://localhost:9996";
export const EVM_RPC_URL = Deno.env.get("EVM_RPC_URL") ?? "http://localhost:8545";

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
 * `WaitForDraw` is deprecated (index 4 reserved for enum stability).
 */
export const PHASE = {
  Setup: 0,
  TurnStart: 1,
  WaitForResponse: 2,
  WaitForTransfer: 3,
  WaitForDraw: 4, // deprecated, merged into respondToAsk
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
  return JSON.parse(Deno.readTextFileSync(CONTRACT_ADDRESS_FILE))
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

/**
 * Port of paima-engine's `createMessageForBatcher` (jsr:@paimaexample/concise
 * — `batcher.ts`). The batcher and the Paima node both rebuild this exact
 * string and verify the signature against it.
 *
 * IMPORTANT — both `namespace` and `target` must be omitted (treated as "")
 * for the message to match what the Paima node reconstructs:
 *   - The batcher config sets `namespace: ""` (config.ts:13)
 *   - The Paima node calls `createMessageForBatcher(null, ...)` (null → "")
 *   - `extractBatches` does NOT persist the `target` field into the on-chain
 *     subunit, so the Paima node reconstructs with `target=undefined → ""`
 * Routing still works because the batcher uses `defaultTarget` (effectstreaml2).
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
    "", // namespace empty (matches batcher + Paima)
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
 * Path [1n, 0n] is the compiled accessor path for
 * `Deck::staticDeckInitialized` in the current contract build.
 */
async function queryStaticDeckInitialized(
  publicDataProvider: any,
  contractAddress: string,
): Promise<boolean> {
  const contractState = await publicDataProvider.queryContractState(contractAddress);
  if (!contractState) return false;

  const keyType = new CompactTypeUnsignedInteger(255n, 1);
  const key1 = { value: keyType.toValue(1n), alignment: keyType.alignment() };
  const key0 = { value: keyType.toValue(0n), alignment: keyType.alignment() };

  try {
    const results = contractState.query(
      [
        { dup: { n: 0 } },
        {
          idx: {
            cached: false,
            pushPath: false,
            path: [
              { tag: "value" as const, value: key1 },
              { tag: "value" as const, value: key0 },
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
    "phase == TurnStart",
    MIDNIGHT_WAIT_MS,
    () => read<number | bigint>("getGamePhase", gameId),
    v => !isMissing(v) && Number(v) === PHASE.TurnStart,
  );

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
// Turn loop primitives — playOneTurn, autoScoreBooks, runFullGame
// ---------------------------------------------------------------------------

export interface TurnResult {
  turn: number;
  playerId: 1 | 2;
  opponent: 1 | 2;
  askRank: number | null;
  handBefore: number[];
  oppHandBefore: number[];
  handAfter: number[];
  oppHandAfter: number[];
  gotCards: boolean;
  wentFishing: boolean;
  ended: boolean;
  endReason?: string;
}

/**
 * Drive one full turn: read state → ask → respond → (afterGoFish if Go Fish).
 *
 * Returns a TurnResult describing what happened. When `ended === true`, the
 * caller should stop the loop. Reasons include: phase already GameOver,
 * empty hand, unexpected phase transition, or askForCard rejected by the
 * contract (BACKEND_ISSUES #1: divergence between local hand read and the
 * contract's internal rank check).
 *
 * The function does NOT score books — that's `autoScoreBooks`'s job.
 */
export async function playOneTurn(
  session: SmokeSession,
  gameId: Uint8Array,
  turnNumber: number,
): Promise<TurnResult> {
  const { contract, walletProvider, read } = session;

  const empty: TurnResult = {
    turn: turnNumber,
    playerId: 1,
    opponent: 2,
    askRank: null,
    handBefore: [],
    oppHandBefore: [],
    handAfter: [],
    oppHandAfter: [],
    gotCards: false,
    wentFishing: false,
    ended: true,
  };

  // Phase check
  const phaseRaw = await read<number | bigint>("getGamePhase", gameId);
  if (isMissing(phaseRaw)) {
    return { ...empty, endReason: "getGamePhase missing" };
  }
  const phase = Number(phaseRaw);
  if (phase === PHASE.GameOver) {
    return { ...empty, endReason: "phase == GameOver" };
  }
  if (phase !== PHASE.TurnStart) {
    return { ...empty, endReason: `unexpected phase ${phase} at turn start` };
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

  if (handBefore.length === 0) {
    return {
      ...empty,
      playerId,
      opponent,
      handBefore,
      oppHandBefore,
      handAfter: handBefore,
      oppHandAfter: oppHandBefore,
      endReason: `P${playerId} has empty hand`,
    };
  }

  // Pick the first rank in our hand (simple heuristic; fine for testing)
  const askRank = handRanks(handBefore)[0]!;
  console.log(`  → P${playerId} asks P${opponent} for ${RANKS[askRank]}`);

  // Ask
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

  if (postRespond === PHASE.WaitForDrawCheck) {
    // Go Fish: respondToAsk auto-drew a card from the deck for the asker.
    // afterGoFish decrypts it and decides whether to switchTurn.
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
  } else if (postRespond === PHASE.GameOver) {
    return {
      ...empty,
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
    playerId,
    opponent,
    askRank,
    handBefore,
    oppHandBefore,
    handAfter,
    oppHandAfter,
    gotCards,
    wentFishing,
    ended: false,
  };
}

/**
 * After a hand-mutating action, look for any rank with ≥3 cards in the
 * given player's hand and submit `checkAndScoreBook` for it. Each attempt
 * is wrapped in try/catch so divergence (BACKEND_ISSUES #1) doesn't halt
 * the loop — failures are logged and recorded.
 *
 * Waits for the player's hand size to shrink by 3 after each successful
 * book scoring (book consumes exactly 3 cards from the hand).
 */
export async function autoScoreBooks(
  session: SmokeSession,
  gameId: Uint8Array,
  playerId: 1 | 2,
  turnNumber: number,
): Promise<{ scored: number[]; failed: number[] }> {
  const { contract, walletProvider, read } = session;

  const hand = await readHand(session, gameId, playerId);
  const counts = new Map<number, number>();
  for (const c of hand) counts.set(c % 7, (counts.get(c % 7) ?? 0) + 1);

  const scored: number[] = [];
  const failed: number[] = [];

  for (const [rank, count] of counts) {
    if (count < 3) continue;
    console.log(`  ★ P${playerId} has ${count} of ${RANKS[rank]} — attempting book scoring`);

    // Read pre-call hand size so we can wait for the −3 shrink
    const [h1Pre, h2Pre] = (await read<[any, any]>("getHandSizes", gameId)) as [any, any];
    const sizePre = playerId === 1 ? Number(h1Pre) : Number(h2Pre);

    try {
      await callDelegated(
        walletProvider,
        `checkAndScoreBook:t${turnNumber}:r${rank}`,
        () => contract.callTx.checkAndScoreBook(gameId, BigInt(playerId), BigInt(rank)),
        { playerId },
      );
      await waitFor(
        `P${playerId} hand shrinks after book of ${RANKS[rank]}`,
        MIDNIGHT_WAIT_MS,
        async () => {
          const [h1, h2] = (await read<[any, any]>("getHandSizes", gameId)) as [any, any];
          return playerId === 1 ? Number(h1) : Number(h2);
        },
        size => size <= sizePre - 3,
        2000,
      );
      scored.push(rank);
      console.log(`  ✓ book of ${RANKS[rank]} scored`);
    } catch (err) {
      // BACKEND_ISSUES #1: doesPlayerHaveSpecificCard local read may give
      // false positives that disagree with the contract's internal counting.
      // Log and continue so the game still completes.
      console.log(`  [divergence] checkAndScoreBook(P${playerId}, ${RANKS[rank]}) failed: ${(err as Error).message}`);
      failed.push(rank);
    }
  }

  return { scored, failed };
}

export interface GameResult {
  turnsPlayed: number;
  finalPhase: number;
  finalScores: [number, number];
  finalHandSizes: [number, number];
  totalBooksScored: number;
  divergenceCount: number;
  exitReason: string;
  winner: number | null;
}

/**
 * Run the full game loop: playOneTurn + autoScoreBooks until the game
 * ends or we hit MAX_TURNS. Exit reasons:
 *   - phase == GameOver (the contract auto-ends at 7 books)
 *   - sum of scores == 7 (same condition, defensive)
 *   - playOneTurn returned `ended: true` (empty hand, etc.)
 *   - turn >= maxTurns (safety cap; the user's design says 20 is enough
 *     for a natural game)
 */
export async function runFullGame(
  session: SmokeSession,
  gameId: Uint8Array,
  maxTurns: number = 20,
): Promise<GameResult> {
  const { read } = session;
  let turn = 0;
  let exitReason = `MAX_TURNS (${maxTurns}) reached`;
  let divergenceCount = 0;

  while (turn < maxTurns) {
    turn++;
    const result = await playOneTurn(session, gameId, turn);

    if (result.ended) {
      exitReason = result.endReason ?? "playOneTurn ended";
      break;
    }

    // Score any books now in the current player's hand
    const books = await autoScoreBooks(session, gameId, result.playerId, turn);
    divergenceCount += books.failed.length;

    // Check end-of-game conditions
    const [s1, s2] = (await read<[any, any]>("getScores", gameId)) as [any, any];
    const sum = Number(s1) + Number(s2);
    console.log(`  scores=${Number(s1)}-${Number(s2)} (total ${sum}/7)`);

    if (sum >= 7) {
      exitReason = `all 7 books scored (final ${Number(s1)}-${Number(s2)})`;
      break;
    }

    const phaseRaw = await read<number | bigint>("getGamePhase", gameId);
    if (!isMissing(phaseRaw) && Number(phaseRaw) === PHASE.GameOver) {
      exitReason = "phase → GameOver";
      break;
    }
  }

  // Final state snapshot
  const [fs1, fs2] = (await read<[any, any]>("getScores", gameId)) as [any, any];
  const [fh1, fh2] = (await read<[any, any]>("getHandSizes", gameId)) as [any, any];
  const finalPhase = Number(await read<number | bigint>("getGamePhase", gameId));

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
    divergenceCount,
    exitReason,
    winner,
  };
}

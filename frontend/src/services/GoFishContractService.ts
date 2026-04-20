/**
 * Go Fish Contract Service — Browser-side WASM proving with batcher delegation
 *
 * Flow:
 *   1. findDeployedContract joins the deployed Go Fish contract (cached per lobby)
 *   2. callTx evaluates the circuit locally in WASM (witnesses run in-browser)
 *   3. getBrowserProofProvider() generates the ZK proof in a Web Worker
 *   4. balanceTx is intercepted: the proven UnboundTransaction is serialised and
 *      POSTed to the batcher as target="midnight_balancing" / txStage="unbound"
 *   5. The batcher calls balanceUnboundTransaction() to add dust fees, then submits
 *
 * Player secrets (from PlayerKeyManager) are set on the shared witnesses module
 * immediately before each circuit call, then cleared in the finally block.
 * This matches how the server-side batcher adapter handles secrets.
 */

import { findDeployedContract } from "@midnight-ntwrk/midnight-js-contracts";
import { FetchZkConfigProvider } from "@midnight-ntwrk/midnight-js-fetch-zk-config-provider";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { toHex, CompactTypeBoolean, CompactTypeBytes, CompactTypeUnsignedInteger, CostModel, QueryContext, sampleContractAddress, createConstructorContext } from "@midnight-ntwrk/compact-runtime";
import { CompiledContract } from "@midnight-ntwrk/compact-js";
import { getBrowserProofProvider } from "./midnightBrowserProofProvider";
import { createInMemoryPrivateStateProvider } from "./midnightInMemoryPrivateStateProvider";
import {
  witnesses,
  setPlayerSecrets,
  clearPlayerSecrets,
} from "../../../packages/shared/contracts/midnight/go-fish-contract/src/_index";
import {
  Contract as GoFishContractClass,
} from "../../../packages/shared/contracts/midnight/go-fish-contract/src/managed/contract/index.js";
import { PlayerKeyManager } from "./PlayerKeyManager";
import { getLocalCoinPublicKey, getLocalEncryptionPublicKey } from "./inBrowserWallet";
import { API_BASE_URL } from "../apiConfig";
import { globalLoader } from "../three/ui/GlobalLoader";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Direct indexer connection — /api/v3/graphql on port 8088.
// The old default (8089/api/v1) went through a GraphQL proxy that cached
// responses, causing P1 to see stale state for P2's mask/deal.
// Matches the e2e reference at e2e/smoke/_helpers.ts.
const BASE_URL_MIDNIGHT_INDEXER_API =
  import.meta.env.VITE_INDEXER_HTTP_URL || "http://127.0.0.1:8088/api/v3/graphql";
const BASE_URL_MIDNIGHT_INDEXER_WS =
  import.meta.env.VITE_INDEXER_WS_URL || "ws://127.0.0.1:8088/api/v3/graphql/ws";
const BATCHER_URL = import.meta.env.VITE_BATCHER_URL || "http://localhost:3334";

/** Sentinel thrown by the balanceTx hook to abort the SDK pipeline after delegation. */
const DELEGATED_SENTINEL = "GoFish: delegated to midnight_balancing batcher";

// ---------------------------------------------------------------------------
// Module-level singletons
// ---------------------------------------------------------------------------

let _zkConfigProvider: FetchZkConfigProvider<string> | null = null;
let _compiledContract: any = null;
/** Cached joined contracts keyed by contractAddress+privateStateId */
const _contractCache = new Map<string, any>();

/**
 * Evict a contract instance from the cache so the next call re-runs
 * findDeployedContract and fetches fresh indexer state.
 * Used before dealCards retries to ensure the circuit simulation sees
 * the latest on-chain state (e.g. after opponent's applyMask lands).
 */
export function evictContractCache(lobbyId: string, playerId: 1 | 2): void {
  const addr = _contractAddress;
  if (!addr) return;
  const key = `${addr}::privateState-${lobbyId}-${playerId}`;
  _contractCache.delete(key);
}

function getZkConfigProvider(): FetchZkConfigProvider<string> {
  if (!_zkConfigProvider) {
    _zkConfigProvider = new FetchZkConfigProvider(
      window.location.origin,
      fetch.bind(globalThis),
    );
  }
  return _zkConfigProvider;
}

function getCompiledContract(): any {
  if (!_compiledContract) {
    _compiledContract = CompiledContract.withCompiledFileAssets(
      CompiledContract.withWitnesses(
        CompiledContract.make("go-fish", GoFishContractClass),
        witnesses,
      ),
      window.location.origin,
    );
  }
  return _compiledContract;
}

function getPublicDataProvider() {
  return indexerPublicDataProvider(
    BASE_URL_MIDNIGHT_INDEXER_API,
    BASE_URL_MIDNIGHT_INDEXER_WS,
  );
}

// ---------------------------------------------------------------------------
// Contract address loading
// ---------------------------------------------------------------------------

let _contractAddress: string | null = null;

async function getContractAddress(): Promise<string> {
  if (_contractAddress) return _contractAddress;

  // Read from the static deployment file served by vite-plugin-static-copy.
  // No backend API call — the /api/midnight/contract_address endpoint doesn't
  // exist and the 404 fallback chain was adding ~2s latency per query.
  // Matches the e2e reference which reads from the filesystem directly.
  const res = await fetch("/contract_address/go-fish-contract.undeployed.json");
  if (!res.ok) throw new Error("[GoFishContractService] Contract address not found at /contract_address/go-fish-contract.undeployed.json");
  const data = await res.json();
  _contractAddress = normalizeAddress(data.contractAddress);
  return _contractAddress;
}

function normalizeAddress(addr: string): string {
  // Strip 0x prefix; compact-runtime 0.14+ expects raw 32-byte (64 hex char) addresses.
  return addr.startsWith("0x") ? addr.slice(2) : addr;
}

// ---------------------------------------------------------------------------
// Provider + join helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal wallet/midnight provider whose balanceTx delegates to the
 * midnight_balancing batcher when __delegatedBalanceHook is set.
 */
function makeProvider(): any {
  const provider: any = {
    // Use in-browser wallet keys so each user has their own identity
    getCoinPublicKey() { return getLocalCoinPublicKey(); },
    getEncryptionPublicKey() { return getLocalEncryptionPublicKey(); },

    async balanceTx(tx: any) {
      if (typeof provider.__delegatedBalanceHook === "function") {
        await provider.__delegatedBalanceHook(tx);
        throw new Error(DELEGATED_SENTINEL);
      }
      // Should never reach here in batcher mode
      throw new Error("[GoFishContractService] balanceTx called without a hook");
    },

    submitTx(_tx: any) {
      throw new Error("[GoFishContractService] submitTx should never be called directly");
    },

    __delegatedBalanceHook: undefined as any,
  };
  return provider;
}

async function getJoinedContract(contractAddress: string, privateStateId: string): Promise<any> {
  const key = `${contractAddress}::${privateStateId}`;
  if (_contractCache.has(key)) return _contractCache.get(key);

  const provider = makeProvider();
  const privateStateProvider = createInMemoryPrivateStateProvider(privateStateId);

  const providers = {
    privateStateProvider,
    zkConfigProvider: getZkConfigProvider(),
    proofProvider: getBrowserProofProvider(),
    publicDataProvider: getPublicDataProvider(),
    walletProvider: provider,
    midnightProvider: provider,
  };

  const contract = await findDeployedContract(providers, {
    contractAddress,
    compiledContract: getCompiledContract(),
    privateStateId,
    initialPrivateState: {},
  });

  // Store both the contract and its provider so callDelegated can set the hook
  _contractCache.set(key, { contract, provider });
  return { contract, provider };
}

// ---------------------------------------------------------------------------
// Batcher delegation
// ---------------------------------------------------------------------------

function isDelegationError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  let e: Error | undefined = error;
  while (e) {
    if (e.message.includes(DELEGATED_SENTINEL)) return true;
    e = e.cause instanceof Error ? e.cause : undefined;
  }
  return false;
}

function detectTxStage(serializedTx: string): "unproven" | "unbound" | "finalized" {
  const prefixBytes = new Uint8Array(
    serializedTx.slice(0, 600).padEnd(600, "0").match(/.{2}/g)!.map(b => parseInt(b, 16))
  );
  const header = new TextDecoder().decode(prefixBytes);
  const m = header.match(/midnight:(?:transaction|intent)\[v\d+\]\(signature\[v\d+\],([^,]+),([^)]+)\):/);
  if (!m) throw new Error(`[GoFishContractService] Cannot parse tx header: ${header.slice(0, 80)}`);
  if (m[1].includes("proof-preimage")) return "unproven";
  if (m[2].includes("embedded-fr")) return "unbound";
  if (m[2].includes("pedersen-schnorr")) return "finalized";
  throw new Error(`[GoFishContractService] Unknown tx stage markers: proof=${m[1]} binding=${m[2]}`);
}

async function postToBatcher(serializedTx: string, circuitId: string, meta?: { lobbyId?: string; playerId?: number }): Promise<void> {
  const txStage = detectTxStage(serializedTx);
  const txHash = serializedTx.slice(0, 32); // first 16 bytes as fingerprint
  console.log(`[GoFishContractService] ${circuitId}: detected txStage=${txStage}, txLen=${serializedTx.length / 2} bytes, txStart=${txHash}`);
  const body = {
    data: {
      target: "midnight_balancing",
      address: "go_fish_player",
      addressType: 0,
      input: JSON.stringify({ tx: serializedTx, txStage, circuitId, ...(meta ?? {}) }),
      timestamp: Date.now(),
    },
    confirmationLevel: "no-wait",
  };

  const res = await fetch(`${BATCHER_URL}/send-input`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`[GoFishContractService] Batcher rejected ${circuitId}: ${text}`);
  }
  console.log(`[GoFishContractService] ${circuitId} (${txStage}) submitted to batcher`);
}

/** Human-friendly label for each circuit, used in the GlobalLoader status. */
const CIRCUIT_LABELS: Record<string, string> = {
  applyMask: 'applying mask',
  dealCards: 'dealing cards',
  scoreInitialBooks: 'scoring initial book',
  askForCard: 'asking for card',
  respondToAsk: 'checking hand',
  afterGoFish: 'resolving draw',
  checkAndScoreBook: 'scoring book',
  requestToDrawCard: 'requesting draw',
  drawCard: 'drawing for opponent',
  skipTurn: 'skipping turn',
  checkAndEndGame: 'checking end game',
  switchTurn: 'switching turn',
  claimTimeoutWin: 'claiming timeout win',
  init_deck: 'initializing deck',
};

async function callDelegated(
  provider: any,
  circuitId: string,
  callFn: () => Promise<any>,
  meta?: { lobbyId?: string; playerId?: number },
): Promise<void> {
  let delegated = false;
  const label = CIRCUIT_LABELS[circuitId] ?? circuitId;

  provider.__delegatedBalanceHook = async (tx: any) => {
    // Proof is already generated at this point (balanceTx fires after
    // proveTx). Switch the loader to "sending" before the batcher POST.
    globalLoader.show('sending', `Submitting ${label}…`);
    const serializedTx = toHex((tx as any).serialize());
    await postToBatcher(serializedTx, circuitId, meta);
    delegated = true;  // posted successfully — any subsequent SDK throw is safe to suppress
  };

  globalLoader.show('proving', `Proving ${label}…`);
  try {
    await callFn();
    // Delegated flow: on success we've already shown "sending". Leave the
    // loader in that state — the caller is responsible for hiding it once
    // the tx confirms on-chain (via pollUntilPhase / pollForSetupStatus).
    // If we get here and delegation never fired, we need to clean up.
    if (!delegated) {
      globalLoader.hide();
    } else {
      globalLoader.show('sending', `Awaiting confirmation: ${label}…`);
    }
  } catch (error) {
    // Suppress if: (a) the sentinel propagated through the SDK, or (b) we already
    // posted to the batcher and the SDK threw after balanceTx returned (e.g.,
    // EffectStream validation error, submitTx unreachable, etc.)
    if (isDelegationError(error) || delegated) {
      globalLoader.show('sending', `Awaiting confirmation: ${label}…`);
      return;
    }
    globalLoader.hide();
    throw error;
  } finally {
    delete provider.__delegatedBalanceHook;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function lobbyIdToGameId(lobbyId: string): Uint8Array {
  const enc = new TextEncoder().encode(lobbyId);
  const b = new Uint8Array(32);
  b.set(enc.slice(0, 32));
  return b;
}

function gameIdToHex(gameId: Uint8Array): string {
  return "0x" + Array.from(gameId).map(x => x.toString(16).padStart(2, "0")).join("");
}

/** Set secrets for both players before a circuit call. Clears in finally.
 *
 *  Every circuit in this contract fetches BOTH players' secrets up-front
 *  (ZKIR ec_mul guard requirement), even when only one is used in the
 *  actual computation (cond_select picks the active one). So we must
 *  always provide both secrets in the witness module.
 *
 *  When the opponent's real secret isn't available locally (the normal
 *  case — only the local player's secret is in PlayerKeyManager), we
 *  register a dummy value. The contract explicitly supports this:
 *  see Deck.compact:95-101. The ec_mul round-trip verification works
 *  for any valid secret+inverse pair, dummy or real.
 */
function withSecrets<T>(
  lobbyId: string,
  primaryId: 1 | 2,
  fn: (gameId: Uint8Array) => Promise<T>,
): Promise<T> {
  const gameId = lobbyIdToGameId(lobbyId);
  const gameIdHex = gameIdToHex(gameId);
  const oppId = primaryId === 1 ? 2 : 1;

  // Set primary player secrets (uses hex key to match witness lookup)
  const secret = PlayerKeyManager.getPlayerSecret(lobbyId, primaryId);
  const seed = PlayerKeyManager.getShuffleSeed(lobbyId, primaryId);
  console.log(`[GoFishContractService] withSecrets: setting player=${primaryId} secret=${secret.toString(16).slice(0, 16)}… gameIdHex=${gameIdHex.slice(0, 16)}…`);
  setPlayerSecrets(gameIdHex, primaryId, secret, seed);

  // Set opponent secrets — real if we have them locally (e.g., both players
  // in the same browser for testing), dummy otherwise. Either satisfies
  // the ec_mul guard pattern.
  if (PlayerKeyManager.hasExistingKeys(lobbyId, oppId)) {
    const oppSecret = PlayerKeyManager.getPlayerSecret(lobbyId, oppId);
    const oppSeed = PlayerKeyManager.getShuffleSeed(lobbyId, oppId);
    setPlayerSecrets(gameIdHex, oppId, oppSecret, oppSeed);
  } else {
    setPlayerSecrets(gameIdHex, oppId, 1n, new Uint8Array(32));
  }

  return fn(gameId).finally(() => {
    clearPlayerSecrets(gameIdHex, primaryId);
    clearPlayerSecrets(gameIdHex, oppId);
  });
}

// ---------------------------------------------------------------------------
// Public circuit API
// ---------------------------------------------------------------------------

export async function initializeMidnight(): Promise<void> {
  setNetworkId("undeployed");
}

export async function callInitDeck(): Promise<void> {
  const addr = await getContractAddress();
  const { contract, provider } = await getJoinedContract(addr, "privateState-init-deck");
  await callDelegated(provider, "init_deck", () =>
    contract.callTx.init_deck()
  );
}

/**
 * Poll the indexer until the contract's on-chain state changes from `stateBeforeHex`,
 * indicating that the init_deck transaction has been applied.
 * Times out after `timeoutMs` (default 120s), returns true on change, false on timeout.
 */
export async function waitForStateDeckInitialized(
  stateBeforeHex: string,
  timeoutMs = 120_000,
): Promise<boolean> {
  const addr = await getContractAddress();
  const provider = getPublicDataProvider();
  const deadline = Date.now() + timeoutMs;
  let pollCount = 0;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000));
    pollCount++;
    try {
      const state = await provider.queryContractState(addr as any);
      if (!state) {
        if (pollCount % 5 === 0) console.warn(`[GoFishContractService] queryContractState returned null (poll #${pollCount}, addr=${addr.slice(0,16)}...)`);
        continue;
      }
      const currentHex = toHex(state.serialize());
      if (currentHex !== stateBeforeHex) {
        console.log("[GoFishContractService] on-chain state changed — init_deck applied");
        return true;
      }
      // Every 10 polls, log a direct staticDeckInitialized query for extra confirmation
      if (pollCount % 10 === 0) {
        const isDeckInit = await queryIsStaticDeckInitialized().catch(() => null);
        console.log(`[GoFishContractService] poll #${pollCount}: state unchanged, staticDeckInitialized=${isDeckInit}`);
      }
    } catch (err) {
      if (pollCount % 5 === 0) console.warn(`[GoFishContractService] queryContractState error (poll #${pollCount}):`, err);
    }
  }
  console.warn("[GoFishContractService] waitForStateDeckInitialized timed out");
  return false;
}

/**
 * Query the current raw contract state hex (for use before submitting init_deck).
 * Returns null if state cannot be fetched.
 */
export async function queryCurrentStateHex(): Promise<string | null> {
  try {
    const addr = await getContractAddress();
    const provider = getPublicDataProvider();
    const state = await provider.queryContractState(addr as any);
    if (!state) return null;
    return toHex(state.serialize());
  } catch {
    return null;
  }
}

/**
 * Query the on-chain `staticDeckInitialized` ledger field.
 * Uses ContractState.query() with the same VM ops as the compiled _init_static_deck circuit
 * to read the boolean at state path [outer-index-0][inner-index-2].
 * Returns true if the deck is already initialized, false otherwise, null on error.
 */
export async function queryIsStaticDeckInitialized(): Promise<boolean | null> {
  try {
    const addr = await getContractAddress();
    const provider = getPublicDataProvider();
    const contractState = await provider.queryContractState(addr as any);
    if (!contractState) return null;

    // _descriptor_7 = CompactTypeUnsignedInteger(255n, 1) — used for ledger array/map keys
    // V3 ledger layout (2026-04-17): path moved back to [0n, 2n]. The V3
    // contract added four new ledger fields (booksP1/P2,
    // initialBooksScoredP1/P2), which shifted compact-runtime slot indices.
    // The old [1n, 0n] path now lands on a Map and throws
    // "expected a cell, received map". Any further contract refactor that
    // touches ledger layout requires re-validating this against
    // managed/contract/index.js::_init_static_deck_0 queryLedgerState ops.
    const keyType = new CompactTypeUnsignedInteger(255n, 1);
    const key0 = { value: keyType.toValue(0n), alignment: keyType.alignment() };
    const key2 = { value: keyType.toValue(2n), alignment: keyType.alignment() };

    const results = contractState.query(
      [
        { dup: { n: 0 } },
        {
          idx: {
            cached: false,
            pushPath: false,
            path: [
              { tag: 'value' as const, value: key0 },
              { tag: 'value' as const, value: key2 },
            ],
          },
        },
        { popeq: { cached: false, result: null } },
      ],
      CostModel.initialCostModel(),
    );

    const gatherResults = (results as any)[1];
    const first = Array.isArray(gatherResults) ? gatherResults[0] : null;
    if (!first || first.tag !== 'read') return null;
    return CompactTypeBoolean.fromValue(first.content.value);
  } catch (err) {
    console.warn('[GoFishContractService] queryIsStaticDeckInitialized failed:', err);
    return null;
  }
}

/**
 * Query whether a player has applied their mask on-chain.
 * Reads maskAppliedP1 (path [2n,5n][gameId]) or maskAppliedP2 (path [2n,6n][gameId])
 * directly from the indexer's contract state — no circuit simulation involved.
 *
 * Polls the indexer with retries because the Midnight indexer processes blocks
 * asynchronously and may lag behind the node (batcher uses no-wait receipt).
 * Returns true once confirmed, false if timed out, or null on persistent error.
 */
export async function queryHasMaskApplied(
  lobbyId: string,
  playerId: 1 | 2,
  options: { pollIntervalMs?: number; timeoutMs?: number } = {},
): Promise<boolean | null> {
  const pollIntervalMs = options.pollIntervalMs ?? 2000;
  const timeoutMs = options.timeoutMs ?? 90_000;
  const deadline = Date.now() + timeoutMs;

  const addr = await getContractAddress();
  const keyType = new CompactTypeUnsignedInteger(255n, 1);
  const gameId = lobbyIdToGameId(lobbyId);
  // maskAppliedP1 = [2n,5n], maskAppliedP2 = [2n,6n]  (paths from compiled _hasMaskApplied_0)
  const outerKey = { value: keyType.toValue(2n), alignment: keyType.alignment() };
  const innerKey = { value: keyType.toValue(playerId === 1 ? 5n : 6n), alignment: keyType.alignment() };
  const gameIdKey = { value: new CompactTypeBytes(32).toValue(gameId), alignment: new CompactTypeBytes(32).alignment() };

  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    try {
      const provider = getPublicDataProvider();
      const contractState = await provider.queryContractState(addr as any);
      if (contractState) {
        const results = contractState.query(
          [
            { dup: { n: 0 } },
            { idx: { cached: false, pushPath: false, path: [
              { tag: 'value' as const, value: outerKey },
              { tag: 'value' as const, value: innerKey },
            ]}},
            { idx: { cached: false, pushPath: false, path: [
              { tag: 'value' as const, value: gameIdKey },
            ]}},
            { popeq: { cached: false, result: undefined } },
          ],
          CostModel.initialCostModel(),
        );

        const gatherResults = (results as any)[1];
        const first = Array.isArray(gatherResults) ? gatherResults[0] : null;
        if (first && first.tag === 'read') {
          const value = CompactTypeBoolean.fromValue(first.content.value);
          console.log(`[GoFishContractService] queryHasMaskApplied(player=${playerId}) attempt=${attempt} value=${value}`);
          if (value === true) return true;
        } else {
          console.log(`[GoFishContractService] queryHasMaskApplied(player=${playerId}) attempt=${attempt} no-read-result tag=${first?.tag}`);
        }
      } else {
        console.log(`[GoFishContractService] queryHasMaskApplied(player=${playerId}) attempt=${attempt} no contractState`);
      }
    } catch (err) {
      console.warn(`[GoFishContractService] queryHasMaskApplied(player=${playerId}) attempt=${attempt} error:`, err);
    }

    if (Date.now() + pollIntervalMs < deadline) {
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    } else {
      break;
    }
  }

  console.warn(`[GoFishContractService] queryHasMaskApplied(player=${playerId}) timed out after ${attempt} attempts`);
  return false;
}

// ---------------------------------------------------------------------------
// Contract state reads — local impureCircuit evaluation against indexer state
// ---------------------------------------------------------------------------
// Mirrors the e2e reference at e2e/smoke/_helpers.ts:readCircuit.
// Creates a local Contract instance (cached), hydrates a QueryContext from
// the indexer, and calls the named impure circuit. No tx submission, no
// proof generation — just a local read.

let _localContract: any = null;
let _localInitState: { privateState: any; zswap: any } | null = null;

function getLocalContract() {
  if (!_localContract) {
    _localContract = new GoFishContractClass(witnesses as any);
    const init = _localContract.initialState(createConstructorContext({}, "0".repeat(64)));
    _localInitState = {
      privateState: init.currentPrivateState,
      zswap: init.currentZswapLocalState,
    };
  }
  return { contract: _localContract, init: _localInitState! };
}

// ---------------------------------------------------------------------------
// WebSocket subscription — live contract state from the indexer
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// WebSocket subscription — notification-only (no cached state for reads)
// ---------------------------------------------------------------------------
// The WS tells us "something changed" so we can re-query via HTTP.
// All circuit reads go through fresh HTTP queryContractState calls.
// This eliminates the entire class of stale-cache bugs.

let _wsSubscription: { unsubscribe(): void } | null = null;
let _wsChangeListeners: Set<() => void> = new Set();

/**
 * Start the WebSocket subscription to the Midnight indexer.
 * Notification-only: fires registered listeners when the contract state
 * changes on-chain. Listeners should call queryCircuit / queryGameState
 * to read the fresh state via HTTP.
 *
 * Idempotent — calling twice is harmless.
 */
export async function startContractSubscription(): Promise<void> {
  if (_wsSubscription) return;

  const addr = await getContractAddress();
  const provider = getPublicDataProvider();
  const observable = provider.contractStateObservable(addr as any, { type: "latest" });

  _wsSubscription = observable.subscribe({
    next: () => {
      // Don't cache the state — just notify listeners to re-query via HTTP.
      for (const fn of _wsChangeListeners) {
        try { fn(); } catch { /* swallow listener errors */ }
      }
    },
    error: (err: any) => {
      console.error('[GoFishContractService] WS subscription error:', err);
    },
  });
  console.log('[GoFishContractService] WS subscription started');
}

/**
 * Register a callback that fires every time the contract state changes.
 * Returns an unsubscribe function.
 */
export function onContractStateChange(fn: () => void): () => void {
  _wsChangeListeners.add(fn);
  return () => { _wsChangeListeners.delete(fn); };
}

/** Stop the WS subscription. */
export function stopContractSubscription(): void {
  _wsSubscription?.unsubscribe();
  _wsSubscription = null;
  _wsChangeListeners.clear();
}

/**
 * Read a circuit result from the current on-chain contract state.
 * Uses the cached WS state if available (instant), otherwise falls back
 * to an HTTP query to the indexer. Matches the e2e readCircuit pattern.
 */
export async function queryCircuit<T = any>(
  circuitName: string,
  ...args: any[]
): Promise<T | null> {
  // Always fetch fresh state from the indexer via HTTP. The WS
  // subscription is notification-only (triggers re-queries), not a
  // cache — this eliminates stale-state bugs entirely.
  const addr = await getContractAddress();
  const provider = getPublicDataProvider();
  const cs = await provider.queryContractState(addr as any);
  if (!cs) return null;

  const { contract, init } = getLocalContract();

  try {
    const ctx = {
      currentPrivateState: init.privateState,
      currentZswapLocalState: init.zswap,
      currentQueryContext: new QueryContext(cs.data, sampleContractAddress()),
      costModel: CostModel.initialCostModel(),
    };
    const result = contract.impureCircuits[circuitName](ctx, ...args);
    return result.result as T;
  } catch (err) {
    console.warn(`[GoFishContractService] queryCircuit(${circuitName}) failed:`, (err as Error).message);
    return null;
  }
}

/** Convenience: query a boolean circuit with (gameId, playerId) args. */
export async function queryBoolCircuit(
  circuitName: string,
  lobbyId: string,
  playerId: 1 | 2,
): Promise<boolean> {
  const gameId = lobbyIdToGameId(lobbyId);
  const result = await queryCircuit<boolean>(circuitName, gameId, BigInt(playerId));
  return result === true;
}

/**
 * Read the full game state directly from the Midnight contract ledger.
 * Returns phase, scores, handSizes, currentTurn, isGameOver, deckCount.
 * No backend API — all reads via the indexer + local impureCircuit eval.
 */
export async function queryGameState(lobbyId: string): Promise<{
  phase: number;
  currentTurn: number;
  scores: [number, number];
  handSizes: [number, number];
  isGameOver: boolean;
  deckEmpty: boolean;
  deckCount: number;
  /** Booked ranks per player. Each is a 7-wide boolean vector where
   *  index r is true iff that player has booked rank r. */
  booksP1: boolean[];
  booksP2: boolean[];
} | null> {
  const gameId = lobbyIdToGameId(lobbyId);

  // Check if game exists on-chain (always fresh HTTP query)
  const exists = await queryCircuit<boolean>("doesGameExist", gameId);
  if (!exists) return null;

  // Read all fields in parallel. deckSize is the total deck array length
  // (21 for this game), topCardIndex is how many have been drawn. Remaining
  // deck count = deckSize - topCardIndex.
  const [phase, turn, scores, sizes, gameOver, deckEmpty, deckSize, topCardIndex, books1, books2] =
    await Promise.all([
      queryCircuit<number | bigint>("getGamePhase", gameId),
      queryCircuit<number | bigint>("getCurrentTurn", gameId),
      queryCircuit<[number | bigint, number | bigint]>("getScores", gameId),
      queryCircuit<[number | bigint, number | bigint]>("getHandSizes", gameId),
      queryCircuit<boolean>("isGameOver", gameId),
      queryCircuit<boolean>("isDeckEmpty", gameId),
      queryCircuit<number | bigint>("get_deck_size", gameId),
      queryCircuit<number | bigint>("get_top_card_index", gameId),
      queryCircuit<boolean[]>("getBookedRanks", gameId, 1n),
      queryCircuit<boolean[]>("getBookedRanks", gameId, 2n),
    ]);

  const deckRemaining = Math.max(0, Number(deckSize ?? 21) - Number(topCardIndex ?? 0));
  const fallbackRanks = [false, false, false, false, false, false, false];

  return {
    phase: Number(phase ?? 0),
    currentTurn: Number(turn ?? 1),
    scores: [Number(scores?.[0] ?? 0), Number(scores?.[1] ?? 0)],
    handSizes: [Number(sizes?.[0] ?? 0), Number(sizes?.[1] ?? 0)],
    isGameOver: gameOver === true,
    deckEmpty: deckEmpty === true,
    deckCount: deckRemaining,
    booksP1: books1 ?? fallbackRanks,
    booksP2: books2 ?? fallbackRanks,
  };
}

/**
 * Read the player's hand from the contract ledger by enumerating all 21
 * card indices via `doesPlayerHaveSpecificCard`. The circuit applies the
 * reverse ec_mul using the player's secret (set in the witness module)
 * to determine ownership. Matches the e2e reference (readHand in _helpers.ts).
 *
 * Returns card indices (0-20). Rank = index % 7, suit = Math.floor(index / 7).
 */
export async function queryHandFromContract(
  lobbyId: string,
  playerId: 1 | 2,
): Promise<number[]> {
  const gameId = lobbyIdToGameId(lobbyId);
  const gameIdHex = gameIdToHex(gameId);
  const opponentId = (playerId === 1 ? 2 : 1) as 1 | 2;

  // Set our real secret (used by the circuit via cond_select)
  const secret = PlayerKeyManager.getPlayerSecret(lobbyId, playerId);
  const seed = PlayerKeyManager.getShuffleSeed(lobbyId, playerId);
  setPlayerSecrets(gameIdHex, playerId, secret, seed);

  // The circuit fetches BOTH players' secrets unconditionally (ec_mul guard
  // pattern — compiler requirement). Only the selected one is actually used
  // in ec_mul, so any non-zero placeholder is safe for the opponent side
  // during read-only hand queries. Use the real opponent secret if available
  // locally (e.g., running both players in the same browser for testing),
  // otherwise a dummy placeholder is correct.
  let opponentWasSet = false;
  if (PlayerKeyManager.hasExistingKeys(lobbyId, opponentId)) {
    const oppSecret = PlayerKeyManager.getPlayerSecret(lobbyId, opponentId);
    const oppSeed = PlayerKeyManager.getShuffleSeed(lobbyId, opponentId);
    setPlayerSecrets(gameIdHex, opponentId, oppSecret, oppSeed);
    opponentWasSet = true;
  } else {
    setPlayerSecrets(gameIdHex, opponentId, 1n, new Uint8Array(32));
    opponentWasSet = true;
  }

  try {
    const hand: number[] = [];
    // Enumerate all 21 cards (7 ranks × 3 suits)
    for (let i = 0; i < 21; i++) {
      const has = await queryCircuit<boolean>(
        "doesPlayerHaveSpecificCard",
        gameId,
        BigInt(playerId),
        BigInt(i),
      );
      if (has === true) hand.push(i);
    }
    return hand;
  } finally {
    clearPlayerSecrets(gameIdHex, playerId);
    if (opponentWasSet) clearPlayerSecrets(gameIdHex, opponentId);
  }
}

/**
 * V3 impure read — returns the 21-wide boolean vector of which card indices
 * are in the given player's hand right now. Requires the player's secret
 * (same reason as queryHandFromContract — the circuit reverses the mask).
 * An opponent dummy secret is set for the ec_mul guard pattern.
 */
export async function queryDiscoverHand(
  lobbyId: string,
  playerId: 1 | 2,
): Promise<boolean[]> {
  const gameId = lobbyIdToGameId(lobbyId);
  const gameIdHex = gameIdToHex(gameId);
  const opponentId = (playerId === 1 ? 2 : 1) as 1 | 2;

  const secret = PlayerKeyManager.getPlayerSecret(lobbyId, playerId);
  const seed = PlayerKeyManager.getShuffleSeed(lobbyId, playerId);
  setPlayerSecrets(gameIdHex, playerId, secret, seed);

  let oppWasSet = false;
  if (PlayerKeyManager.hasExistingKeys(lobbyId, opponentId)) {
    const oppSecret = PlayerKeyManager.getPlayerSecret(lobbyId, opponentId);
    const oppSeed = PlayerKeyManager.getShuffleSeed(lobbyId, opponentId);
    setPlayerSecrets(gameIdHex, opponentId, oppSecret, oppSeed);
    oppWasSet = true;
  } else {
    setPlayerSecrets(gameIdHex, opponentId, 1n, new Uint8Array(32));
    oppWasSet = true;
  }

  try {
    const result = await queryCircuit<boolean[]>(
      "discoverHand",
      gameId,
      BigInt(playerId),
    );
    return result ?? [];
  } finally {
    clearPlayerSecrets(gameIdHex, playerId);
    if (oppWasSet) clearPlayerSecrets(gameIdHex, opponentId);
  }
}

/** V3 impure read — returns [r0, r1, …, r6] where rN=true iff the player
 *  has booked rank N. No witness dependency (pure ledger read). */
export async function queryBookedRanks(
  lobbyId: string,
  playerId: 1 | 2,
): Promise<boolean[]> {
  const gameId = lobbyIdToGameId(lobbyId);
  const result = await queryCircuit<boolean[]>(
    "getBookedRanks",
    gameId,
    BigInt(playerId),
  );
  return result ?? [false, false, false, false, false, false, false];
}

/** V3 impure read — has the given player completed their post-deal
 *  scoreInitialBooks scan? Used to gate the first askForCard. */
export async function queryHasInitialBooksScored(
  lobbyId: string,
  playerId: 1 | 2,
): Promise<boolean> {
  const gameId = lobbyIdToGameId(lobbyId);
  const result = await queryCircuit<boolean>(
    "hasInitialBooksScored",
    gameId,
    BigInt(playerId),
  );
  return result === true;
}

export async function callApplyMask(lobbyId: string, playerId: 1 | 2): Promise<void> {
  console.log(`[GoFishContractService] callApplyMask: lobbyId=${lobbyId} playerId=${playerId}`);
  const addr = await getContractAddress();
  const { contract, provider } = await getJoinedContract(addr, `privateState-${lobbyId}-${playerId}`);

  await withSecrets(lobbyId, playerId, async (gameId) => {
    await callDelegated(provider, "applyMask", () =>
      contract.callTx.applyMask(gameId, BigInt(playerId)),
      { lobbyId, playerId },
    );
  });
}

export async function callDealCards(lobbyId: string, playerId: 1 | 2): Promise<void> {
  const addr = await getContractAddress();
  const { contract, provider } = await getJoinedContract(addr, `privateState-${lobbyId}-${playerId}`);

  await withSecrets(lobbyId, playerId, async (gameId) => {
    await callDelegated(provider, "dealCards", () =>
      contract.callTx.dealCards(gameId, BigInt(playerId)),
      { lobbyId, playerId },
    );
  });
}

/**
 * V3 post-deal scan. Each player submits exactly one of these after
 * dealCards and before askForCard:
 *   - If the dealt hand contains a 3-of-rank book: pass the three card
 *     indices (sorted, in [0,20]).
 *   - Otherwise: pass the sentinel [255n, 255n, 255n].
 * The contract verifies the claim algebraically (rank-equality + distinct
 * + card-in-hand), removes the booked cards, and sets initialBooksScoredP<x>.
 */
export async function callScoreInitialBooks(
  lobbyId: string,
  playerId: 1 | 2,
  bookIndices: [bigint, bigint, bigint],
): Promise<void> {
  const addr = await getContractAddress();
  const { contract, provider } = await getJoinedContract(addr, `privateState-${lobbyId}-${playerId}`);
  const now = BigInt(Math.floor(Date.now() / 1000));

  await withSecrets(lobbyId, playerId, async (gameId) => {
    await callDelegated(provider, "scoreInitialBooks", () =>
      contract.callTx.scoreInitialBooks(
        gameId,
        BigInt(playerId),
        // Vector<3, Uint<8>> — compact-runtime expects bigints at every slot.
        bookIndices as unknown as bigint[],
        now,
      ),
      { lobbyId, playerId },
    );
  });
}

export async function callAskForCard(
  lobbyId: string,
  playerId: 1 | 2,
  rank: number,
): Promise<void> {
  const addr = await getContractAddress();
  const { contract, provider } = await getJoinedContract(addr, `privateState-${lobbyId}-${playerId}`);
  const now = BigInt(Math.floor(Date.now() / 1000));

  await withSecrets(lobbyId, playerId, async (gameId) => {
    await callDelegated(provider, "askForCard", () =>
      contract.callTx.askForCard(gameId, BigInt(playerId), BigInt(rank), now)
    );
  });
}

export async function callRespondToAsk(lobbyId: string, playerId: 1 | 2): Promise<void> {
  const addr = await getContractAddress();
  const { contract, provider } = await getJoinedContract(addr, `privateState-${lobbyId}-${playerId}`);
  const now = BigInt(Math.floor(Date.now() / 1000));

  await withSecrets(lobbyId, playerId, async (gameId) => {
    await callDelegated(provider, "respondToAsk", () =>
      contract.callTx.respondToAsk(gameId, BigInt(playerId), now)
    );
  });
}

// callGoFish deleted — no goFish circuit exists in the compiled contract.
// respondToAsk handles the draw internally; the turn flow is:
// askForCard → respondToAsk → (if WaitForDrawCheck) afterGoFish.

export async function callAfterGoFish(
  lobbyId: string,
  playerId: 1 | 2,
): Promise<void> {
  const addr = await getContractAddress();
  const { contract, provider } = await getJoinedContract(addr, `privateState-${lobbyId}-${playerId}`);
  const now = BigInt(Math.floor(Date.now() / 1000));

  await withSecrets(lobbyId, playerId, async (gameId) => {
    // Contract v3: afterGoFish(gameId, playerId, now) — 3 args only.
    // The contract decrypts the drawn card internally and determines
    // drewRequestedCard programmatically (game.compact:451-510).
    await callDelegated(provider, "afterGoFish", () =>
      contract.callTx.afterGoFish(gameId, BigInt(playerId), now)
    );
  });
}

export async function callSwitchTurn(lobbyId: string, playerId: 1 | 2): Promise<void> {
  const addr = await getContractAddress();
  const { contract, provider } = await getJoinedContract(addr, `privateState-${lobbyId}-${playerId}`);
  const gameId = lobbyIdToGameId(lobbyId);

  await callDelegated(provider, "switchTurn", () =>
    contract.callTx.switchTurn(gameId, BigInt(playerId))
  );
}

/**
 * V3.1 (2026-04-17): re-exported. `respondToAsk` cannot safely auto-book for
 * the asker (dummy-secret problem — see CONTRACT_V3.md V3.1 section), so the
 * asker's frontend must call this after a successful transfer to claim any
 * resulting book at the just-asked rank.
 *
 * Signature: `checkAndScoreBook(gameId, playerId, targetRank)` — no `now`
 * parameter; returns Boolean but we don't read it (tx-style call).
 */
export async function callCheckAndScoreBook(
  lobbyId: string,
  playerId: 1 | 2,
  targetRank: number,
): Promise<void> {
  const addr = await getContractAddress();
  const { contract, provider } = await getJoinedContract(addr, `privateState-${lobbyId}-${playerId}`);

  await withSecrets(lobbyId, playerId, async (gameId) => {
    await callDelegated(provider, "checkAndScoreBook", () =>
      contract.callTx.checkAndScoreBook(gameId, BigInt(playerId), BigInt(targetRank)),
      { lobbyId, playerId },
    );
  });
}

/**
 * V3.3 (2026-04-17): empty-hand dispatch. Caller has 0 cards, deck has cards,
 * it's their turn at TurnStart. Contract flips phase to WaitForDraw; the
 * opponent must then call `drawCard` to resolve the draw for the asker.
 */
export async function callRequestToDrawCard(
  lobbyId: string,
  playerId: 1 | 2,
): Promise<void> {
  const addr = await getContractAddress();
  const { contract, provider } = await getJoinedContract(addr, `privateState-${lobbyId}-${playerId}`);
  const now = BigInt(Math.floor(Date.now() / 1000));

  await callDelegated(provider, "requestToDrawCard", () =>
    contract.callTx.requestToDrawCard(lobbyIdToGameId(lobbyId), BigInt(playerId), now),
    { lobbyId, playerId },
  );
}

/**
 * V3.3 (2026-04-17): opponent-side counterpart to requestToDrawCard. Caller
 * (the NON-asking player) strips their mask from the top deck card and hands
 * it to the asker. Uses ec_mul — needs secrets.
 */
export async function callDrawCard(
  lobbyId: string,
  playerId: 1 | 2,
): Promise<void> {
  const addr = await getContractAddress();
  const { contract, provider } = await getJoinedContract(addr, `privateState-${lobbyId}-${playerId}`);
  const now = BigInt(Math.floor(Date.now() / 1000));

  await withSecrets(lobbyId, playerId, async (gameId) => {
    await callDelegated(provider, "drawCard", () =>
      contract.callTx.drawCard(gameId, BigInt(playerId), now),
      { lobbyId, playerId },
    );
  });
}

/**
 * V3.3 (2026-04-17): empty-hand skip when the deck is also empty. Caller has
 * 0 cards, deck has 0 cards, their turn at TurnStart. Just switches turn.
 */
export async function callSkipTurn(
  lobbyId: string,
  playerId: 1 | 2,
): Promise<void> {
  const addr = await getContractAddress();
  const { contract, provider } = await getJoinedContract(addr, `privateState-${lobbyId}-${playerId}`);
  const now = BigInt(Math.floor(Date.now() / 1000));

  await callDelegated(provider, "skipTurn", () =>
    contract.callTx.skipTurn(lobbyIdToGameId(lobbyId), BigInt(playerId), now),
    { lobbyId, playerId },
  );
}

/**
 * V4.2 (2026-04-18): frontend must call this after each turn to flip the
 * contract's phase to GameOver when the deck is empty AND either hand is
 * empty. The early-win-at-4-books path is automatic inside `addScore`, so
 * this is only needed for the exhaustion terminal state.
 */
export async function callCheckAndEndGame(
  lobbyId: string,
  playerId: 1 | 2,
): Promise<void> {
  const addr = await getContractAddress();
  const { contract, provider } = await getJoinedContract(addr, `privateState-${lobbyId}-${playerId}`);

  await callDelegated(provider, "checkAndEndGame", () =>
    contract.callTx.checkAndEndGame(lobbyIdToGameId(lobbyId)),
    { lobbyId, playerId },
  );
}

export async function callClaimTimeoutWin(lobbyId: string, playerId: 1 | 2): Promise<void> {
  const addr = await getContractAddress();
  const { contract, provider } = await getJoinedContract(addr, `privateState-${lobbyId}-${playerId}`);
  const gameId = lobbyIdToGameId(lobbyId);

  await callDelegated(provider, "claimTimeoutWin", () =>
    contract.callTx.claimTimeoutWin(gameId, BigInt(playerId))
  );
}

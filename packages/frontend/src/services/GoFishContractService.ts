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
import { toHex } from "@midnight-ntwrk/compact-runtime";
import { CompiledContract } from "@midnight-ntwrk/compact-js";
import { getBrowserProofProvider } from "./midnightBrowserProofProvider";
import { createInMemoryPrivateStateProvider } from "./midnightInMemoryPrivateStateProvider";
import {
  witnesses,
  setPlayerSecrets,
  clearPlayerSecrets,
} from "../../../shared/contracts/midnight/go-fish-contract/src/_index";
import {
  Contract as GoFishContractClass,
} from "../../../shared/contracts/midnight/go-fish-contract/src/managed/contract/index.js";
import { PlayerKeyManager } from "./PlayerKeyManager";
import { API_BASE_URL } from "../apiConfig";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BASE_URL_MIDNIGHT_INDEXER_API =
  import.meta.env.VITE_INDEXER_HTTP_URL || "http://127.0.0.1:8089/api/v1/graphql";
const BASE_URL_MIDNIGHT_INDEXER_WS =
  import.meta.env.VITE_INDEXER_WS_URL || "ws://127.0.0.1:8089/api/v1/graphql/ws";
const BATCHER_URL = import.meta.env.VITE_BATCHER_URL || "";

/** Sentinel thrown by the balanceTx hook to abort the SDK pipeline after delegation. */
const DELEGATED_SENTINEL = "GoFish: delegated to midnight_balancing batcher";

// ---------------------------------------------------------------------------
// Module-level singletons
// ---------------------------------------------------------------------------

let _zkConfigProvider: FetchZkConfigProvider<string> | null = null;
let _compiledContract: any = null;
/** Cached joined contracts keyed by contractAddress+privateStateId */
const _contractCache = new Map<string, any>();

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

  // Prefer backend config
  try {
    const res = await fetch(`${API_BASE_URL}/api/midnight/contract_address`);
    if (res.ok) {
      const data = await res.json();
      if (data.contractAddress) {
        _contractAddress = normalizeAddress(data.contractAddress);
        return _contractAddress;
      }
    }
  } catch { /* fall through */ }

  // Fall back to static deployment file
  const res = await fetch("/contract_address/go-fish-contract.undeployed.json");
  if (!res.ok) throw new Error("[GoFishContractService] Contract address not found");
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
    // Dummy coin keys — the batcher wallet covers dust balancing
    getCoinPublicKey() { return "00".repeat(32); },
    getEncryptionPublicKey() { return "00".repeat(32); },

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

async function postToBatcher(serializedTx: string, circuitId: string): Promise<void> {
  const txStage = detectTxStage(serializedTx);
  const body = {
    data: {
      target: "midnight_balancing",
      address: "go_fish_player",
      addressType: 0,
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

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`[GoFishContractService] Batcher rejected ${circuitId}: ${text}`);
  }
  console.log(`[GoFishContractService] ${circuitId} (${txStage}) submitted to batcher`);
}

async function callDelegated(
  provider: any,
  circuitId: string,
  callFn: () => Promise<any>,
): Promise<void> {
  let delegated = false;

  provider.__delegatedBalanceHook = async (tx: any) => {
    const serializedTx = toHex((tx as any).serialize());
    await postToBatcher(serializedTx, circuitId);
    delegated = true;  // posted successfully — any subsequent SDK throw is safe to suppress
  };

  try {
    await callFn();
  } catch (error) {
    // Suppress if: (a) the sentinel propagated through the SDK, or (b) we already
    // posted to the batcher and the SDK threw after balanceTx returned (e.g.,
    // EffectStream validation error, submitTx unreachable, etc.)
    if (isDelegationError(error) || delegated) return;
    throw error;
  } finally {
    delete provider.__delegatedBalanceHook;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function lobbyIdToGameId(lobbyId: string): Uint8Array {
  const enc = new TextEncoder().encode(lobbyId);
  const b = new Uint8Array(32);
  b.set(enc.slice(0, 32));
  return b;
}

function gameIdToHex(gameId: Uint8Array): string {
  return "0x" + Array.from(gameId).map(x => x.toString(16).padStart(2, "0")).join("");
}

/** Set secrets for both players before a circuit call. Clears in finally. */
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
  setPlayerSecrets(gameIdHex, primaryId, secret, seed);

  // Set opponent secrets if available locally
  if (PlayerKeyManager.hasExistingKeys(lobbyId, oppId)) {
    const oppSecret = PlayerKeyManager.getPlayerSecret(lobbyId, oppId);
    const oppSeed = PlayerKeyManager.getShuffleSeed(lobbyId, oppId);
    setPlayerSecrets(gameIdHex, oppId, oppSecret, oppSeed);
  }

  return fn(gameId).finally(() => {
    clearPlayerSecrets(gameIdHex, primaryId);
    if (PlayerKeyManager.hasExistingKeys(lobbyId, oppId)) {
      clearPlayerSecrets(gameIdHex, oppId);
    }
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

export async function callApplyMask(lobbyId: string, playerId: 1 | 2): Promise<void> {
  const addr = await getContractAddress();
  const { contract, provider } = await getJoinedContract(addr, `privateState-${lobbyId}-${playerId}`);

  await withSecrets(lobbyId, playerId, async (gameId) => {
    await callDelegated(provider, "applyMask", () =>
      contract.callTx.applyMask(gameId, BigInt(playerId))
    );
  });
}

export async function callDealCards(lobbyId: string, playerId: 1 | 2): Promise<void> {
  const addr = await getContractAddress();
  const { contract, provider } = await getJoinedContract(addr, `privateState-${lobbyId}-${playerId}`);

  await withSecrets(lobbyId, playerId, async (gameId) => {
    await callDelegated(provider, "dealCards", () =>
      contract.callTx.dealCards(gameId, BigInt(playerId))
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

export async function callGoFish(lobbyId: string, playerId: 1 | 2): Promise<void> {
  const addr = await getContractAddress();
  const { contract, provider } = await getJoinedContract(addr, `privateState-${lobbyId}-${playerId}`);
  const now = BigInt(Math.floor(Date.now() / 1000));

  await withSecrets(lobbyId, playerId, async (gameId) => {
    await callDelegated(provider, "goFish", () =>
      contract.callTx.goFish(gameId, BigInt(playerId), now)
    );
  });
}

export async function callAfterGoFish(
  lobbyId: string,
  playerId: 1 | 2,
  drewRequestedCard: boolean,
): Promise<void> {
  const addr = await getContractAddress();
  const { contract, provider } = await getJoinedContract(addr, `privateState-${lobbyId}-${playerId}`);
  const now = BigInt(Math.floor(Date.now() / 1000));

  await withSecrets(lobbyId, playerId, async (gameId) => {
    await callDelegated(provider, "afterGoFish", () =>
      contract.callTx.afterGoFish(gameId, BigInt(playerId), drewRequestedCard, now)
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

export async function callClaimTimeoutWin(lobbyId: string, playerId: 1 | 2): Promise<void> {
  const addr = await getContractAddress();
  const { contract, provider } = await getJoinedContract(addr, `privateState-${lobbyId}-${playerId}`);
  const gameId = lobbyIdToGameId(lobbyId);

  await callDelegated(provider, "claimTimeoutWin", () =>
    contract.callTx.claimTimeoutWin(gameId, BigInt(playerId))
  );
}

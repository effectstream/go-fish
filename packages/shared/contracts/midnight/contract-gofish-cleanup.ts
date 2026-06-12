#!/usr/bin/env bun
/**
 * Clean up a finished Go Fish game.
 *
 * Calls the `cleanupGame(gameId, 0)` circuit on the deployed contract
 * using the owner path (callerPlayerId=0), removing all ledger entries
 * for the game (hands, deck, scores, phase, etc.).
 *
 * Transaction balancing and submission are delegated to the batcher
 * (the cleanup wallet does not need NIGHT tokens for dust).
 *
 * Usage:
 *   MIDNIGHT_ADMIN_SECRET="<hex-or-string>" \
 *   MIDNIGHT_CLEAN_SEED="<seed>" \
 *   MIDNIGHT_STORAGE_PASSWORD="D3vP@ssw0rd!xK9m" \
 *   BATCHER_URL="http://localhost:3336" \
 *   bun run contract-gofish-cleanup.ts <game_id>
 *
 * Arguments:
 *   game_id  The ASCII game/lobby ID (e.g. "lobby_15206_01234567")
 *
 * Requires: proof server + batcher running.
 */

import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { findDeployedContract } from "@midnight-ntwrk/midnight-js-contracts";
import { CompiledContract } from "@midnight-ntwrk/compact-js";
import type { PrivateStateId, MidnightProviders, UnboundTransaction } from "@midnight-ntwrk/midnight-js-types";
import type {
  CoinPublicKey,
  EncPublicKey,
  FinalizedTransaction,
  TransactionId,
} from "@midnight-ntwrk/ledger-v8";
import { httpClientProofProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { levelPrivateStateProvider } from "@midnight-ntwrk/midnight-js-level-private-state-provider";
import { NodeZkConfigProvider } from "@midnight-ntwrk/midnight-js-node-zk-config-provider";
import type { NetworkId } from "@midnight-ntwrk/wallet-sdk-abstractions";

import { midnightNetworkConfig } from "@effectstream/midnight-contracts/midnight-env";
import { buildWalletFacade } from "./faucet.ts";
import {
  Contract,
  witnesses as baseWitnesses,
  setAdminSecret,
  type PrivateState,
} from "./go-fish-contract/src/_index.ts";

// ============================================================================
// Constants
// ============================================================================

const BATCHER_URL = process.env.BATCHER_URL || "http://localhost:3336";
const DELEGATED_TX_SENTINEL = "delegated-to-batcher";

// ============================================================================
// Parse arguments
// ============================================================================

const gameIdArg = process.argv[2];
if (!gameIdArg) {
  console.error("Usage: contract-gofish-cleanup.ts <game_id>");
  console.error("  game_id: The ASCII game/lobby ID (e.g. lobby_15206_01234567)");
  process.exit(1);
}

function lobbyIdToGameId(lobbyId: string): Uint8Array {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(lobbyId);
  const gameId = new Uint8Array(32);
  gameId.set(encoded.slice(0, Math.min(32, encoded.length)));
  return gameId;
}

const gameIdBytes = lobbyIdToGameId(gameIdArg);
console.log(`Game ID to clean up: "${gameIdArg}"`);

// ============================================================================
// Admin secret for the owner path
// ============================================================================

const JUBJUB_SCALAR_FIELD_ORDER = 6554484396890773809930967563523245729705921265872317281365359162392183254199n;

function getAdminSecret(): bigint {
  const raw = process.env.MIDNIGHT_ADMIN_SECRET ?? "MIDNIGHT_ADMIN_SECRET";
  let val: bigint;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    val = BigInt("0x" + raw);
  } else {
    const bytes = new TextEncoder().encode(raw);
    const padded = new Uint8Array(32);
    padded.set(bytes.slice(0, 32));
    val = 0n;
    for (const b of padded) {
      val = (val << 8n) | BigInt(b);
    }
  }
  val = val % JUBJUB_SCALAR_FIELD_ORDER;
  if (val === 0n) val = 1n;
  return val;
}

// ============================================================================
// Load deployed contract address
// ============================================================================

function loadContractAddress(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const networkId = midnightNetworkConfig.id;
  const filePath = path.join(here, `go-fish-contract.${networkId}.json`);
  const data = JSON.parse(readFileSync(filePath, "utf-8"));
  if (!data.contractAddress) {
    throw new Error(`No contractAddress found in ${filePath}`);
  }
  return data.contractAddress;
}

// ============================================================================
// Set admin secret for the witness
// ============================================================================

const adminSecretValue = getAdminSecret();
setAdminSecret(adminSecretValue);

// ============================================================================
// Main
// ============================================================================

const networkId = midnightNetworkConfig.id as NetworkId.NetworkId;
setNetworkId(networkId);

const contractAddress = loadContractAddress();
console.log(`Network: ${networkId}`);
console.log(`Contract: ${contractAddress}`);

const NETWORK = {
  indexer: midnightNetworkConfig.indexer,
  indexerWS: midnightNetworkConfig.indexerWS,
  node: midnightNetworkConfig.node,
  proofServer: midnightNetworkConfig.proofServer,
};

// Check proof server
try {
  const resp = await fetch(`${NETWORK.proofServer}/health`);
  const data = await resp.json();
  if (data.status !== "ok") throw new Error("unhealthy");
  console.log("Proof server: OK");
} catch {
  console.error(`Proof server not running at ${NETWORK.proofServer}`);
  process.exit(1);
}

// Check batcher
try {
  const resp = await fetch(`${BATCHER_URL}/health`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  console.log(`Batcher: OK (${BATCHER_URL})`);
} catch {
  console.error(`Batcher not running at ${BATCHER_URL}`);
  process.exit(1);
}

// Build wallet (keys only — batcher handles balancing/dust)
console.log("\n--- Building wallet (keys only, batcher handles balancing) ---");
const walletSeed = process.env.MIDNIGHT_CLEAN_SEED || midnightNetworkConfig.walletSeed;
const walletResult = await buildWalletFacade(NETWORK as any, walletSeed, networkId);
console.log(`Unshielded address: ${walletResult.unshieldedAddress}`);

// Set up providers
const here = path.dirname(fileURLToPath(import.meta.url));
const managedDir = path.resolve(path.join(here, "go-fish-contract/src/managed"));
const zkConfigProvider = new NodeZkConfigProvider(managedDir);

// Batcher delegation: balanceTx posts the proven tx to the batcher, submitTx returns a sentinel.
let pendingTxHash: string | null = null;

const walletAndMidnightProvider = {
  getCoinPublicKey(): CoinPublicKey {
    return walletResult.zswapSecretKeys.coinPublicKey;
  },
  getEncryptionPublicKey(): EncPublicKey {
    return walletResult.zswapSecretKeys.encryptionPublicKey;
  },
  async balanceTx(tx: UnboundTransaction): Promise<FinalizedTransaction> {
    const serializedTx = Buffer.from(tx.serialize()).toString("hex");
    const body = {
      data: {
        target: "midnight_balancing",
        address: "system_cleanup",
        addressType: 0,
        input: JSON.stringify({ tx: serializedTx, txStage: "unbound", circuitId: "cleanupGame" }),
        timestamp: Date.now(),
      },
      confirmationLevel: "wait-receipt",
    };
    const response = await fetch(`${BATCHER_URL}/send-input`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Batcher rejected transaction (HTTP ${response.status}): ${text}`);
    }
    const result = await response.json();
    if (!result.success) throw new Error(`Batcher failed: ${result.message}`);
    pendingTxHash = result.transactionHash ?? null;
    console.log(`[cleanup] Batcher confirmed txHash=${pendingTxHash}`);
    return tx as unknown as FinalizedTransaction;
  },
  submitTx(_tx: FinalizedTransaction): Promise<TransactionId> {
    return Promise.resolve(DELEGATED_TX_SENTINEL as unknown as TransactionId);
  },
};

// Query indexer for the ZK identifier of a transaction by its hash.
const getTxIdentifierByHash = async (txHash: string): Promise<string | null> => {
  const query = `
    query GetTxByHash($hash: String!) {
      transactions(offset: { hash: $hash }) {
        ... on RegularTransaction { identifiers }
      }
    }
  `;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const response = await fetch(NETWORK.indexer, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables: { hash: txHash } }),
      });
      const json = await response.json();
      const txs: any[] = json?.data?.transactions ?? [];
      if (txs.length > 0 && Array.isArray(txs[0].identifiers) && txs[0].identifiers.length > 0) {
        console.log(`[cleanup] txHash=${txHash} → identifier=${txs[0].identifiers[0]} (attempt ${attempt})`);
        return txs[0].identifiers[0] as string;
      }
    } catch (e) {
      console.warn(`[cleanup:getTxIdentifierByHash] attempt ${attempt} error:`, e);
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  return null;
};

// Wrap publicDataProvider to intercept the sentinel txId from batcher delegation.
const basePublicDataProvider = indexerPublicDataProvider(NETWORK.indexer, NETWORK.indexerWS);
const publicDataProvider = {
  ...basePublicDataProvider,
  watchForTxData: async (txId: any): Promise<any> => {
    if ((txId as string) !== DELEGATED_TX_SENTINEL) {
      return basePublicDataProvider.watchForTxData(txId);
    }
    const txHash = pendingTxHash;
    pendingTxHash = null;
    if (txHash) {
      console.log(`[cleanup] watchForTxData: resolving identifier for txHash=${txHash}...`);
      const identifier = await getTxIdentifierByHash(txHash);
      if (identifier) {
        console.log(`[cleanup] watchForTxData: waiting for chain confirmation via identifier=${identifier}`);
        return basePublicDataProvider.watchForTxData(identifier as any);
      }
      console.warn("[cleanup] watchForTxData: could not resolve identifier, returning mock");
    }
    return {
      tx: null as any,
      status: "succeed-entirely",
      txId,
      identifiers: [],
      txHash: DELEGATED_TX_SENTINEL as any,
      blockHash: DELEGATED_TX_SENTINEL,
      blockHeight: 0,
      blockTimestamp: Date.now(),
      blockAuthor: null,
      indexerId: 0,
      protocolVersion: 0,
      fees: { paidFees: "0", estimatedFees: "0" },
      segmentStatusMap: undefined,
      unshielded: { created: [], spent: [] },
    };
  },
};

const providers: MidnightProviders = {
  privateStateProvider: levelPrivateStateProvider({
    midnightDbName: "midnight-level-db-cleanup",
    privateStateStoreName: "go-fish-private-state-cleanup",
    signingKeyStoreName: "go-fish-signing-keys-cleanup",
    privateStoragePasswordProvider: async () => process.env.MIDNIGHT_STORAGE_PASSWORD ?? "D3vP@ssw0rd!xK9m",
    accountId: Buffer.from(walletResult.zswapSecretKeys.coinPublicKey).toString("hex"),
  }),
  publicDataProvider,
  zkConfigProvider,
  proofProvider: httpClientProofProvider(NETWORK.proofServer, zkConfigProvider),
  walletProvider: walletAndMidnightProvider,
  midnightProvider: walletAndMidnightProvider,
};

// Find deployed contract
console.log("\n--- Finding deployed contract ---");

const goFishCompiledContract = CompiledContract.make("go-fish-contract", Contract.Contract as any).pipe(
  CompiledContract.withWitnesses(baseWitnesses as never),
  CompiledContract.withCompiledFileAssets(managedDir),
);

const initialPrivateState = {} as PrivateState as any;

const foundContract = await findDeployedContract(providers, {
  contractAddress,
  compiledContract: goFishCompiledContract as any,
  privateStateId: "privateState" as PrivateStateId,
  initialPrivateState,
});

console.log(`Contract found. Calling cleanupGame("${gameIdArg}", 0)...`);

// Call cleanupGame with owner path (callerPlayerId=0)
try {
  await (foundContract.callTx as any).cleanupGame(gameIdBytes, 0n);
  console.log(`cleanupGame("${gameIdArg}") succeeded — game ledger entries removed.`);
} catch (err) {
  console.error("cleanupGame() failed:", err instanceof Error ? err.message : err);
  process.exit(1);
}

// Cleanup
await walletResult.wallet.stop();
console.log("Done.");
process.exit(0);

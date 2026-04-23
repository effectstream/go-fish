#!/usr/bin/env -S deno run -A --unstable-detect-cjs
/**
 * Initialize the Go Fish contract owner.
 *
 * Calls the `initialize()` circuit on an already-deployed contract,
 * setting the owner to `h_hashField(admin_secret_key())`.
 *
 * The admin secret is read from MIDNIGHT_ADMIN_SECRET env var.
 * If unset, defaults to "MIDNIGHT_ADMIN_SECRET" (for local dev).
 *
 * Usage:
 *   MIDNIGHT_STORAGE_PASSWORD="D3vP@ssw0rd!xK9m" \
 *   MIDNIGHT_ADMIN_SECRET="<hex-or-string>" \
 *   deno run -A --unstable-detect-cjs contract-initialize.ts
 */

import { Buffer } from "node:buffer";
import * as path from "@std/path";

import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { findDeployedContract } from "@midnight-ntwrk/midnight-js-contracts";
import { CompiledContract } from "@midnight-ntwrk/compact-js";
import type { PrivateStateId, MidnightProviders } from "@midnight-ntwrk/midnight-js-types";
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

import { midnightNetworkConfig } from "@paimaexample/midnight-contracts/midnight-env";
import {
  buildWalletFacade,
  syncAndWaitForFunds,
  registerNightForDust,
  waitForDustFunds,
} from "./faucet.ts";
import {
  Contract,
  witnesses as baseWitnesses,
  setAdminSecret,
  type PrivateState,
} from "./go-fish-contract/src/_index.ts";

// ============================================================================
// Constants
// ============================================================================

const TTL_DURATION_MS = 60 * 60 * 1000;

function createTtl(): Date {
  return new Date(Date.now() + TTL_DURATION_MS);
}

// ============================================================================
// Admin secret
// ============================================================================

const JUBJUB_SCALAR_FIELD_ORDER = 6554484396890773809930967563523245729705921265872317281365359162392183254199n;

function getAdminSecret(): bigint {
  const raw = Deno.env.get("MIDNIGHT_ADMIN_SECRET") ?? "MIDNIGHT_ADMIN_SECRET";
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
  // Reduce mod Jubjub scalar field order to keep it valid for ec_mul
  val = val % JUBJUB_SCALAR_FIELD_ORDER;
  if (val === 0n) val = 1n;
  return val;
}

// ============================================================================
// Load deployed contract address
// ============================================================================

function loadContractAddress(): string {
  const here = path.dirname(path.fromFileUrl(import.meta.url));
  const networkId = midnightNetworkConfig.id;
  const filePath = path.join(here, `go-fish-contract.${networkId}.json`);
  const data = JSON.parse(Deno.readTextFileSync(filePath));
  if (!data.contractAddress) {
    throw new Error(`No contractAddress found in ${filePath}`);
  }
  return data.contractAddress;
}

// ============================================================================
// Witnesses — override admin_secret_key via setAdminSecret
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
  Deno.exit(1);
}

// Build wallet
console.log("\n--- Building wallet ---");
const walletSeed = midnightNetworkConfig.walletSeed;
const walletResult = await buildWalletFacade(NETWORK as any, walletSeed, networkId);
console.log(`Unshielded address: ${walletResult.unshieldedAddress}`);

console.log("Syncing wallet...");
const balances = await syncAndWaitForFunds(walletResult.wallet, {
  waitNonZero: false,
  timeoutMs: 300_000,
} as any);
console.log(`Shielded: ${balances.shieldedBalance}, Unshielded: ${balances.unshieldedBalance}, Dust: ${balances.dustBalance}`);

if (balances.dustBalance === 0n && balances.unshieldedBalance > 0n) {
  console.log("Registering NIGHT for dust...");
  const registered = await registerNightForDust(walletResult);
  if (registered) {
    try {
      const dust = await waitForDustFunds(walletResult.wallet, { waitNonZero: true, timeoutMs: 60_000 });
      console.log(`Dust balance after registration: ${dust}`);
    } catch {
      console.warn("Dust not available after registration — proceeding anyway.");
    }
  } else {
    console.warn("No unregistered Night UTXOs — proceeding without dust.");
  }
}

// Set up providers
const here = path.dirname(path.fromFileUrl(import.meta.url));
const managedDir = path.resolve(path.join(here, "go-fish-contract/src/managed"));
const zkConfigProvider = new NodeZkConfigProvider(managedDir);

const walletAndMidnightProvider = {
  getCoinPublicKey(): CoinPublicKey {
    return walletResult.zswapSecretKeys.coinPublicKey;
  },
  getEncryptionPublicKey(): EncPublicKey {
    return walletResult.zswapSecretKeys.encryptionPublicKey;
  },
  async balanceTx(tx: any, ttl?: Date): Promise<FinalizedTransaction> {
    const bound = tx.bind();
    const recipe = await walletResult.wallet.balanceFinalizedTransaction(bound, {
      shieldedSecretKeys: walletResult.walletZswapSecretKeys as any,
      dustSecretKey: walletResult.walletDustSecretKey as any,
    }, { ttl: ttl ?? createTtl() });
    const signed = await walletResult.wallet.signRecipe(recipe, (payload: Uint8Array) =>
      walletResult.unshieldedKeystore.signData(payload),
    );
    return walletResult.wallet.finalizeRecipe(signed);
  },
  submitTx(tx: FinalizedTransaction): Promise<TransactionId> {
    return walletResult.wallet.submitTransaction(tx);
  },
};

const providers: MidnightProviders = {
  privateStateProvider: levelPrivateStateProvider({
    midnightDbName: "midnight-level-db-deploy",
    privateStateStoreName: "go-fish-private-state-deploy",
    signingKeyStoreName: "go-fish-signing-keys-deploy",
    privateStoragePasswordProvider: async () => Deno.env.get("MIDNIGHT_STORAGE_PASSWORD") ?? "D3vP@ssw0rd!xK9m",
    accountId: Buffer.from(walletResult.zswapSecretKeys.coinPublicKey).toString("hex"),
  }),
  publicDataProvider: indexerPublicDataProvider(NETWORK.indexer, NETWORK.indexerWS),
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

console.log("Contract found.");

// Inspect ledger state to check if already initialized
const ledgerState = foundContract.deployTxData?.public?.contractState?.data;
console.log("Ledger keys:", ledgerState ? Object.keys(ledgerState) : "N/A");

// Try local simulation first to check for Compact-level errors
console.log("\nTrying local query: isOwner()...");
try {
  const isOwner = await (foundContract.callTx as any).isOwner();
  console.log("isOwner() result:", isOwner);
} catch (err: any) {
  console.log("isOwner() query failed:", err?.cause?.message ?? err?.message ?? err);
}

console.log("\nCalling initialize()...");
try {
  await (foundContract.callTx as any).initialize();
  console.log("initialize() succeeded — owner is now set.");
} catch (err: any) {
  const fullMsg = String(err?.cause?.cause?.message ?? err?.cause?.message ?? err?.message ?? err);
  if (fullMsg.includes("Owner already initialized")) {
    console.log("initialize() skipped — owner already set.");
  } else {
    console.error("initialize() failed:", fullMsg);
    // Walk the full cause chain
    let cause = err?.cause;
    let depth = 0;
    while (cause && depth < 5) {
      console.error(`  cause[${depth}]:`, cause.message ?? cause);
      cause = cause.cause;
      depth++;
    }
    Deno.exit(1);
  }
}

// Also call init_deck to set up static deck mappings
console.log("\nCalling init_deck()...");
try {
  await (foundContract.callTx as any).init_deck();
  console.log("init_deck() succeeded — static deck mappings initialized.");
} catch (err: any) {
  const fullMsg = String(err?.cause?.cause?.message ?? err?.cause?.message ?? err?.message ?? err);
  console.error("init_deck() failed:", fullMsg);
  let cause = err?.cause;
  let depth = 0;
  while (cause && depth < 5) {
    console.error(`  cause[${depth}]:`, cause.message ?? cause);
    cause = cause.cause;
    depth++;
  }
  Deno.exit(1);
}

// Cleanup
await walletResult.wallet.stop();
console.log("Done.");
Deno.exit(0);

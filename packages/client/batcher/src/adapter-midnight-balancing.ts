/**
 * Go Fish Midnight Balancing Adapter
 *
 * Handles pre-proven unbound transactions that originate from the browser's WASM
 * prover. The browser calls findDeployedContract + callTx to evaluate the circuit
 * and generate a ZK proof locally, then intercepts at balanceTx and POSTs the
 * proven UnboundTransaction here with txStage="unbound".
 *
 * This adapter only adds dust fees (balanceUnboundTransaction) and submits —
 * it never calls the proof server.
 *
 * Important: we deserialize using ledger-v7 (same version used by WalletFacade internally)
 * to avoid a WASM instance mismatch. The browser WASM prover serializes in a wire-compatible
 * format so ledger-v7's Transaction.deserialize can consume the bytes directly.
 */

import type {
  BlockchainAdapter,
  BatchBuildingOptions,
  BatchBuildingResult,
  DefaultBatcherInput,
} from "@paimaexample/batcher";
import {
  buildWalletFacade,
  syncAndWaitForFunds,
  waitForDustFunds,
  type NetworkUrls as MidnightNetworkUrls,
} from "@paimaexample/midnight-contracts/wallet-info";
import type { WalletResult } from "@paimaexample/midnight-contracts/types";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { Transaction } from "@midnight-ntwrk/ledger-v7";
import { hexStringToUint8Array } from "@paimaexample/utils";

type BlockchainHash = string;
interface BlockchainTransactionReceipt {
  hash: BlockchainHash;
  blockNumber: bigint;
  status: number;
  [key: string]: unknown;
}

const TTL_DURATION_MS = 5 * 60 * 1000;
const createTtl = (): Date => new Date(Date.now() + TTL_DURATION_MS);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const isTestnet = Deno.env.get("EFFECTSTREAM_ENV") === "testnet";
const networkID = (isTestnet ? "testnet" : "undeployed") as "testnet" | "undeployed";

const indexer =
  Deno.env.get("INDEXER_HTTP_URL") || "http://localhost:8088/api/v3/graphql";
const indexerWS =
  Deno.env.get("INDEXER_WS_URL") || "ws://localhost:8088/api/v3/graphql/ws";
const node = Deno.env.get("NODE_URL") || "http://localhost:9944";
// Proof server is optional for the balancing adapter — it only handles
// balancing of already-proven unbound transactions and never calls the
// proof server itself. Only pass the URL if explicitly configured so that
// buildWalletFacade doesn't attempt to connect to it during wallet init.
const proofServer =
  Deno.env.get("PROOF_SERVER_URL") || "";

// ---------------------------------------------------------------------------
// Batch payload type
// ---------------------------------------------------------------------------

interface BalancingBatchPayload {
  tx: string;        // hex-encoded serialized UnboundTransaction
  txStage: string;   // "unbound"
  circuitId: string;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class GoFishBalancingAdapter
  implements BlockchainAdapter<BalancingBatchPayload | null> {
  readonly maxBatchSize = 1;

  private walletResult: WalletResult | null = null;
  private isInitialized = false;
  private initializationPromise: Promise<void> | null = null;
  private hasFunds = false;
  private walletAddress: string | null = null;

  constructor() {
    const walletSeed =
      Deno.env.get("MIDNIGHT_WALLET_SEED") ||
      "0000000000000000000000000000000000000000000000000000000000000001";
    this.initializationPromise = this.initialize(walletSeed);
  }

  private async initialize(walletSeed: string): Promise<void> {
    try {
      setNetworkId(networkID as any);
      const networkUrls: MidnightNetworkUrls = {
        indexer,
        indexerWS,
        node,
        proofServer,
      };
      this.walletResult = await buildWalletFacade(networkUrls, walletSeed, networkID);
      this.walletAddress = this.walletResult.dustAddress;
      console.log(`⚡ [balancing] wallet ready at ${this.walletAddress}`);
      this.isInitialized = true;
    } catch (err) {
      console.error("❌ [balancing] wallet init failed:", err);
    }
  }

  private async ensureFunds(): Promise<void> {
    if (!this.walletResult) return;
    if (this.hasFunds) {
      try {
        const dust = await waitForDustFunds(this.walletResult.wallet, 5_000);
        if (dust > 0n) this.hasFunds = true;
      } catch { /* ignore */ }
      return;
    }
    try {
      const balances = await syncAndWaitForFunds(this.walletResult.wallet, { timeoutMs: 60_000 });
      if (balances.dustBalance > 0n) this.hasFunds = true;
      console.log(`⚡ [balancing] dust balance: ${balances.dustBalance}`);
    } catch (err) {
      console.warn("⚠️ [balancing] ensureFunds failed:", err);
    }
  }

  // Parse `{ tx, txStage, circuitId }` from the batcher input
  buildBatchData(
    inputs: DefaultBatcherInput[],
    _options?: BatchBuildingOptions,
  ): BatchBuildingResult<BalancingBatchPayload | null> | null {
    if (inputs.length === 0) return null;

    const input = inputs[0];
    try {
      const parsed = JSON.parse(input.input);
      if (!parsed.tx || !parsed.txStage) {
        console.warn("[balancing] buildBatchData: missing tx/txStage in input");
        return { selectedInputs: [input], data: null };
      }
      return {
        selectedInputs: [input],
        data: { tx: parsed.tx, txStage: parsed.txStage, circuitId: parsed.circuitId ?? "unknown" },
      };
    } catch (err) {
      console.error("[balancing] buildBatchData parse error:", err);
      return { selectedInputs: [input], data: null };
    }
  }

  async submitBatch(data: BalancingBatchPayload | null): Promise<BlockchainHash> {
    if (this.initializationPromise) {
      await this.initializationPromise;
      this.initializationPromise = null;
    }

    if (!this.isInitialized || !this.walletResult) {
      throw new Error("[balancing] adapter not initialized");
    }

    if (!data || !data.tx) {
      throw new Error("[balancing] submitBatch called with empty data");
    }

    await this.ensureFunds();

    const { wallet, walletZswapSecretKeys, walletDustSecretKey, unshieldedKeystore } =
      this.walletResult;

    console.log(`⚡ [balancing] balancing circuit=${data.circuitId} txStage=${data.txStage}`);

    // Deserialize using ledger-v7 (same WASM instance as WalletFacade) to avoid assertClass mismatch.
    // The browser prover serializes in a wire-compatible format that ledger-v7 can consume directly.
    const txBytes = hexStringToUint8Array(data.tx);
    const unboundTx = Transaction.deserialize(
      "signature",
      "proof",
      "pre-binding",
      txBytes,
    );

    // Balance: add dust fee input/output
    const recipe = await wallet.balanceUnboundTransaction(unboundTx as any, {
      shieldedSecretKeys: walletZswapSecretKeys,
      dustSecretKey: walletDustSecretKey,
    }, { ttl: createTtl() });

    let finalizedTx;
    if (recipe.balancingTransaction) {
      const signed = await wallet.signUnprovenTransaction(
        recipe.balancingTransaction,
        (payload: Uint8Array) => unshieldedKeystore.signData(payload),
      );
      finalizedTx = await wallet.finalizeRecipe({ ...recipe, balancingTransaction: signed });
    } else {
      finalizedTx = await wallet.finalizeRecipe(recipe);
    }

    const txHash = await wallet.submitTransaction(finalizedTx);
    console.log(`✅ [balancing] circuit=${data.circuitId} submitted txHash=${txHash}`);
    return txHash;
  }

  async waitForTransactionReceipt(
    hash: BlockchainHash,
    _timeout: number = 300_000,
  ): Promise<BlockchainTransactionReceipt> {
    // Midnight circuit proving/confirmation takes 60–300s, well beyond the batcher's
    // internal 60s processBatchForTarget timeout. Returning immediately here removes the
    // input from the batcher queue as soon as submitTransaction succeeds, preventing
    // duplicate submission on the next polling cycle (Custom error: 193).
    //
    // The transaction was already submitted to the network — it will confirm independently.
    // We use the current block height as a best-effort blockNumber (0 is also acceptable).
    const currentBlock = await this.getBlockNumber().catch(() => 0n);
    console.log(`⚡ [balancing] waitForTransactionReceipt: tx=${hash.slice(0, 16)}… accepted (no-wait), block≈${currentBlock}`);
    return { hash, blockNumber: currentBlock, status: 1 };
  }

  getAccountAddress(): string {
    return this.walletAddress ?? "balancing-adapter-not-ready";
  }

  getChainName(): string {
    return `Midnight (${networkID})`;
  }

  getSyncProtocolName(): string {
    return "parallelMidnight";
  }

  isReady(): boolean {
    return this.isInitialized && this.walletResult !== null;
  }

  estimateBatchFee(_data: BalancingBatchPayload | null): bigint {
    return 0n;
  }

  async getBlockNumber(): Promise<bigint> {
    try {
      const res = await fetch(indexer, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: `query { block { height } }` }),
      });
      const json = await res.json();
      return BigInt(json?.data?.block?.height ?? 0);
    } catch {
      return 0n;
    }
  }

  verifySignature(_input: DefaultBatcherInput): boolean {
    // Midnight transactions are self-authenticating (ZK proofs); no signature needed
    return true;
  }
}

export const goFishBalancingAdapter = new GoFishBalancingAdapter();

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
} from "jsr:@paimaexample/midnight-contracts@^0.8.4/wallet-info";
import type { WalletResult } from "jsr:@paimaexample/midnight-contracts@^0.8.4/types";
import { setNetworkId } from "npm:@midnight-ntwrk/midnight-js-network-id@3.2.0";
import { Transaction } from "npm:@midnight-ntwrk/ledger-v8@8.0.2";
import { hexStringToUint8Array } from "jsr:@paimaexample/utils@^0.8.4";

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
const proofServer =
  Deno.env.get("PROOF_SERVER_URL") || "http://localhost:6300";

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

    // Deserialize the pre-proven unbound transaction (ledger-v8 format from browser WASM prover)
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
    timeout: number = 300_000,
  ): Promise<BlockchainTransactionReceipt> {
    const startTime = Date.now();
    const normalizedHash = hash.toLowerCase().replace(/^0x/, "").slice(-64).padStart(64, "0");

    while (Date.now() - startTime < timeout) {
      try {
        const res = await fetch(indexer, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: `query ($hash: String!) { transactions(offset: { hash: $hash }) { hash block { height } } }`,
            variables: { hash: normalizedHash },
          }),
        });
        const json = await res.json();
        const txs = json?.data?.transactions;
        if (txs && txs.length > 0 && txs[0].block?.height !== undefined) {
          return { hash, blockNumber: BigInt(txs[0].block.height), status: 1 };
        }
      } catch { /* retry */ }
      await new Promise(r => setTimeout(r, 1000));
    }
    throw new Error(`[balancing] tx confirmation timeout after ${timeout}ms: ${hash}`);
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

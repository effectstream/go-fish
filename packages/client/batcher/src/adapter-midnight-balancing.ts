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
 * We deserialize using ledger-v8 — the same version used by WalletFacade internally
 * (via @paimaexample/midnight-contracts@0.10.7 → wallet-sdk-facade@3.0.0 → ledger-v8).
 * The browser WASM prover serializes in ledger-v8 format.
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
import { Transaction } from "@midnight-ntwrk/ledger-v8";
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
// The balancing adapter never calls the proof server (it only balances
// already-proven unbound transactions), but the wallet facade's
// createWalletConfiguration requires a valid URL. Default to the standard
// local proof server address; override via PROOF_SERVER_URL if needed.
const proofServer =
  Deno.env.get("PROOF_SERVER_URL") || "http://localhost:6300";
const backendApiUrl =
  Deno.env.get("BACKEND_API_URL") ?? "http://localhost:9996";

// ---------------------------------------------------------------------------
// Batch payload type
// ---------------------------------------------------------------------------

interface BalancingBatchPayload {
  tx: string;        // hex-encoded serialized UnboundTransaction
  txStage: string;   // "unbound"
  circuitId: string;
  lobbyId?: string;  // optional: lobby ID for setup notifications
  playerId?: number; // optional: player ID for setup notifications
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
  private readonly walletSeed: string;

  constructor() {
    this.walletSeed =
      Deno.env.get("MIDNIGHT_WALLET_SEED") ||
      "0000000000000000000000000000000000000000000000000000000000000001";
    this.initializationPromise = this.initialize();
  }

  private async initialize(): Promise<void> {
    // Retry loop: Midnight indexer/node may not be ready when the batcher starts.
    // Keep retrying every 5s until the wallet is ready.
    while (!this.isInitialized) {
      try {
        setNetworkId(networkID as any);
        const networkUrls: MidnightNetworkUrls = {
          indexer,
          indexerWS,
          node,
          proofServer,
        };
        this.walletResult = await buildWalletFacade(networkUrls, this.walletSeed, networkID);
        this.walletAddress = this.walletResult.dustAddress;
        console.log(`⚡ [balancing] wallet ready at ${this.walletAddress}`);
        this.isInitialized = true;
      } catch (err) {
        console.error("❌ [balancing] wallet init failed, retrying in 5s:", err);
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
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
        data: {
          tx: parsed.tx,
          txStage: parsed.txStage,
          circuitId: parsed.circuitId ?? "unknown",
          lobbyId: parsed.lobbyId,
          playerId: parsed.playerId,
        },
      };
    } catch (err) {
      console.error("[balancing] buildBatchData parse error:", err);
      return { selectedInputs: [input], data: null };
    }
  }

  async submitBatch(data: BalancingBatchPayload | null, _fee?: string | bigint): Promise<BlockchainHash> {
    if (this.initializationPromise) {
      await this.initializationPromise;
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

    // Deserialize using ledger-v8 (same WASM instance as WalletFacade) to avoid assertClass mismatch.
    // The browser WASM prover serializes in v8-format; ledger-v8 Transaction.deserialize consumes it directly.
    const txBytes = hexStringToUint8Array(data.tx);
    const unboundTx = Transaction.deserialize(
      "signature",
      "proof",
      "pre-binding",
      txBytes,
    );

    // Balance: add dust fee input/output.
    // Do NOT restrict tokenKindsToBalance — let the wallet facade balance all token kinds
    // correctly. Restricting to ["dust"] was causing the node to silently reject the tx
    // because the unbound transaction's fee segment was not being properly computed.
    const recipe = await wallet.balanceUnboundTransaction(unboundTx as any, {
      shieldedSecretKeys: walletZswapSecretKeys,
      dustSecretKey: walletDustSecretKey,
    }, { ttl: createTtl() } as any);
    console.log(`⚡ [balancing] recipe type=${(recipe as any).type} hasBalancingTx=${!!(recipe as any).balancingTransaction}`);

    // Use signRecipe which handles all recipe types (UNBOUND_TRANSACTION, UNPROVEN_TRANSACTION,
    // FINALIZED_TRANSACTION) correctly. Previously we manually extracted balancingTransaction
    // and called signUnprovenTransaction, but signRecipe is the canonical approach used by
    // the official MidnightBalancingAdapter and handles edge cases we were missing.
    const signSegment = (payload: Uint8Array) => unshieldedKeystore.signData(payload);
    const signedRecipe = await wallet.signRecipe(recipe as any, signSegment);
    console.log(`⚡ [balancing] signRecipe done, recipe type=${(signedRecipe as any).type}`);

    const finalizedTx = await wallet.finalizeRecipe(signedRecipe as any);
    console.log(`⚡ [balancing] finalizeRecipe done`);

    // Log the actual transaction hash (for indexer lookup) vs the submission ID
    let derivedTxHash: string | null = null;
    try {
      derivedTxHash = (finalizedTx as any).transactionHash?.()?.toString?.() ?? null;
      if (derivedTxHash) console.log(`⚡ [balancing] derived txHash=${derivedTxHash}`);
    } catch { /* ignore */ }

    const submittedTxId = await wallet.submitTransaction(finalizedTx);
    const txHash = derivedTxHash ?? submittedTxId?.toString();
    console.log(`✅ [balancing] circuit=${data.circuitId} submittedId=${submittedTxId} txHash=${txHash}`);

    // Notify backend of setup completion so the other player can proceed immediately
    // (don't wait for on-chain confirmation — submission is sufficient for coordination)
    if (data.lobbyId && data.playerId && (data.circuitId === "applyMask" || data.circuitId === "dealCards")) {
      const action = data.circuitId === "applyMask" ? "mask_applied" : "dealt_complete";
      fetch(`${backendApiUrl}/api/midnight/notify_setup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lobby_id: data.lobbyId, player_id: data.playerId, action }),
      }).then(r => {
        if (r.ok) console.log(`✅ [balancing] notify_setup: ${action} lobby=${data.lobbyId} player=${data.playerId}`);
        else console.warn(`⚠️ [balancing] notify_setup failed: ${r.status}`);
      }).catch(err => console.warn(`⚠️ [balancing] notify_setup error:`, err));
    }

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

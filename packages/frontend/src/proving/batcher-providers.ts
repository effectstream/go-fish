/**
 * Batcher Providers - Midnight transaction handling without Lace wallet
 *
 * This module provides a wallet-less mode for Midnight transactions.
 * Instead of requiring users to connect their Lace wallet:
 * - ZK proofs are generated locally in a web worker
 * - Transactions are submitted to a batcher service
 * - The batcher handles balancing and submitting to the chain
 *
 * This enables a seamless user experience where users don't need
 * to install or configure any wallet extensions.
 *
 * Updated for SDK v3 with ledger-v7 types.
 */

import { levelPrivateStateProvider } from "@midnight-ntwrk/midnight-js-level-private-state-provider";
import { FetchZkConfigProvider } from "@midnight-ntwrk/midnight-js-fetch-zk-config-provider";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import {
  type ProofProvider,
  type UnboundTransaction,
  type ProveTxConfig,
} from "@midnight-ntwrk/midnight-js-types";
import {
  Transaction,
  type TransactionId,
  type UnprovenTransaction,
  type FinalizedTransaction,
  type CoinPublicKey,
  type EncPublicKey,
} from "@midnight-ntwrk/ledger-v7";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import type { ProverMessage, ProverResponse } from "./worker-types";
import type { GoFishProviders } from "../services/MidnightOnChainService";

type WebWorkerPromiseCallbacks = {
  resolve: (
    value: UnboundTransaction | PromiseLike<UnboundTransaction>
  ) => void;
  reject: (reason?: unknown) => void;
};

/**
 * Web Worker based proof provider that generates ZK proofs locally
 * Updated for SDK v3 - returns UnboundTransaction
 */
class WebWorkerLocalProofServer implements ProofProvider {
  nextId: number;
  requests: Map<number, WebWorkerPromiseCallbacks>;
  worker: Worker | undefined;

  constructor() {
    this.nextId = 0;
    this.requests = new Map();

    if (window.Worker) {
      console.log("[BatcherProviders] Creating web worker for ZK proofs");
      this.worker = new Worker(
        new URL("./prover-worker.ts", import.meta.url),
        { type: "module" }
      );
    }
  }

  async setupResponseHandler() {
    this.worker!.onmessage = (event: MessageEvent<ProverResponse>) => {
      const { type, data, message, requestId } = event.data;

      const callbacks = this.requests.get(requestId!);
      switch (type) {
        case "log":
          console.log("[ProverWorker]", message);
          break;
        case "success":
          if (callbacks && data) {
            // Deserialize using ledger-v7 (no network ID needed - set globally)
            const provenTx = Transaction.deserialize(data);
            callbacks.resolve(provenTx as UnboundTransaction);
            this.requests.delete(requestId!);
          }
          break;
        case "error":
          console.error("[ProverWorker] Error:", message);
          callbacks?.reject(new Error(message));
          break;
      }
    };

    this.worker!.onerror = (error) => {
      console.error(
        `[BatcherProviders] Web worker error: ${error.message}`,
        error
      );
    };
  }

  async initializeWorker<K extends string>() {
    const baseUrl = new URL(window.location.href).toString();
    console.log(`[BatcherProviders] Initializing worker with baseUrl: ${baseUrl}`);

    let readyResolve: (value: void) => void;
    let paramsResolve: (value: void) => void;

    const wasmReady = new Promise<void>((resolve, _reject) => {
      readyResolve = resolve;
    });
    const paramsReady = new Promise<void>((resolve, _reject) => {
      paramsResolve = resolve;
    });

    this.worker!.onmessage = (event: MessageEvent<ProverResponse>) => {
      const { type, message } = event.data;

      switch (type) {
        case "wasm-ready":
          readyResolve();
          break;
        case "params-ready":
          paramsResolve();
          break;
        case "log":
          console.log("[ProverWorker]", message);
          break;
      }
    };

    await wasmReady;

    this.worker!.postMessage({
      type: "params",
      baseUrl,
    } as ProverMessage);

    await paramsReady;

    console.log("[BatcherProviders] Worker initialized and ready for proving");
  }

  async proveTx(
    tx: UnprovenTransaction,
    proveTxConfig?: ProveTxConfig
  ): Promise<UnboundTransaction> {
    if (this.worker !== undefined) {
      return new Promise((resolve, reject) => {
        this.requests.set(this.nextId, { resolve, reject });

        // Serialize using ledger-v7 (no network ID needed - set globally)
        const serializedTx = tx.serialize();

        this.worker!.postMessage({
          type: "prove",
          serializedTx,
          proveTxConfig,
          requestId: this.nextId,
        } as ProverMessage<GoFishCircuitKeys>);

        ++this.nextId;
      });
    } else {
      return new Promise((_resolve, reject) => {
        reject(new Error("Web worker not initialized"));
      });
    }
  }
}

/**
 * Get the batcher's address (coinPublicKey|encryptionPublicKey)
 */
async function getBatcherAddress(): Promise<string> {
  const batcherUrl = `${import.meta.env.VITE_BATCHER_URL}/address`;

  console.log(`[BatcherProviders] Fetching batcher address from ${batcherUrl}`);

  const batcherResponse = await withRetries(10, () =>
    fetch(batcherUrl, {
      method: "GET",
      headers: {
        "Content-Type": "application/text",
      },
    })
  );

  if (batcherResponse.status >= 300) {
    throw new Error("Failed to get batcher's address");
  }

  const address = await batcherResponse.text();
  console.log("[BatcherProviders] Got batcher address");
  return address;
}

/**
 * Convert Uint8Array to hex string
 */
function uint8ArrayToHex(uint8Array: Uint8Array): string {
  return Array.from(uint8Array, (byte) =>
    ("0" + (byte & 0xff).toString(16)).slice(-2)
  ).join("");
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Submit a transaction to the batcher
 */
async function postTxToBatcher(
  txBytes: Uint8Array
): Promise<string> {
  const batcherUrl = `${import.meta.env.VITE_BATCHER_URL}/submitTx`;

  console.log(`[BatcherProviders] Submitting transaction to batcher at ${batcherUrl}`);

  const batcherResponse = await withRetries(10, () =>
    fetch(batcherUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ tx: uint8ArrayToHex(txBytes) }),
    })
  );

  if (batcherResponse.status >= 300) {
    const errorText = await batcherResponse.text();
    console.error("[BatcherProviders] Batcher error:", errorText);
    throw new Error(`Failed to post transaction: ${errorText}`);
  }

  const json = await batcherResponse.json();
  console.log("[BatcherProviders] Transaction submitted successfully:", json.identifiers?.[0]);

  return json.identifiers[0] as string;
}

/**
 * Retry a fetch operation with exponential backoff
 */
async function withRetries(
  retries: number,
  query: () => Promise<Response>
): Promise<Response> {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await query();

      // 503 -> service not available (batcher syncing or no UTXOs)
      if (response.status !== 503) {
        return response;
      }

      console.log(`[BatcherProviders] Batcher returned 503, retrying in 10s (attempt ${i + 1}/${retries})`);
    } catch (error) {
      console.log(`[BatcherProviders] Fetch failed, retrying in 10s (attempt ${i + 1}/${retries}):`, error);
    }

    await sleep(10000);
  }

  throw new Error("Batcher not available after maximum retries");
}

/**
 * Check if batcher mode is enabled via environment variable
 */
export function isBatcherModeEnabled(): boolean {
  return import.meta.env.VITE_BATCHER_MODE_ENABLED === "true";
}

/**
 * Initialize providers for batcher mode (no Lace wallet required)
 */
export async function initializeBatcherProviders(): Promise<GoFishProviders> {
  console.log("[BatcherProviders] Initializing batcher mode providers...");

  // Set the network ID - required before any SDK operations
  // Using Undeployed for local dev chain
  setNetworkId("undeployed");
  console.log("[BatcherProviders] Network ID set to undeployed");

  const batcherAddress = await getBatcherAddress();
  const batcherAddressParts = batcherAddress.split("|");

  if (batcherAddressParts.length !== 2) {
    throw new Error(`Invalid batcher address format: ${batcherAddress}`);
  }

  const [coinPublicKey, encryptionPublicKey] = batcherAddressParts;

  // Initialize web worker for local proof generation
  const webWorkerProofProvider = new WebWorkerLocalProofServer();
  await webWorkerProofProvider.initializeWorker();
  await webWorkerProofProvider.setupResponseHandler();

  const indexerHttpUrl = import.meta.env.VITE_INDEXER_HTTP_URL || "http://127.0.0.1:8088/api/v1/graphql";
  const indexerWsUrl = import.meta.env.VITE_INDEXER_WS_URL || "ws://127.0.0.1:8088/api/v1/graphql/ws";

  console.log("[BatcherProviders] Using indexer:", indexerHttpUrl);

  return {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: "go-fish-private-state",
      privateStoragePasswordProvider: async () => "PAIMA_STORAGE_PASSWORD",
      accountId: coinPublicKey,
    }),
    zkConfigProvider: new FetchZkConfigProvider(
      window.location.origin,
      fetch.bind(window)
    ),
    proofProvider: webWorkerProofProvider,
    publicDataProvider: indexerPublicDataProvider(
      indexerHttpUrl,
      indexerWsUrl
    ),
    walletProvider: {
      // Use the batcher's address since we don't have a wallet
      getCoinPublicKey(): CoinPublicKey {
        return coinPublicKey as unknown as CoinPublicKey;
      },
      getEncryptionPublicKey(): EncPublicKey {
        return encryptionPublicKey as unknown as EncPublicKey;
      },
      balanceTx(
        tx: UnboundTransaction,
        _ttl?: Date
      ): Promise<FinalizedTransaction> {
        // In batcher mode, the batcher handles balancing
        // Pass through the unbound transaction as-is
        return Promise.resolve(tx as unknown as FinalizedTransaction);
      },
    },
    midnightProvider: {
      submitTx(tx: FinalizedTransaction): Promise<TransactionId> {
        // Serialize using ledger-v7 (no network ID needed - set globally)
        const raw = tx.serialize();
        return postTxToBatcher(raw);
      },
    },
  };
}

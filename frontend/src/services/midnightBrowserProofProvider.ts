// Transaction from ledger-v8 is used because @paima/midnight-wasm-prover produces
// ledger-v8-format proofs. The entire stack now uses ledger-v8.
import { Transaction } from "@midnight-ntwrk/ledger-v8";
import type { ProofProvider, UnboundTransaction } from "@midnight-ntwrk/midnight-js-types";
import type {
  MidnightProverWorkerRequest,
  MidnightProverWorkerResponse,
} from "../workers/midnightProverMessages";

type PendingRequest = {
  resolve: (value: Uint8Array) => void;
  reject: (error: Error) => void;
};

class MidnightBrowserProverClient {
  private readonly worker: Worker;
  private readonly readyPromise: Promise<void>;
  private readyResolved = false;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();

  constructor(baseUrl: string) {
    this.worker = new Worker(
      new URL("../workers/midnightProver.worker.ts", import.meta.url),
      { type: "module" },
    );

    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.worker.onmessage = (
        event: MessageEvent<MidnightProverWorkerResponse>,
      ) => {
        if (event.data.type === "ready") {
          this.readyResolved = true;
          resolve();
          return;
        }

        if (event.data.type === "error") {
          const error = new Error(event.data.message);

          if (event.data.requestId === undefined && !this.readyResolved) {
            reject(error);
            return;
          }

          if (event.data.requestId !== undefined) {
            const pending = this.pending.get(event.data.requestId);
            if (pending) {
              this.pending.delete(event.data.requestId);
              pending.reject(error);
            }
          }

          return;
        }

        const pending = this.pending.get(event.data.requestId);
        if (!pending) return;

        this.pending.delete(event.data.requestId);
        pending.resolve(new Uint8Array(event.data.serializedTx));
      };

      this.worker.onerror = (event) => {
        const error = new Error(event.message || "Browser prover worker failed");
        reject(error);

        for (const [requestId, pending] of this.pending.entries()) {
          this.pending.delete(requestId);
          pending.reject(error);
        }
      };
    });

    this.postMessage({
      type: "init",
      baseUrl,
    });
  }

  async prove(serializedTx: Uint8Array): Promise<Uint8Array> {
    await this.readyPromise;

    const requestId = this.nextRequestId++;
    const view =
      serializedTx instanceof Uint8Array
        ? serializedTx
        : new Uint8Array(serializedTx);
    const txCopy = view.slice();

    return new Promise<Uint8Array>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.postMessage(
        {
          type: "prove",
          requestId,
          serializedTx: txCopy.buffer,
        },
        [txCopy.buffer],
      );
    });
  }

  private postMessage(
    message: MidnightProverWorkerRequest,
    transfer: Transferable[] = [],
  ): void {
    this.worker.postMessage(message, transfer);
  }
}

let browserProverClient: MidnightBrowserProverClient | null = null;
let browserProofProvider: ProofProvider | null = null;

function getBrowserProverClient(): MidnightBrowserProverClient {
  if (!browserProverClient) {
    const baseUrl = new URL(import.meta.env.BASE_URL, window.location.origin)
      .toString();
    browserProverClient = new MidnightBrowserProverClient(baseUrl);
  }

  return browserProverClient;
}

export function getBrowserProofProvider(): ProofProvider {
  if (!browserProofProvider) {
    browserProofProvider = {
      async proveTx(unprovenTx: any): Promise<UnboundTransaction> {
        const provenBytes = await getBrowserProverClient().prove(
          unprovenTx.serialize(),
        );

        return Transaction.deserialize(
          "signature",
          "proof",
          "pre-binding",
          provenBytes,
        ) as unknown as UnboundTransaction;
      },
    } as ProofProvider;
  }

  return browserProofProvider!;
}

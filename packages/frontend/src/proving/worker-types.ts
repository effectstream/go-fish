/**
 * Worker Types for ZK Proof Generation Web Worker
 *
 * These types define the message protocol between the main thread
 * and the web worker that handles ZK proof generation.
 */

import type { ProveTxConfig } from "@midnight-ntwrk/midnight-js-types";

export type ProverMessage<K extends string> =
  | {
      type: "params";
      baseUrl: string;
    }
  | {
      type: "prove";
      serializedTx: Uint8Array;
      proveTxConfig: ProveTxConfig<K>;
      requestId: number;
    };

export interface ProverResponse {
  type: "success" | "error" | "log" | "wasm-ready" | "params-ready";
  data?: Uint8Array;
  message?: string;
  durationMs?: number;
  requestId?: number;
}

/**
 * Prover Web Worker - Handles ZK proof generation in a separate thread
 *
 * This web worker runs WASM-based ZK proof generation off the main thread
 * to prevent blocking the UI during computationally intensive operations.
 */

import init, { initThreadPool } from "@paima/midnight-vm-bindings";
import type { ProverMessage, ProverResponse } from "./worker-types.js";
import { proveTxLocally } from "./local-proving.js";
import type { ProveTxConfig } from "@midnight-ntwrk/midnight-js-types";

// Get the WASM file URL from the static copy location
// Vite copies the WASM to /wasm/ via vite-plugin-static-copy
const wasmUrl = new URL('/wasm/midnight_vm_bindings_bg.wasm', self.location.origin);

// Use the object form to avoid deprecation warning
await init({ module_or_path: wasmUrl });
await initThreadPool(navigator.hardwareConcurrency);

self.postMessage({
  type: "wasm-ready",
  message: "worker pool initialized",
} as ProverResponse);

let baseUrl: string | undefined = undefined;

async function runProver(
  serializedTx: Uint8Array,
  proveTxConfig: ProveTxConfig,
  requestId: number
) {
  try {
    const startTime = performance.now();
    const result = await proveTxLocally(baseUrl!, serializedTx, proveTxConfig);
    const endTime = performance.now();
    const durationMs = Math.round(endTime - startTime);

    self.postMessage({
      type: "success",
      data: result,
      durationMs: durationMs,
      requestId: requestId,
    } as ProverResponse);
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
      requestId: requestId,
    } as ProverResponse);
  }
}

self.onmessage = async (
  event: MessageEvent<ProverMessage>
) => {
  const { type } = event.data;

  if (type === "params") {
    baseUrl = event.data.baseUrl;

    console.log("[ProverWorker] Initializing params with baseUrl:", baseUrl);

    self.postMessage({ type: "params-ready" });
  } else if (type === "prove") {
    const { serializedTx, proveTxConfig, requestId } = event.data;
    await runProver(serializedTx, proveTxConfig, requestId);
  }
};

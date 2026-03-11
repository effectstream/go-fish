import {
  FileStorage,
  type BatcherConfig,
  type DefaultBatcherInput,
} from "@paimaexample/batcher";

const batchIntervalMs = 1000;
const port = Number(Deno.env.get("BATCHER_PORT") ?? "3336");

export const config: BatcherConfig<DefaultBatcherInput> = {
  pollingIntervalMs: batchIntervalMs,
  enableHttpServer: true,
  namespace: "", // Empty for now - namespace affects signature verification
  // "wait-receipt" waits only for on-chain confirmation, not EffectStream sync.
  // "wait-effectstream-processed" times out because the parallelMidnight chain
  // sync events don't fire reliably within the timeout window, causing dealCards
  // and other circuit submissions to be reported as failed even though the tx
  // confirmed on-chain — which breaks notify_setup and askForCard card ownership.
  confirmationLevel: "wait-receipt",
  enableEventSystem: false,
  port,
};

// Batcher data directory - exported so main.ts can clear it on startup
export const BATCHER_DATA_DIR = "./batcher-data";
export const storage = new FileStorage(BATCHER_DATA_DIR);

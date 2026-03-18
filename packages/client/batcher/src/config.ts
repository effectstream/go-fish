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
  // Per-adapter confirmation levels:
  //   effectstreaml2: "wait-receipt" — EVM confirmations are fast (<5s), safe to wait.
  //   go-fish (Midnight): "no-wait" — Midnight circuit proving takes 60–120s, far beyond
  //     the 60s batcher timeout. The frontend polls for state anyway so it doesn't need
  //     a synchronous receipt. Using "wait-receipt" here causes "Receipt confirmation
  //     timeout" errors that spam the log and don't affect correctness.
  confirmationLevel: {
    effectstreaml2: "wait-receipt",
    "go-fish": "no-wait",
  },
  enableEventSystem: false,
  port,
};

// Batcher data directory - exported so main.ts can clear it on startup
export const BATCHER_DATA_DIR = "./batcher-data";
export const storage = new FileStorage(BATCHER_DATA_DIR);

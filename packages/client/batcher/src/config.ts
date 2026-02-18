import {
  FileStorage,
  type BatcherConfig,
  type DefaultBatcherInput,
} from "@paimaexample/batcher";

const batchIntervalMs = 1000;
const port = Number(Deno.env.get("BATCHER_PORT") ?? "3334");

export const config: BatcherConfig<DefaultBatcherInput> = {
  pollingIntervalMs: batchIntervalMs,
  enableHttpServer: true,
  namespace: "", // Empty for now - namespace affects signature verification
  confirmationLevel: "wait-effectstream-processed",
  enableEventSystem: true,
  port,
};

// Batcher data directory - exported so main.ts can clear it on startup
export const BATCHER_DATA_DIR = "./batcher-data";
export const storage = new FileStorage(BATCHER_DATA_DIR);

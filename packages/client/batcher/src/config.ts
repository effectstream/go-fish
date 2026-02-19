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
  namespace: "[go-fish]",
  confirmationLevel: "wait-effectstream-processed",
  enableEventSystem: true,
  port,
};

export const storage = new FileStorage("./batcher-data");

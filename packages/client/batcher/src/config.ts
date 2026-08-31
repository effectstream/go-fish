import {
  FileStorage,
  type BatcherConfig,
  type DefaultBatcherInput,
} from "@effectstream/batcher-sdk";

const batchIntervalMs = 1000;
const port = Number(process.env.BATCHER_PORT ?? "3336");

export const config: BatcherConfig<DefaultBatcherInput> = {
  pollingIntervalMs: batchIntervalMs,
  enableHttpServer: true,
  // Must match the frontend EngineConfig securityNamespace and the node's
  // setSecurityNamespace(...) in packages/shared/data-types/src/config*.ts.
  namespace: "evm-midnight-node",
  confirmationLevel: {
    effectstreaml2: "wait-receipt",
    midnight_balancing: "no-wait",
  },
  enableEventSystem: false,
  port,
};

export const BATCHER_DATA_DIR = "./batcher-data";
export const storage = new FileStorage(BATCHER_DATA_DIR);

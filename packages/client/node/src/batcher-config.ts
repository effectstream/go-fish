import { readFileSync } from "node:fs";

function detectBatcherMode(): boolean {
  const envValue = process.env.USE_BATCHER_MODE;
  if (envValue === "true") {
    console.log("[BatcherConfig] Batcher mode enabled via USE_BATCHER_MODE env");
    return true;
  }
  try {
    const configPath = new URL("../runtime-config.json", import.meta.url);
    const configText = readFileSync(configPath, "utf-8");
    const config = JSON.parse(configText);
    if (config.useBatcherMode === true) {
      console.log("[BatcherConfig] Batcher mode enabled via runtime-config.json");
      return true;
    }
  } catch {
    // Config file absent — not batcher mode
  }
  return false;
}

/** True when the node is running in batcher (on-chain) mode. Evaluated once at module load. */
export const USE_BATCHER_MODE: boolean = detectBatcherMode();

/** Minimum gap between consecutive Midnight operations (ms). */
export const MIN_OPERATION_GAP_MS = 200;

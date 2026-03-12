/**
 * Batcher mode configuration — single source of truth.
 * Both midnight-query.ts and midnight-actions.ts import from here
 * instead of each re-implementing the same env-var + config-file logic.
 */

function detectBatcherMode(): boolean {
  const envValue = Deno.env.get("USE_BATCHER_MODE");
  if (envValue === "true") {
    console.log("[BatcherConfig] Batcher mode enabled via USE_BATCHER_MODE env");
    return true;
  }
  try {
    const configPath = new URL("../runtime-config.json", import.meta.url);
    const configText = Deno.readTextFileSync(configPath);
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

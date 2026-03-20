/**
 * WASM Proof Provider
 *
 * Runs ZK proof generation locally in the browser using the Midnight WASM prover,
 * eliminating the need for an external proof server.
 *
 * This is the default proving mode for production because the Lace wallet does not
 * ship with a built-in proof server.
 *
 * Architecture:
 *   WasmProverImpl (wallet-sdk-prover-client)
 *     └─ spawns a Web Worker (proof-worker.js, bundled by wallet-sdk-prover-client)
 *         ├─ lookupKey(keyLocation)
 *         │    ├─ zswap/dust keys  → Midnight S3 (makeDefaultKeyMaterialProvider)
 *         │    └─ game circuit keys → frontend origin via FetchZkConfigProvider
 *         └─ getParams(k) → Midnight S3 (makeDefaultKeyMaterialProvider)
 *
 * Key material URLs served by Vite's static-copy plugin at build time:
 *   /keys/{circuitId}.prover
 *   /keys/{circuitId}.verifier
 *   /zkir/{circuitId}.bzkir
 */

import { CostModel } from "@midnight-ntwrk/ledger-v7";
import { FetchZkConfigProvider } from "@midnight-ntwrk/midnight-js-fetch-zk-config-provider";
import { zkConfigToProvingKeyMaterial } from "@midnight-ntwrk/midnight-js-types";
import type { ProofProvider } from "@midnight-ntwrk/midnight-js-types";
import { WasmProver } from "@midnight-ntwrk/wallet-sdk-prover-client/effect";
import { Effect } from "effect";

const { makeDefaultKeyMaterialProvider } = WasmProver;

/**
 * The set of well-known zswap/dust key locations handled by makeDefaultKeyMaterialProvider.
 * Any other lookupKey call is assumed to be a game circuit ID.
 */
const WALLET_KEY_LOCATIONS = new Set([
  "midnight/zswap/spend",
  "midnight/zswap/output",
  "midnight/zswap/sign",
  "midnight/dust/spend",
]);

/**
 * Build a combined key material provider that routes:
 *   - zswap/dust keys → Midnight S3 (default provider)
 *   - game circuit keys → FetchZkConfigProvider served from the frontend origin
 *
 * Both sources cache their results to avoid redundant network fetches.
 */
function buildCombinedKeyMaterialProvider(zkConfigProvider: FetchZkConfigProvider<string>) {
  const defaultProvider = makeDefaultKeyMaterialProvider();
  const circuitCache = new Map<string, { proverKey: Uint8Array; verifierKey: Uint8Array; ir: Uint8Array } | undefined>();

  return {
    lookupKey: async (keyLocation: string) => {
      // Wallet-level keys (zswap / dust) → S3
      if (WALLET_KEY_LOCATIONS.has(keyLocation)) {
        return defaultProvider.lookupKey(keyLocation);
      }

      // Game circuit keys → frontend origin via FetchZkConfigProvider
      if (circuitCache.has(keyLocation)) {
        return circuitCache.get(keyLocation);
      }

      try {
        const zkConfig = await zkConfigProvider.get(keyLocation);
        const material = zkConfigToProvingKeyMaterial(zkConfig);
        const result = {
          proverKey: new Uint8Array(material.proverKey),
          verifierKey: new Uint8Array(material.verifierKey),
          ir: new Uint8Array(material.ir),
        };
        circuitCache.set(keyLocation, result);
        return result;
      } catch (err) {
        console.warn(`[WasmProofProvider] lookupKey(${keyLocation}): not found locally, falling back to S3`, err);
        const result = await defaultProvider.lookupKey(keyLocation);
        circuitCache.set(keyLocation, result);
        return result;
      }
    },

    getParams: (k: number) => defaultProvider.getParams(k),
  };
}

/**
 * Create a ProofProvider that runs ZK proofs in-browser via WASM.
 *
 * Drop-in replacement for httpClientProofProvider — implements the same
 * ProofProvider interface: { proveTx(unprovenTx): Promise<ProvenTx> }
 *
 * @param zkConfigProvider A FetchZkConfigProvider pointing at the frontend origin,
 *   used to fetch game circuit key material (prover key, verifier key, ZKIR).
 */
export function createWasmProofProvider(
  zkConfigProvider: FetchZkConfigProvider<string>,
): ProofProvider {
  const keyMaterialProvider = buildCombinedKeyMaterialProvider(zkConfigProvider);
  // WasmProver.create() returns Effect.succeed(new WasmProverImpl(...)).
  // Effect.runSync is safe here because Effect.succeed never suspends.
  const wasmProver = Effect.runSync(WasmProver.create({ keyMaterialProvider }));

  return {
    async proveTx(unprovenTx, _partialConfig) {
      const costModel = CostModel.initialCostModel();
      return Effect.runPromise(wasmProver.proveTransaction(unprovenTx, costModel));
    },
  };
}

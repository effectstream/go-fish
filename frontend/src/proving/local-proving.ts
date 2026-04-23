/**
 * Local Proving - Handles ZK proof generation in the browser
 *
 * Uses @paima/midnight-vm-bindings for WASM-based proof generation.
 * This enables proof generation without requiring a separate proof server.
 */

import type { ProveTxConfig } from "@midnight-ntwrk/midnight-js-types";
import type { NetworkId as JsNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import {
  WasmProver,
  MidnightWasmParamsProvider,
  Rng,
  NetworkId,
  ZkConfig,
} from "@paima/midnight-vm-bindings";
import { ENV } from "../env";

const MIDNIGHT_NETWORK_ID: JsNetworkId = ENV.MIDNIGHT_NETWORK_ID;

export async function proveTxLocally(
  baseUrl: string,
  tx: Uint8Array,
  proveTxConfig?: ProveTxConfig
): Promise<Uint8Array> {
  const pp = MidnightWasmParamsProvider.new(baseUrl);

  const prover = WasmProver.new();
  const rng = Rng.new();

  const networkId = MIDNIGHT_NETWORK_ID;

  const zkConfig = (() => {
    const cfg = proveTxConfig as any;
    if (cfg?.zkConfig) {
      return ZkConfig.new(
        cfg.zkConfig.circuitId!,
        cfg.zkConfig.proverKey!,
        cfg.zkConfig.verifierKey!,
        cfg.zkConfig.zkir!
      );
    } else {
      return ZkConfig.empty();
    }
  })();

  console.log(
    `[LocalProving] Starting ZK proof [${navigator.hardwareConcurrency} threads]`
  );

  const startTime = performance.now();

  // In SDK v3, prove_tx returns a proven transaction (with ZK proofs attached)
  let provenTxRaw = await prover.prove_tx(
    rng,
    tx,
    networkId === "undeployed"
      ? NetworkId.undeployed()
      : NetworkId.testnet(),
    zkConfig,
    pp
  );

  const endTime = performance.now();
  console.log(
    `[LocalProving] Proved tx in: ${Math.floor(endTime - startTime)} ms`
  );

  return provenTxRaw;
}

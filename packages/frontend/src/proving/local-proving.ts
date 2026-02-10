/**
 * Local Proving - Handles ZK proof generation in the browser
 *
 * Uses @paima/midnight-vm-bindings for WASM-based proof generation.
 * This enables proof generation without requiring a separate proof server.
 */

import type { ProveTxConfig } from "@midnight-ntwrk/midnight-js-types";
import { NetworkId as JsNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import {
  WasmProver,
  MidnightWasmParamsProvider,
  Rng,
  NetworkId,
  ZkConfig,
} from "@paima/midnight-vm-bindings";

// Network ID constant (matching MidnightOnChainService)
const MIDNIGHT_NETWORK_ID = JsNetworkId.Undeployed;

export async function proveTxLocally<K extends string>(
  baseUrl: string,
  tx: Uint8Array,
  proveTxConfig?: ProveTxConfig<K>
): Promise<Uint8Array> {
  const pp = MidnightWasmParamsProvider.new(baseUrl);

  const prover = WasmProver.new();
  const rng = Rng.new();

  const networkId = MIDNIGHT_NETWORK_ID;

  const zkConfig = (() => {
    if (proveTxConfig) {
      return ZkConfig.new(
        proveTxConfig.zkConfig?.circuitId!,
        proveTxConfig.zkConfig?.proverKey!,
        proveTxConfig.zkConfig?.verifierKey!,
        proveTxConfig.zkConfig?.zkir!
      );
    } else {
      return ZkConfig.empty();
    }
  })();

  console.log(
    `[LocalProving] Starting ZK proof [${navigator.hardwareConcurrency} threads]`
  );

  const startTime = performance.now();

  let unbalancedTxRaw = await prover.prove_tx(
    rng,
    tx,
    networkId === JsNetworkId.Undeployed
      ? NetworkId.undeployed()
      : NetworkId.testnet(),
    zkConfig,
    pp
  );

  const endTime = performance.now();
  console.log(
    `[LocalProving] Proved unbalanced tx in: ${Math.floor(endTime - startTime)} ms`
  );

  return unbalancedTxRaw;
}

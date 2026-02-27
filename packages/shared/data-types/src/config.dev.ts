/**
 * Development configuration for Paima Engine
 * Uses NTP for main timing and EVM for game inputs
 */

import {
  ConfigBuilder,
  ConfigNetworkType,
  ConfigSyncProtocolType,
} from "@paimaexample/config";
import { PrimitiveTypeEVMPaimaL2 } from "@paimaexample/sm/builtin";
import { hardhat } from "viem/chains";
import { grammar } from "@go-fish/data-types/grammar";

const mainSyncProtocolName = "mainNtp";

// Read paimaL2StartBlock from runtime-config.json (written by orchestrator at startup)
// This is needed because env vars don't always propagate through the Effectstream orchestrator
function getPaimaL2StartBlock(): number {
  // Env var takes precedence if present
  const fromEnv = Deno.env.get("PAIMA_L2_START_BLOCK");
  if (fromEnv) return Number(fromEnv);
  try {
    const configPath = new URL("../../client/node/runtime-config.json", import.meta.url);
    const raw = Deno.readTextFileSync(configPath);
    const parsed = JSON.parse(raw);
    if (typeof parsed.paimaL2StartBlock === "number") {
      console.log(`[config.dev] paimaL2StartBlock=${parsed.paimaL2StartBlock} (from runtime-config.json)`);
      return parsed.paimaL2StartBlock;
    }
  } catch {
    // File not found or invalid - use default
  }
  return 0;
}

export const config = new ConfigBuilder()
  .setNamespace((builder) => builder.setSecurityNamespace("[go-fish]"))
  .buildNetworks((builder) =>
    builder
      .addNetwork({
        name: "ntp",
        type: ConfigNetworkType.NTP,
        startTime: new Date().getTime(),
        blockTimeMS: 1000,
      })
      .addViemNetwork({
        ...hardhat,
        name: "evmMain",
      })
  )
  .buildDeployments((builder) => builder)
  .buildSyncProtocols((builder) =>
    builder
      .addMain(
        (networks) => networks.ntp,
        (network, deployments) => ({
          name: mainSyncProtocolName,
          type: ConfigSyncProtocolType.NTP_MAIN,
          chainUri: "",
          startBlockHeight: 1,
          // Increased to 5000ms to allow CPU-intensive Midnight WASM operations
          // to complete without blocking sync processes
          pollingInterval: 5000,
        })
      )
      .addParallel(
        (networks) => networks.evmMain,
        (network, deployments) => ({
          name: "mainEvmRPC",
          type: ConfigSyncProtocolType.EVM_RPC_PARALLEL,
          chainUri: network.rpcUrls.default.http[0],
          startBlockHeight: 1,
          // Increased to 5000ms to reduce mutex contention
          // Midnight circuit operations are CPU-intensive and block the event loop
          // This gives sync processes time to complete between operations
          pollingInterval: 5000,
          confirmationDepth: 1,
        })
      )
  )
  .buildPrimitives((builder) =>
    builder.addPrimitive(
      (syncProtocols) => syncProtocols.mainEvmRPC,
      (network, deployments, syncProtocol) => ({
        name: "GoFish_PaimaL2",
        type: PrimitiveTypeEVMPaimaL2,
        startBlockHeight: getPaimaL2StartBlock(),
        contractAddress: Deno.env.get("PAIMA_L2_CONTRACT_ADDRESS") || "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
        paimaL2Grammar: grammar,
      })
    )
  )
  .build();

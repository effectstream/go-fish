/**
 * Development configuration for Paima Engine
 * Uses NTP for main timing and EVM for game inputs
 */

import {
  ConfigBuilder,
  ConfigNetworkType,
  ConfigSyncProtocolType,
} from "@paimaexample/config";
import {
  PrimitiveTypeEVMPaimaL2,
  PrimitiveTypeMidnightGeneric,
} from "@paimaexample/sm/builtin";
import { hardhat } from "viem/chains";
import * as path from "@std/path";
import { grammar } from "@go-fish/data-types/grammar";
import { contractAddressesEvmMain } from "@go-fish/evm-contracts";
import { readMidnightContract } from "@paimaexample/midnight-contracts/read-contract";
import { midnightNetworkConfig } from "@paimaexample/midnight-contracts/midnight-env";
import { parseGoFishLedger } from "./ledger-parser.ts";

const mainSyncProtocolName = "mainNtp";

const chainNameId = "chain31337" as keyof typeof contractAddressesEvmMain;

// PaimaL2Contract address from deployment
const paimaL2Address = contractAddressesEvmMain()[chainNameId]["GoFishModule#PaimaL2Contract"] as `0x${string}`;
if (!paimaL2Address) {
  throw new Error("EffectstreamL2 address not found");
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
      .addNetwork({
        name: "midnight",
        type: ConfigNetworkType.MIDNIGHT,
        networkId: midnightNetworkConfig.id,
        nodeUrl: midnightNetworkConfig.node,
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
          pollingInterval: 1000,
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
          pollingInterval: 1000,
          confirmationDepth: 1,
        })
      )
      .addParallel(
        (networks) => networks.midnight,
        (network, deployments) => ({
          name: "parallelMidnight",
          type: ConfigSyncProtocolType.MIDNIGHT_PARALLEL,
          startBlockHeight: 1,
          pollingInterval: 1000,
          indexer: midnightNetworkConfig.indexer,
          indexerWs: midnightNetworkConfig.indexerWS,
        })
      )
  )
  .buildPrimitives((builder) =>
    builder
      .addPrimitive(
        (syncProtocols) => syncProtocols.mainEvmRPC,
        (network, deployments, syncProtocol) => ({
          name: "GoFish_PaimaL2",
          type: PrimitiveTypeEVMPaimaL2,
          startBlockHeight: 0,
          contractAddress: paimaL2Address,
          paimaL2Grammar: grammar,
        })
      )
      .addPrimitive(
        (syncProtocols) => syncProtocols.parallelMidnight,
        (network, deployments, syncProtocol) => ({
          name: "GoFish_MidnightEvents",
          type: PrimitiveTypeMidnightGeneric,
          startBlockHeight: 1,
          contractAddress: readMidnightContract(
            "go-fish-contract",
            {
              baseDir: path.resolve(
                import.meta.dirname!,
                "..", "..", "contracts", "midnight",
              ),
              networkId: midnightNetworkConfig.id,
            },
          ).contractAddress,
          stateMachinePrefix: "event_midnight",
          contract: { ledger: parseGoFishLedger },
          networkId: midnightNetworkConfig.id,
        })
      )
  )
  .build();

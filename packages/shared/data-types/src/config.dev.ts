/**
 * Development configuration for Effectstream
 * Uses NTP for main timing and EVM for game inputs
 */

import {
  ConfigBuilder,
  ConfigNetworkType,
  ConfigSyncProtocolType,
} from "@effectstream/config";
import * as builtin from "@effectstream/sm/builtin";
import { hardhat } from "viem/chains";
import * as path from "node:path";
import { contractAddressesEvmMain } from "@go-fish/evm-contracts";
import { readMidnightContract } from "@effectstream/midnight-contracts/read-contract";
import { midnightNetworkConfig } from "@effectstream/midnight-contracts/midnight-env";
import { parseGoFishLedger } from "./ledger-parser.ts";

const mainSyncProtocolName = "mainNtp";
const chainNameId = "chain31337" as keyof ReturnType<typeof contractAddressesEvmMain>;

const effectstreamL2Address = contractAddressesEvmMain()[chainNameId][
  "effectstreaml2Module#effectstreaml2"
] as `0x${string}`;
if (!effectstreamL2Address) {
  throw new Error("EffectstreamL2 address not found");
}

export const config = new ConfigBuilder()
  .setNamespace((builder) => builder.setSecurityNamespace("evm-midnight-node"))
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
          pollingInterval: 1000,
          confirmationDepth: 1,
          stepSize: 30,
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
          name: "GoFish_EffectstreamL2",
          type: builtin.PrimitiveTypeEVMEffectstreamL2,
          startBlockHeight: 0,
          contractAddress: effectstreamL2Address,
          stateMachinePrefix: "event_evm_effectstreaml2",
        })
      )
      .addPrimitive(
        (syncProtocols) => syncProtocols.parallelMidnight,
        (network, deployments, syncProtocol) => ({
          name: "GoFish_MidnightEvents",
          type: builtin.PrimitiveTypeMidnightGeneric,
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

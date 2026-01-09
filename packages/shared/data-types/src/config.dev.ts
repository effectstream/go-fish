/**
 * Development configuration for Paima Engine
 * Simple NTP-only config for initial development
 */

import {
  ConfigBuilder,
  ConfigNetworkType,
  ConfigSyncProtocolType,
} from "@paimaexample/config";

const mainSyncProtocolName = "mainNtp";

export const config = new ConfigBuilder()
  .setNamespace((builder) => builder.setSecurityNamespace("[werewolf]"))
  .buildNetworks((builder) =>
    builder
      .addNetwork({
        name: "ntp",
        type: ConfigNetworkType.NTP,
        startTime: new Date().getTime(),
        blockTimeMS: 1000,
      })
  )
  .buildDeployments(builder => builder)
  .buildSyncProtocols((builder) =>
    builder
      .addMain(
        (networks) => networks.ntp,
        (network, deployments) => ({
          name: mainSyncProtocolName,
          type: ConfigSyncProtocolType.NTP_MAIN,
          chainUri: "",
          startBlockHeight: 1,
          pollingInterval: 500,
        })
      )
  )
  .buildPrimitives((builder) => builder)
  .build();

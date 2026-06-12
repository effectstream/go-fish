import type { HardhatUserConfig } from "hardhat/config";
import {
  createHardhatConfig,
  createNodeTasks,
  initTelemetry,
} from "@effectstream/evm-hardhat/hardhat-config-builder";
import {
  JsonRpcServerImplementation,
} from "@effectstream/evm-hardhat/json-rpc-server";
import fs from "node:fs";
import waitOn from "wait-on";
import {
  ComponentNames,
  log,
  SeverityNumber,
} from "@effectstream/log";

const __dirname: any = import.meta.dirname;

initTelemetry("@effectstream/log", "./package.json");

const nodeTasks = createNodeTasks({
  JsonRpcServer: {} as unknown as never,
  JsonRpcServerImplementation,
  ComponentNames,
  log,
  SeverityNumber,
  waitOn,
  fs,
});

const evmMainPort = 8545;
const evmMainChainId = 31337;
const evmMainInterval = 1000;

const ZERO_KEY =
  "0x0000000000000000000000000000000000000000000000000000000000000000";
const withHexPrefix = (k?: string) =>
  !k ? undefined : k.startsWith("0x") ? k : `0x${k}`;
const deployKey =
  withHexPrefix(
    process.env.DEPLOYER_PRIVATE_KEY ?? process.env.BATCHER_EVM_SECRET_KEY,
  ) ?? ZERO_KEY;
const arbitrumUrl =
  process.env.ARBITRUM_ONE_FULL ??
  process.env.ARBITRUM_ONE_RPC_URL ??
  "https://arb-mainnet.g.alchemy.com/v2/API-KEY";

const config: HardhatUserConfig = createHardhatConfig({
  sourcesDir: `${__dirname}/contracts`,
  artifactsDir: `${__dirname}/build/artifacts/hardhat`,
  cacheDir: `${__dirname}/build/cache/hardhat`,
  tasks: nodeTasks,
  solidityVersion: "0.8.27",
  networks: {
    arbitrum: {
      type: "http",
      chainId: 42161,
      url: arbitrumUrl,
      accounts: [deployKey],
    },
    evmMain: {
      type: "edr-simulated",
      chainType: "l1",
      chainId: evmMainChainId,
      mining: {
        auto: true,
        interval: evmMainInterval,
      },
      allowBlocksWithSameTimestamp: true,
    },
    evmMainHttp: {
      type: "http",
      chainType: "l1",
      url: `http://0.0.0.0:${evmMainPort}`,
    },
  },
});

export default config;

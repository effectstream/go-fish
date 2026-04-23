import type { HardhatUserConfig } from "hardhat/config";
import {
  createHardhatConfig,
  createNodeTasks,
  initTelemetry,
} from "@paimaexample/evm-hardhat/hardhat-config-builder";
import {
  JsonRpcServerImplementation,
} from "@paimaexample/evm-hardhat/json-rpc-server";
import fs from "node:fs";
import waitOn from "wait-on";
import {
  ComponentNames,
  log,
  SeverityNumber,
} from "@paimaexample/log";

const __dirname: any = import.meta.dirname;

// Initialize telemetry
initTelemetry("@paimaexample/log", "./deno.json");

// Create node tasks
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

// Create unified config with default networks
const config: HardhatUserConfig = createHardhatConfig({
  sourcesDir: `${__dirname}/contracts`,
  artifactsDir: `${__dirname}/build/artifacts/hardhat`,
  cacheDir: `${__dirname}/build/cache/hardhat`,
  tasks: nodeTasks,
  solidityVersion: "0.8.27",
  networks: {
    // This is needed to set once, to deploy contracts in mainet:
    // deno task -f @go-fish/evm-contracts deploy:mainnet
    // deno task -f @go-fish/evm-contracts build:mod

    arbitrum: {
      type: 'http',
      chainId: 42161,
      url: 'https://arb-mainnet.g.alchemy.com/v2/API-KEY',
      accounts: ['0000000000000000000000000000000000000000000000000000000000000000'],
    },

    // These are development networks.
    evmMain: {
      type: "edr-simulated",
      chainType: "l1",
      chainId: evmMainChainId,
      mining: {
        auto: true,
        interval: evmMainInterval, // Arbitrum (250ms)
      },
      allowBlocksWithSameTimestamp: true,
    },
    // This is a helper network to allow to hardhat/ignition to connect to the network.
    evmMainHttp: {
      type: "http",
      chainType: "l1",
      url: `http://0.0.0.0:${evmMainPort}`,
    },
  }
});

export default config;

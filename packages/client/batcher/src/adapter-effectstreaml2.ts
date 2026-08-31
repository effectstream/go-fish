import { EffectstreamL2DefaultAdapter } from "@effectstream/batcher-sdk";
import * as chains from "viem/chains";
import { contractAddressesEvmMain } from "@go-fish/evm-contracts";
import { getEnv } from "@effectstream/utils";
import type { Chain } from "viem";

const isMainnet = getEnv("EFFECTSTREAM_ENV") === "mainnet";
const isPreprod = getEnv("EFFECTSTREAM_ENV") === "preprod";
const isUndeployed = getEnv("EFFECTSTREAM_ENV") === "dev";

let chainNameId: keyof ReturnType<typeof contractAddressesEvmMain>;
if (isMainnet) {
  chainNameId = "chain42161";
} else if (isPreprod) {
  chainNameId = "chain421614";
} else if (isUndeployed) {
  chainNameId = "chain31337";
} else {
  throw new Error("Invalid effectstream environment");
}

const effectstreamL2Address = contractAddressesEvmMain()[chainNameId][
  "effectstreaml2Module#effectstreaml2"
] as `0x${string}`;
if (!effectstreamL2Address) {
  throw new Error("EffectstreamL2 address not found");
}

const batcherPrivateKey = (process.env.BATCHER_EVM_SECRET_KEY ??
  process.env.BATCHER_PRIVATE_KEY ??
  (isUndeployed && "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80")) as `0x${string}`;
if (!batcherPrivateKey) {
  throw new Error("BATCHER_EVM_SECRET_KEY not set");
}

const effectstreamL2Fee = 0n;
const syncProtocolName = "mainEvmRPC";

const evmRpcUrl = process.env.ARBITRUM_ONE_FULL ||
  (isUndeployed && "http://localhost:8545");
if (!evmRpcUrl) {
  throw new Error("ARBITRUM_ONE_FULL is unset");
}

let chain: Chain;
if (isPreprod) {
  chain = chains.arbitrumSepolia;
} else if (isUndeployed) {
  chain = chains.hardhat;
} else {
  chain = chains.arbitrum;
}

export const effectstreaml2Adapter = new EffectstreamL2DefaultAdapter(
  effectstreamL2Address,
  batcherPrivateKey,
  effectstreamL2Fee,
  syncProtocolName,
  { ...chain, rpcUrls: { default: { http: [evmRpcUrl] } } },
);

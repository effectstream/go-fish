import { PaimaL2DefaultAdapter } from "@paimaexample/batcher";
import * as chains from "viem/chains";
import { contractAddressesEvmMain } from "@go-fish/evm-contracts"
import { getEnv } from "@paimaexample/utils";


const isMainnet = getEnv("EFFECTSTREAM_ENV") === "mainnet";
const isPreprod = getEnv("EFFECTSTREAM_ENV") === "preprod";
const isUndeployed = getEnv("EFFECTSTREAM_ENV") === "dev";

let chainNameId: keyof typeof contractAddressesEvmMain;
if (isMainnet) {
  chainNameId = "chain42161" as keyof typeof contractAddressesEvmMain;
} else if (isPreprod) {
  chainNameId = "chain421614" as keyof typeof contractAddressesEvmMain;
} else if (isUndeployed) {
  chainNameId = "chain31337" as keyof typeof contractAddressesEvmMain;
} else {
  throw new Error("Invalid effectstream environment");
}


// PaimaL2Contract address from deployment
const paimaL2Address = contractAddressesEvmMain()[chainNameId]["GoFishModule#PaimaL2Contract"] as `0x${string}`;
if (!paimaL2Address) {
  throw new Error("EffectstreamL2 address not found");
}
// Hardhat account #0 — the batcher's own funded key for submitting batched transactions
const batcherPrivateKey = (Deno.env.get("BATCHER_PRIVATE_KEY") ||
  (isUndeployed && "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80")) as `0x${string}`;
if (!batcherPrivateKey) {
  throw new Error("BATCHER_PRIVATE_KEY not set");
}

const paimaL2Fee = 0n;
const paimaSyncProtocolName = "mainEvmRPC";

const evmRpcUrl = Deno.env.get("ARBITRUM_ONE_FULL") || (isUndeployed && "http://localhost:8545");
if (!evmRpcUrl) {
  throw new Error("ARBITRUM_ONE_FULL is unset");
}

const chain = isMainnet ? chains.arbitrum : chains.hardhat

export const effectstreaml2Adapter = new PaimaL2DefaultAdapter(
  paimaL2Address,
  batcherPrivateKey,
  paimaL2Fee,
  paimaSyncProtocolName,
  { ...(chain), rpcUrls: { default: { http: [evmRpcUrl] } } } as typeof chains.hardhat,
);

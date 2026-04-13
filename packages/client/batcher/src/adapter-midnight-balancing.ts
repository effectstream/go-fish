import {
  type BatcherConfig,
  FileStorage,
  MidnightAdapter,
} from "@paimaexample/batcher";
import { readMidnightContract } from "@paimaexample/midnight-contracts/read-contract";
import { midnightNetworkConfig } from "@paimaexample/midnight-contracts/midnight-env";
import * as path from "@std/path";
// import { MidnightBalancingAdapter } from "./adapters/midnight-balancing-adapter.ts";
import { MidnightBalancingAdapter } from "@paimaexample/batcher";
import process from "node:process";
const batchIntervalMs = 1000;
const port = Number(Deno.env.get("BATCHER_PORT") ?? "3334");
// Try to load contract data (needed for the standard midnight adapter).
// May fail if the contract hasn't been deployed yet (no address JSON file).
let midnightContractData: ReturnType<typeof readMidnightContract> | null = null;
try {
  midnightContractData = readMidnightContract(
    "go-fish-contract",
    { 
      baseDir: path.resolve(import.meta.dirname!, "..", "..", "..", "shared", "contracts", "midnight"),
      networkId: midnightNetworkConfig.id,
    },
  );
} catch (e) {
  console.warn(
    `⚠️  Could not load contract address file: ${(e as Error).message}`,
  );
  console.warn(
    "   The standard midnight adapter will be disabled. " +
      "The midnight_balancing adapter (for delegated tx) will still work.",
  );
  throw e;
}

const zkConfigPath = midnightContractData?.zkConfigPath ??
  path.resolve(
    import.meta.dirname!,
    "..", "..", "..", "shared", "contracts", "midnight", "go-fish-contract", "src", "managed"
  );

// The balancing adapter handles delegated transactions from BatcherClient.
let seeds = process.env.MIDNIGHT_WALLET_SEEDS?.split(',');
if (midnightNetworkConfig.id === 'undeployed') {
  seeds = [midnightNetworkConfig.walletSeed!];
} else {
  if (!seeds || seeds.length === 0) {
    throw new Error('MIDNIGHT_WALLET_SEEDS is not set');
  }
}

export const midnightBalancingAdapter = new MidnightBalancingAdapter(
    seeds,
    {
      syncProtocolName: 'parallelMidnight',
      indexer: midnightNetworkConfig.indexer,
      indexerWS: midnightNetworkConfig.indexerWS,
      node: midnightNetworkConfig.node,
      proofServer: midnightNetworkConfig.proofServer,
      walletNetworkId: midnightNetworkConfig.id,
      walletFundingTimeoutSeconds: 60 * 20,
      addShieldedPadding: false, // true,
    },
  );


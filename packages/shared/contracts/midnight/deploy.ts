/**
 * Deploy Go Fish Contract to Midnight Network
 *
 * This script deploys the Go Fish compact contract to the Midnight blockchain.
 *
 * Usage:
 *   deno task -f @go-fish/midnight-contracts midnight-contract:deploy
 *
 * Prerequisites:
 *   1. Midnight node running (deno task midnight-node:start)
 *   2. Midnight indexer running (deno task midnight-indexer:start)
 *   3. Midnight proof server running (deno task midnight-proof-server:start)
 *   4. Contract compiled (deno task contract:compile)
 */

import { type DeployConfig, deployMidnightContract } from "./deploy-ledger6.ts";
import { midnightNetworkConfig } from "./midnight-env.ts";
import {
  Contract,
  witnesses,
  type PrivateState,
} from "./go-fish-contract/src/_index.ts";

const config: DeployConfig = {
  contractName: "go-fish-contract",
  contractFileName: "go-fish-contract.undeployed.json",
  contractClass: Contract.Contract,
  witnesses,
  privateStateId: "privateState",
  initialPrivateState: {} as PrivateState,
  privateStateStoreName: "private-state",
};

deployMidnightContract(config, midnightNetworkConfig)
  .then(() => {
    console.log("Go Fish contract deployment successful");
    Deno.exit(0);
  })
  .catch((e: unknown) => {
    console.error("Deployment failed:", e);
    Deno.exit(1);
  });

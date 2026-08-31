/**
 * Deploy Go Fish Contract to Midnight Network
 *
 * Usage:
 *   bun run --filter @go-fish/midnight-contracts midnight-contract:deploy
 */

import { type DeployConfig, deployMidnightContract } from "./deploy.midnight.ts";
import { midnightNetworkConfig } from "@effectstream/midnight-contracts/midnight-env";
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
    process.exit(0);
  })
  .catch((e: unknown) => {
    console.error("Deployment failed:", e);
    process.exit(1);
  });

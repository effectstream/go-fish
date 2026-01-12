import { buildModule } from "@nomicfoundation/ignition-core";

/**
 * Deployment module for Go Fish game contracts
 * Deploys both the Paima L2 contract (for game inputs) and the GoFishLobby contract (for lobby management)
 */
const GoFishModule = buildModule("GoFishModule", (m) => {
  const owner = m.getParameter("owner");
  const fee = m.getParameter("fee");

  // Deploy PaimaL2Contract
  const paimaL2Contract = m.contract("PaimaL2Contract", [owner, fee]);

  // Deploy GoFishLobby contract
  const goFishLobby = m.contract("GoFishLobby");

  return { paimaL2Contract, goFishLobby };
});

export default GoFishModule;

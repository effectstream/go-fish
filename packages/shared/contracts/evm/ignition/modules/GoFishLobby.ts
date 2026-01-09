import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const GoFishLobbyModule = buildModule("GoFishLobbyModule", (m) => {
  const goFishLobby = m.contract("GoFishLobby");

  return { goFishLobby };
});

export default GoFishLobbyModule;

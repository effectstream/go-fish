import { expect } from "chai";
import { ethers } from "hardhat";
import { GoFishLobby } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("GoFishLobby", function () {
  let goFishLobby: GoFishLobby;
  let owner: HardhatEthersSigner;
  let player1: HardhatEthersSigner;
  let player2: HardhatEthersSigner;

  beforeEach(async function () {
    [owner, player1, player2] = await ethers.getSigners();

    const GoFishLobby = await ethers.getContractFactory("GoFishLobby");
    goFishLobby = await GoFishLobby.deploy();
  });

  describe("Lobby Creation", function () {
    it("Should create a new lobby", async function () {
      const tx = await goFishLobby.connect(owner).createLobby(4);
      const receipt = await tx.wait();

      expect(receipt).to.not.be.null;

      const lobby = await goFishLobby.getLobby(1);
      expect(lobby.host).to.equal(owner.address);
      expect(lobby.maxPlayers).to.equal(4);
      expect(lobby.currentPlayers).to.equal(1);
      expect(lobby.isActive).to.be.true;
    });

    it("Should reject invalid player counts", async function () {
      await expect(goFishLobby.createLobby(1)).to.be.revertedWith("Invalid player count");
      await expect(goFishLobby.createLobby(7)).to.be.revertedWith("Invalid player count");
    });

    it("Should add lobby to active lobbies", async function () {
      await goFishLobby.createLobby(4);
      const activeLobbies = await goFishLobby.getActiveLobbies();
      expect(activeLobbies.length).to.equal(1);
      expect(activeLobbies[0]).to.equal(1n);
    });
  });

  describe("Joining Lobbies", function () {
    beforeEach(async function () {
      await goFishLobby.connect(owner).createLobby(4);
    });

    it("Should allow players to join", async function () {
      await goFishLobby.connect(player1).joinLobby(1);

      const lobby = await goFishLobby.getLobby(1);
      expect(lobby.currentPlayers).to.equal(2);

      const isInLobby = await goFishLobby.isPlayerInLobby(1, player1.address);
      expect(isInLobby).to.be.true;
    });

    it("Should reject joining full lobby", async function () {
      await goFishLobby.connect(owner).createLobby(2);
      await goFishLobby.connect(player1).joinLobby(2);

      await expect(goFishLobby.connect(player2).joinLobby(2))
        .to.be.revertedWith("Lobby full");
    });

    it("Should reject joining twice", async function () {
      await goFishLobby.connect(player1).joinLobby(1);

      await expect(goFishLobby.connect(player1).joinLobby(1))
        .to.be.revertedWith("Already in lobby");
    });
  });

  describe("Leaving Lobbies", function () {
    beforeEach(async function () {
      await goFishLobby.connect(owner).createLobby(4);
      await goFishLobby.connect(player1).joinLobby(1);
    });

    it("Should allow players to leave", async function () {
      await goFishLobby.connect(player1).leaveLobby(1);

      const lobby = await goFishLobby.getLobby(1);
      expect(lobby.currentPlayers).to.equal(1);

      const isInLobby = await goFishLobby.isPlayerInLobby(1, player1.address);
      expect(isInLobby).to.be.false;
    });

    it("Should close lobby when host leaves", async function () {
      await goFishLobby.connect(owner).leaveLobby(1);

      const lobby = await goFishLobby.getLobby(1);
      expect(lobby.isActive).to.be.false;

      const activeLobbies = await goFishLobby.getActiveLobbies();
      expect(activeLobbies.length).to.equal(0);
    });
  });

  describe("Starting Games", function () {
    beforeEach(async function () {
      await goFishLobby.connect(owner).createLobby(4);
      await goFishLobby.connect(player1).joinLobby(1);
    });

    it("Should allow host to start game", async function () {
      await goFishLobby.connect(owner).startGame(1);

      const lobby = await goFishLobby.getLobby(1);
      expect(lobby.isActive).to.be.false;

      const activeLobbies = await goFishLobby.getActiveLobbies();
      expect(activeLobbies.length).to.equal(0);
    });

    it("Should reject non-host starting game", async function () {
      await expect(goFishLobby.connect(player1).startGame(1))
        .to.be.revertedWith("Only host can start");
    });

    it("Should reject starting with less than 2 players", async function () {
      await goFishLobby.connect(owner).createLobby(4);

      await expect(goFishLobby.connect(owner).startGame(2))
        .to.be.revertedWith("Need at least 2 players");
    });
  });

  describe("Player Stats", function () {
    it("Should update player stats", async function () {
      await goFishLobby.updatePlayerStats(player1.address, true, 5);

      const stats = await goFishLobby.getPlayerStats(player1.address);
      expect(stats.gamesPlayed).to.equal(1);
      expect(stats.gamesWon).to.equal(1);
      expect(stats.totalBooks).to.equal(5);
      expect(stats.rating).to.equal(10);
    });

    it("Should track multiple games", async function () {
      await goFishLobby.updatePlayerStats(player1.address, true, 5);
      await goFishLobby.updatePlayerStats(player1.address, false, 3);

      const stats = await goFishLobby.getPlayerStats(player1.address);
      expect(stats.gamesPlayed).to.equal(2);
      expect(stats.gamesWon).to.equal(1);
      expect(stats.totalBooks).to.equal(8);
      expect(stats.rating).to.equal(5); // 10 - 5
    });
  });
});

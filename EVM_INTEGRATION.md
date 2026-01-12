# EVM Lobby Contract Integration for Go Fish

## Overview
This document explains the EVM lobby contract setup for the Go Fish game, following Paima Engine patterns from the reference templates (dice, chess, rock-paper-scissors).

---

## Architecture

```
┌─────────────┐        ┌──────────────────┐        ┌─────────────────┐
│   Frontend  │───────▶│ PaimaL2Contract  │───────▶│ Paima Engine    │
│             │  (1)   │  (EVM)           │  (2)   │ State Machine   │
│  (Vite +    │        │                  │        │                 │
│   React)    │        │ submitGameInput()│        │ Process grammar │
└─────────────┘        └──────────────────┘        └─────────────────┘
       │                                                     │
       │                                                     │ (3)
       │                        ┌────────────────────────────┘
       │                        │
       │                        ▼
       │                ┌─────────────────┐
       │                │   Database      │
       │                │  (PostgreSQL)   │
       │                │                 │
       │                │ - lobbies       │
       │                │ - players       │
       │                │ - game_state    │
       │                └─────────────────┘
       │                        │
       └────────────────────────┘
              (4) Poll for updates
```

### Flow:
1. **Frontend → EVM**: Submit game input via `paimaSubmitGameInput(data)`
2. **EVM → Paima Engine**: Indexer reads transaction logs, parses grammar
3. **Paima Engine → Database**: State machine executes, updates SQL tables
4. **Database → Frontend**: API endpoints serve current state

---

## Contracts Deployed

### 1. PaimaL2Contract
**Location**: `/packages/shared/contracts/evm/contracts/PaimaL2Contract.sol`

**Purpose**: Entry point for all game inputs submitted to the L2

**Key Method**:
```solidity
function paimaSubmitGameInput(bytes data) external payable
```

**Deployment**:
- Owner: First account (deployer)
- Fee: 0 wei (free-to-play)

### 2. GoFishLobby
**Location**: `/packages/shared/contracts/evm/contracts/GoFishLobby.sol`

**Purpose**: Manages lobby metadata and player stats on-chain (optional, for advanced features)

**Key Functions**:
- `createLobby(uint8 maxPlayers)`: Create new lobby
- `joinLobby(uint256 lobbyId)`: Join existing lobby
- `leaveLobby(uint256 lobbyId)`: Leave lobby
- `startGame(uint256 lobbyId)`: Start the game (host only)
- `updatePlayerStats(address player, bool won, uint256 books)`: Update on-chain stats

**Note**: For the initial MVP, **PaimaL2Contract is sufficient**. GoFishLobby can be used later for on-chain reputation, rankings, or NFT rewards.

---

## Grammar Definition

**Location**: `/packages/shared/data-types/src/grammar.ts`

Defines concise input format for all game actions:

```typescript
export const goFishL2Grammar = {
  // c|playerName|maxPlayers
  createdLobby: [
    ['playerName', PlayerName],
    ['maxPlayers', Type.Number({ minimum: 2, maximum: 6 })],
  ],

  // j|playerName|lobbyID
  joinedLobby: [
    ['playerName', PlayerName],
    ['lobbyID', LobbyID],
  ],

  // l|lobbyID
  leftLobby: [['lobbyID', LobbyID]],

  // r|lobbyID
  toggledReady: [['lobbyID', LobbyID]],

  // start|lobbyID
  startedGame: [['lobbyID', LobbyID]],

  // ask|lobbyID|targetPlayerID|rank
  askedForCard: [
    ['lobbyID', LobbyID],
    ['targetPlayerID', PlayerID],
    ['rank', Rank],
  ],

  // close|lobbyID
  closedLobby: [['lobbyID', LobbyID]],
};
```

---

## Deployment Configuration

**Location**: `/packages/shared/contracts/evm/ignition/modules/GoFishLobby.ts`

```typescript
const GoFishModule = buildModule("GoFishModule", (m) => {
  const owner = m.getAccount(0);

  const paimaL2Contract = m.contract("PaimaL2Contract", [owner, 0]);
  const goFishLobby = m.contract("GoFishLobby");

  return { paimaL2Contract, goFishLobby };
});
```

**Deploy Command**:
```bash
cd packages/shared/contracts/evm
npx hardhat ignition deploy ignition/modules/GoFishLobby.ts --network localhost
```

**Output**:
- PaimaL2Contract address: `0x5FbDB2315678afecb367f032d93F642f64180aa3` (example)
- GoFishLobby address: `0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512` (example)

---

## Next Steps for Full Integration

### 1. **Frontend Contract Service**
Create `/packages/frontend/src/services/contract.ts`:

```typescript
import { BrowserProvider, Contract } from "ethers";
import PaimaL2ContractABI from "@contracts/PaimaL2Contract.json";

const PAIMA_L2_ADDRESS = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const CHAIN_URI = "http://localhost:8545";

export async function submitGameInput(
  wallet: string,
  conciseData: string[]
): Promise<string> {
  const provider = new BrowserProvider(window.ethereum);
  const signer = await provider.getSigner();

  const contract = new Contract(
    PAIMA_L2_ADDRESS,
    PaimaL2ContractABI,
    signer
  );

  // Format: "c|Alice|4" for create lobby
  const message = conciseData.join("|");
  const bytes = ethers.toUtf8Bytes(message);

  const tx = await contract.paimaSubmitGameInput(bytes, { value: 0 });
  const receipt = await tx.wait();

  return receipt.transactionHash;
}
```

### 2. **Update GoFishGameService**
Modify `/packages/frontend/src/services/GoFishGameService.ts`:

```typescript
import { submitGameInput } from "./contract";

export class GoFishGameService {
  async createLobby(name: string, maxPlayers: number): Promise<Lobby> {
    // Submit to blockchain
    const txHash = await submitGameInput(
      this.playerId,
      ["createdLobby", this.playerName, maxPlayers.toString()]
    );

    // Wait for state update from backend
    await this.waitForTransaction(txHash);

    // Fetch lobby from API
    const lobby = await this.fetchNewLobby(txHash);
    return lobby;
  }

  async joinLobby(lobbyId: string): Promise<boolean> {
    const txHash = await submitGameInput(
      this.playerId,
      ["joinedLobby", this.playerName, lobbyId]
    );

    await this.waitForTransaction(txHash);
    return true;
  }

  async askForCard(
    lobbyId: string,
    targetPlayerId: string,
    rank: Rank
  ): Promise<boolean> {
    const txHash = await submitGameInput(
      this.playerId,
      ["askedForCard", lobbyId, targetPlayerId, rank]
    );

    await this.waitForTransaction(txHash);
    return true;
  }
}
```

### 3. **Backend State Machine**
Create `/packages/client/node/src/state-machine.ts`:

```typescript
import { StartConfigGameStateTransitions } from "@effectstream/core";
import * as World from "@effectstream/db";

export const gameStateTransitions: StartConfigGameStateTransitions =
  function* (blockHeight, input) {
    yield* stm.processInput(input);
  };

stm.addStateTransition("createdLobby", function* (data) {
  const { blockHeight, parsedInput, signerAddress: user } = data;

  // Generate unique 12-character lobby ID
  const lobbyId = generateLobbyId();

  // Create lobby in database
  yield* World.resolve(createLobby, {
    lobby_id: lobbyId,
    host: user,
    host_name: parsedInput.playerName,
    max_players: parsedInput.maxPlayers,
    status: "waiting",
    created_at: blockHeight,
  });

  // Add host as first player
  yield* World.resolve(addPlayer, {
    lobby_id: lobbyId,
    player_id: user,
    player_name: parsedInput.playerName,
    is_ready: false,
  });
});

stm.addStateTransition("joinedLobby", function* (data) {
  const { parsedInput, signerAddress: user } = data;

  // Query lobby
  const lobby = yield* World.resolve(
    getLobbyById,
    { lobby_id: parsedInput.lobbyID }
  );

  // Validate lobby exists and has space
  if (!lobby || lobby.current_players >= lobby.max_players) {
    throw new Error("Cannot join lobby");
  }

  // Add player
  yield* World.resolve(addPlayer, {
    lobby_id: parsedInput.lobbyID,
    player_id: user,
    player_name: parsedInput.playerName,
    is_ready: false,
  });

  // Update player count
  yield* World.resolve(updateLobby, {
    lobby_id: parsedInput.lobbyID,
    current_players: lobby.current_players + 1,
  });
});

stm.addStateTransition("startedGame", function* (data) {
  const { parsedInput, signerAddress: user } = data;

  // Validate host
  const lobby = yield* World.resolve(
    getLobbyById,
    { lobby_id: parsedInput.lobbyID }
  );

  if (lobby.host !== user) {
    throw new Error("Only host can start game");
  }

  // Initialize game state (deck, hands, etc.)
  const gameState = initializeGame(lobby);

  yield* World.resolve(createGame, {
    lobby_id: parsedInput.lobbyID,
    status: "in_progress",
    deck: JSON.stringify(gameState.deck),
    hands: JSON.stringify(gameState.hands),
    current_turn_index: 0,
  });

  yield* World.resolve(updateLobby, {
    lobby_id: parsedInput.lobbyID,
    status: "in_progress",
  });
});

stm.addStateTransition("askedForCard", function* (data) {
  const { parsedInput, signerAddress: user } = data;

  // Query current game state
  const game = yield* World.resolve(
    getGame,
    { lobby_id: parsedInput.lobbyID }
  );

  const hands = JSON.parse(game.hands);
  const currentPlayer = hands[user];
  const targetPlayer = hands[parsedInput.targetPlayerID];

  // Execute ask logic
  const cardsGiven = targetPlayer.filter(c => c.rank === parsedInput.rank);

  if (cardsGiven.length > 0) {
    // Transfer cards
    currentPlayer.push(...cardsGiven);
    targetPlayer = targetPlayer.filter(c => c.rank !== parsedInput.rank);

    // Check for books
    const book = checkForBook(currentPlayer, parsedInput.rank);
    if (book) {
      // Add book, remove cards
      // ...
    }
  } else {
    // Go Fish - draw card
    const deck = JSON.parse(game.deck);
    const drawnCard = deck.pop();
    currentPlayer.push(drawnCard);

    // Advance turn
    game.current_turn_index = (game.current_turn_index + 1) % game.player_count;
  }

  // Update game state
  yield* World.resolve(updateGame, {
    lobby_id: parsedInput.lobbyID,
    hands: JSON.stringify(hands),
    deck: JSON.stringify(deck),
    current_turn_index: game.current_turn_index,
  });

  // Add to game log
  yield* World.resolve(addGameLog, {
    lobby_id: parsedInput.lobbyID,
    message: `${user} asked ${parsedInput.targetPlayerID} for ${parsedInput.rank}s`,
  });
});
```

### 4. **Database Schema**
Create `/packages/client/database/migrations/001_init.sql`:

```sql
CREATE TABLE lobbies (
  lobby_id VARCHAR(12) PRIMARY KEY,
  host VARCHAR(100) NOT NULL,
  host_name VARCHAR(20) NOT NULL,
  max_players INTEGER NOT NULL,
  current_players INTEGER DEFAULT 0,
  status VARCHAR(20) NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE lobby_players (
  lobby_id VARCHAR(12) REFERENCES lobbies(lobby_id),
  player_id VARCHAR(100) NOT NULL,
  player_name VARCHAR(20) NOT NULL,
  is_ready BOOLEAN DEFAULT false,
  PRIMARY KEY (lobby_id, player_id)
);

CREATE TABLE games (
  lobby_id VARCHAR(12) PRIMARY KEY REFERENCES lobbies(lobby_id),
  status VARCHAR(20) NOT NULL,
  deck TEXT NOT NULL,
  hands TEXT NOT NULL,
  books TEXT NOT NULL,
  current_turn_index INTEGER NOT NULL,
  winner VARCHAR(100),
  started_at BIGINT,
  ended_at BIGINT
);

CREATE TABLE game_logs (
  id SERIAL PRIMARY KEY,
  lobby_id VARCHAR(12) REFERENCES lobbies(lobby_id),
  message TEXT NOT NULL,
  timestamp BIGINT NOT NULL
);
```

### 5. **API Endpoints**
Create `/packages/client/node/src/api.ts`:

```typescript
import Fastify from "fastify";
import { Pool } from "pg";

const server = Fastify();
const dbConn = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Get all open lobbies
server.get("/lobbies", async (request, reply) => {
  const lobbies = await dbConn.query(`
    SELECT * FROM lobbies WHERE status = 'waiting'
  `);
  return reply.send(lobbies.rows);
});

// Get specific lobby with players
server.get("/lobby/:lobbyId", async (request, reply) => {
  const { lobbyId } = request.params;

  const [lobby] = await dbConn.query(`
    SELECT * FROM lobbies WHERE lobby_id = $1
  `, [lobbyId]);

  const players = await dbConn.query(`
    SELECT * FROM lobby_players WHERE lobby_id = $1
  `, [lobbyId]);

  return reply.send({ ...lobby.rows[0], players: players.rows });
});

// Get game state
server.get("/game/:lobbyId", async (request, reply) => {
  const { lobbyId } = request.params;

  const [game] = await dbConn.query(`
    SELECT * FROM games WHERE lobby_id = $1
  `, [lobbyId]);

  const logs = await dbConn.query(`
    SELECT * FROM game_logs WHERE lobby_id = $1 ORDER BY timestamp DESC LIMIT 20
  `, [lobbyId]);

  return reply.send({
    ...game.rows[0],
    deck: JSON.parse(game.rows[0].deck),
    hands: JSON.parse(game.rows[0].hands),
    books: JSON.parse(game.rows[0].books),
    logs: logs.rows,
  });
});

server.listen({ port: 3000 });
```

---

## Summary

### ✅ Completed:
1. **PaimaL2Contract.sol** - EVM contract for game input submission
2. **GoFishLobby.sol** - EVM contract for lobby management
3. **Grammar definition** - Concise input format for all game actions
4. **Hardhat deployment module** - Deploys both contracts
5. **Architecture documentation** - This file

### 🚧 Next Steps:
1. **Deploy contracts** to localhost/testnet
2. **Create frontend contract service** for submitting transactions
3. **Update GoFishGameService** to use blockchain instead of local state
4. **Implement backend state machine** to process game inputs
5. **Create database schema** for lobby/game state
6. **Build API endpoints** to serve state to frontend
7. **Test end-to-end flow** with multiple players

### 📚 Reference:
- Dice template: `/Users/joshuathomas/git/paima-engine/templates/dice`
- Chess template: `/Users/joshuathomas/git/paima-engine/templates/chess`
- Rock-Paper-Scissors template: `/Users/joshuathomas/git/paima-engine/templates/rock-paper-scissors`

---

## Deployment Instructions

### 1. Start Local Hardhat Node
```bash
cd packages/shared/contracts/evm
npx hardhat node
```

### 2. Deploy Contracts
```bash
npx hardhat ignition deploy ignition/modules/GoFishLobby.ts --network localhost
```

### 3. Copy Contract Addresses
Update `/packages/frontend/src/services/constants.ts` with deployed addresses:
```typescript
export const PAIMA_L2_ADDRESS = "0x..."; // From deployment output
export const GOFISH_LOBBY_ADDRESS = "0x...";
export const CHAIN_URI = "http://localhost:8545";
```

### 4. Start Paima Engine
```bash
cd packages/client/node
npm run start:dev
```

### 5. Start Frontend
```bash
cd packages/frontend
npm run dev
```

Now the game will use on-chain lobbies and support true multiplayer across different browsers/devices!

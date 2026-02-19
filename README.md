# Go Fish Game - Paima Engine (Effectstream)

A Go Fish card game implementation using Paima Engine (Effectstream) with EVM for lobbies and Midnight for game logic.

## ⚡ Quick Start

### Full Stack Development (Recommended)

Run the complete development environment with orchestrator:

```bash
# First time setup
deno install --allow-scripts

# Build EVM contracts
deno task build:evm

# Start all services (backend + frontend + blockchain)
deno task dev
```

This will launch:
- **Frontend**: http://localhost:3000
- **API**: http://localhost:9999
- **Explorer**: http://localhost:10590
- **Blockchain**: http://localhost:8545

### Batcher Mode (Midnight)

For development with Midnight blockchain integration, you can run the infrastructure and dev server separately:

```bash
# Terminal 1: Start Midnight infrastructure (node, indexer, proof server, contract deployment)
EFFECTSTREAM_STDOUT=true deno task -f @go-fish/node midnight:setup

# Terminal 2: Start the dev server with batcher mode (after infra is ready)
USE_TYPESCRIPT_CONTRACT=false EFFECTSTREAM_STDOUT=true USE_BATCHER_MODE=true SKIP_MIDNIGHT_INFRA=true deno task dev
```

The `SKIP_MIDNIGHT_INFRA=true` flag tells the dev server to skip launching Midnight infrastructure since it's already running from the first command.

### Frontend Only

For quick frontend-only development:

```bash
cd packages/frontend
npm install
npm run dev
```

Visit **http://localhost:3000**

## Project Structure

```
/packages/
├── frontend/              # Web UI (HTML5, Canvas/SVG, TypeScript, Vite)
├── client/
│   ├── node/             # Paima engine node (state machine, APIs)
│   ├── batcher/          # Transaction batching service
│   └── database/         # PGLite queries and schema (pgtyped)
└── shared/
    ├── contracts/
    │   ├── evm/          # Hardhat contracts for lobbies & stats (EVM)
    │   └── midnight/     # Midnight contracts for game logic (stub)
    ├── data-types/       # Shared types and config
    └── simulation/       # Game simulation logic
```

## Architecture

This project follows a hybrid blockchain architecture:

- **Frontend**: User interface with HTML5 Canvas/SVG rendering
- **EVM Contracts**: Handle lobbies, player stats, matchmaking (Hardhat)
- **Midnight Contracts**: Handle private game state and logic
- **Paima Node**: Processes blockchain transactions and maintains game state
- **Batcher**: Batches user transactions to reduce on-chain costs
- **Database**: PGLite (in-memory/WASM PostgreSQL) for game state storage
- **Simulation**: Shared deterministic game logic (frontend + backend)

### Go Fish Game Features

- 🃏 Classic Go Fish card game mechanics
- 🎮 Multiplayer lobbies (2-6 players)
- 🏆 Player statistics and leaderboards (EVM)
- 🔐 Private game state using Midnight
- 📊 Match history and rankings

## How to Play Go Fish

Go Fish is a classic card matching game:

1. **Setup**: Each player is dealt 5-7 cards
2. **Turn**: On your turn, ask any player for a specific rank (e.g., "Do you have any 7s?")
3. **Match**: If they have it, they give you all cards of that rank. You get another turn.
4. **Go Fish**: If they don't have it, they say "Go Fish!" and you draw a card
5. **Books**: When you collect all 4 cards of a rank, it forms a "book" (1 point)
6. **Win**: The player with the most books when the deck runs out wins!

## Commands

```bash
# Frontend Development
cd packages/frontend
npm install
npm run dev              # Start dev server
npm run build            # Production build
npm run preview          # Preview build

# Backend
deno task dev            # Start Paima node
deno task testnet        # Start in testnet mode

# Smart Contracts (EVM)
cd packages/shared/contracts/evm
npx hardhat compile      # Compile Solidity contracts
npx hardhat test         # Run contract tests
npx hardhat deploy       # Deploy to local network

# Root Level
deno task frontend:dev   # Start frontend from root
deno task frontend:build # Build frontend from root
```

## Database Schema

PGLite database tables for the Go Fish game:

- **lobbies** - Active game lobbies with player counts
- **lobby_players** - Players in each lobby with ready status
- **games** - Game instances with status (planned for Midnight integration)
- **effectstream.accounts** - Account management (Paima Effectstream)
- **effectstream.addresses** - Address-to-account mapping (Paima Effectstream)

All migrations are in [packages/client/database/src/mod.ts](packages/client/database/src/mod.ts)

Queries are defined in SQL files and auto-generated using pgtyped:
- [packages/client/database/src/lobby-queries.sql](packages/client/database/src/lobby-queries.sql)
- Run `pgtyped -c pgtyped.config.json` to regenerate TypeScript query files

## Game Commands

Blockchain commands (Paima concise grammar format):

**Lobby Management (EVM):**
- `createdLobby|playerName|maxPlayers` - Create game lobby
- `joinedLobby|playerName|lobbyID` - Join lobby
- `toggledReady|lobbyID` - Toggle ready status
- `startedGame|lobbyID` - Start game (host only)
- `leftLobby|lobbyID` - Leave lobby
- `closedLobby|lobbyID` - Close lobby (host only)

**Game Actions (Midnight - planned):**
- `askedForCard|lobbyID|targetPlayerID|rank` - Ask player for cards
- Game logic will be handled by Midnight contracts for privacy

See [packages/shared/data-types/src/grammar.ts](packages/shared/data-types/src/grammar.ts)

## Technology Stack

- **Backend**: Deno, TypeScript, Paima Engine
- **Frontend**: Vite, TypeScript, HTML5 Canvas/SVG
- **Blockchain (EVM)**: Hardhat, Solidity (lobbies & stats)
- **Blockchain (Midnight)**: Midnight contracts (game logic - stub)
- **State Management**: Paima State Machine (PaimaSTM)

## Resources

- [Paima Engine Documentation](https://docs.paimastudios.com/)
- [Midnight Blockchain](https://midnight.network/)
- [Hardhat Documentation](https://hardhat.org/)
- [PAIMA_NOTES.md](PAIMA_NOTES.md) (technical notes and workarounds)

## License

MIT

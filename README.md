# Go Fish Game - Paima Engine (Effectstream)

A Go Fish card game implementation using Paima Engine (Effectstream) with EVM for lobbies and Midnight for game logic.

## ⚡ Quick Start

### Full Stack Development (Recommended)

Run the complete development environment with orchestrator:

```bash
# First time setup
deno install --allow-scripts

# Start all services
deno task dev
```

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
│   └── database/         # PostgreSQL queries and schema
└── shared/
    ├── contracts/
    │   ├── evm/          # Hardhat contracts for lobbies & stats (EVM)
    │   └── midnight/     # Midnight contracts for game logic (stub)
    ├── data-types/       # Shared types and config
    └── simulation/       # Game simulation logic
```

All packages are properly configured and ready to use!

## Architecture

This project follows a hybrid blockchain architecture:

- **Frontend**: User interface with HTML5 Canvas/SVG rendering
- **EVM Contracts**: Handle lobbies, player stats, matchmaking (Hardhat)
- **Midnight Contracts**: Handle private game state and logic (stub for now)
- **Paima Node**: Processes blockchain transactions and maintains game state
- **Batcher**: Batches user transactions to reduce on-chain costs
- **Database**: PostgreSQL for game state storage
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

PostgreSQL tables for the Go Fish game:

- **user_stats** - Player profiles, games played/won
- **lobbies** - Active game lobbies with player counts
- **games** - Game instances with status
- **game_players** - Players in each game with their hands
- **game_moves** - Move history (asks, matches, draws)

All migrations are in [packages/client/database/src/mod.ts](packages/client/database/src/mod.ts)

## Game Commands

Blockchain commands (colon-separated format):

- `setName:name` - Set display name
- `createLobby:maxPlayers` - Create game lobby (EVM)
- `joinLobby:lobbyId` - Join lobby (EVM)
- `askForCard:gameId:playerId:rank` - Ask player for cards
- `drawCard:gameId` - Draw from deck
- `declareBook:gameId:rank` - Declare a completed book

See [packages/shared/data-types/src/grammar.ts](packages/shared/data-types/src/grammar.ts)

## Technology Stack

- **Backend**: Deno, TypeScript, Paima Engine
- **Frontend**: Vite, TypeScript, HTML5 Canvas/SVG
- **Database**: PostgreSQL with typed queries
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

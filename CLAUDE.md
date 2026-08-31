# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Go Fish card game built on **Paima Engine (Effectstream)** with a hybrid blockchain architecture:
- **EVM (Solidity/Hardhat)**: Lobbies, matchmaking, player stats
- **Midnight (Compact language)**: Private game logic, card shuffling/dealing with ZK proofs
- **Paima Node (Bun)**: State machine processing blockchain events, REST API
- **Frontend**: Three.js 3D game scene with HTML overlay screens (Vite + TypeScript)

## Build & Run Commands

```bash
# First time setup
bun install

# Build EVM contracts (required before first run)
bun run build:evm

# Full stack dev (launches frontend:3000, API:9996, EVM:8545, explorer:10590)
bun run dev

# Dev with batcher mode (no Lace wallet needed)
bun run dev:batcher

# Dev with TypeScript contract (no Midnight infrastructure needed)
bun run dev:typescript

# Frontend only
bun run frontend:dev

# Build Midnight contracts
bun run build:midnight
```

### Testing

```bash
# Run node tests (bun:test, api.test.ts)
bun run test

# Watch mode
bun run --filter @go-fish/node test:watch

# Run a single test file directly
bun test packages/client/node/src/api.test.ts

# Midnight contract tests
cd packages/shared/contracts/midnight && bun run test

# EVM contract tests
cd packages/shared/contracts/evm && npx hardhat test

# E2E smoke tests
bun run --filter @go-fish/e2e smoke:imports
bun run test:e2e
```

### EVM Contract Build Details

```bash
# Full compile (forge + hardhat + deploy + artifact generation)
bun run --filter @go-fish/evm-contracts contract:compile

# Individual steps
cd packages/shared/contracts/evm
bun run build:forge      # Forge only
bun run build:hardhat    # Hardhat only
bun run deploy:standalone  # Start chain, deploy, stop
```

### Midnight Infrastructure (for full Midnight dev)

```bash
# Terminal 1: Start all Midnight services
EFFECTSTREAM_STDOUT=true bun run --filter @go-fish/node midnight:setup

# Terminal 2: Dev server connecting to running infra
USE_TYPESCRIPT_CONTRACT=false EFFECTSTREAM_STDOUT=true USE_BATCHER_MODE=true SKIP_MIDNIGHT_INFRA=true bun run dev
```

## Architecture

```
Frontend (Vite/Three.js :3000)
  ├─ HTTP /api ──► Paima Node (:9996) ──► PGLite DB
  │                  ├─ EVM read (Hardhat :8545)
  │                  └─ Midnight query (Indexer :8088)
  └─ HTTP /batcher-query ──► Batcher (:3334) ──► Midnight
```

**Data flow by phase:**
1. **Lobby** (EVM): Frontend → PaimaL2Contract → Paima state machine → PGLite
2. **Game** (Midnight): Frontend → Midnight contract (ZK proofs) → Indexer → Paima queries
3. **Scoring**: Game completion → leaderboard calculation → PGLite persistence

### Package Structure

- `packages/frontend/` — Vite SPA: Three.js scenes, screen overlays, wallet bridges
- `packages/client/node/` — Paima node: state machine (`state-machine.ts`), REST API (`api.ts`), Midnight integration
- `packages/client/batcher/` — Transaction batching service for Midnight
- `packages/client/database/` — PGLite schema, migrations (`mod.ts`), SQL queries (pgtyped)
- `packages/shared/data-types/` — Shared types, Paima concise grammar, config
- `packages/shared/contracts/evm/` — Solidity: `GoFishLobby.sol`, `PaimaL2Contract.sol`
- `packages/shared/contracts/midnight/` — Compact: `GoFish.compact`, `Deck.compact`, `Hand.compact`, etc.

### Key Environment Variables

- `USE_TYPESCRIPT_CONTRACT=true` — Local TypeScript contract (skip Midnight infra)
- `USE_BATCHER_MODE=true` — Batcher mode (no Lace wallet needed)
- `SKIP_EVM_LAUNCH=true` — Skip Hardhat if already running
- `SKIP_MIDNIGHT_INFRA=true` — Skip Midnight services
- `EFFECTSTREAM_STDOUT=true` — Log to stdout instead of tmux

## Game Domain

Simplified 21-card deck: 7 ranks (A,2-7) x 3 suits (hearts, diamonds, clubs). Book = 3 cards of same rank. 4 cards dealt per player. Card index formula: `rank_index + (suit_index * 7)` → 0-20.

Paima concise grammar commands (defined in `data-types/src/grammar.ts`):
- Lobby: `createdLobby`, `joinedLobby`, `closedLobby`
- `joinedLobby` auto-starts the game: the 2nd player always fills the lobby, so
  the state machine flips `status='open'` → `'in_progress'` in the same transition.
- `closedLobby` is host-only and only valid while the host is alone.
- Open lobbies disappear from `/open_lobbies` 10 minutes after creation (soft TTL).
- Game-round actions (ask for card, respond, go fish, score books) run on the
  Midnight contract as ZK circuits, not the EVM grammar.

## Critical: Midnight ec_mul Guard Bug

**Never put `std_ecMul` (or any function calling it) inside a Compact `if/else` branch.** The ZKIR compiler wraps branch inputs with guards that produce `(0,0)` on inactive branches, and `ec_mul` has no guard support — it panics on invalid curve points.

**Fix pattern:** Fetch all secrets unconditionally, use ternary (`? :`) to select the right value (compiles to safe `cond_select`), then call `ec_mul` once unconditionally.

**Verify after compiling:** Run the detection script in `ZKIR-EC-MUL-GUARD-BUG.md` after every `bun run --filter @go-fish/midnight-contract compact` to ensure no circuit has both `ec_mul` and guarded `public_input` ops.

## Compact Point Comparison

When comparing `JubjubPoint` values in Compact 0.30.0, do **not** use `===` (it will silently fail). Instead, hash both points and compare the hashes.

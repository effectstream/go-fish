/**
 * Database module - exports all database queries and types
 */

import type { DBMigrations } from "@paimaexample/runtime";

// Export pgtyped query functions
export * from './lobby-queries.queries.ts';
export * from './game-queries.queries.ts';
export * from './user-queries.queries.ts';
export * from './midnight-games-queries.queries.ts';

// Migration table for database schema
// In v0.3.128+, this is now an array of migration objects
export const migrationTable: DBMigrations[] = [
  {
    name: "1_initial_gofish",
    sql: `
-- Go Fish Game Database Schema

-- User game state table
CREATE TABLE IF NOT EXISTS user_game_state (
    account_id INTEGER PRIMARY KEY,
    display_name TEXT,
    games_played INTEGER DEFAULT 0,
    games_won INTEGER DEFAULT 0,
    books_completed INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Lobbies table (game lobbies before the game starts)
-- Go Fish is always a 2-player game; max_players is a code constant, not a column.
CREATE TABLE IF NOT EXISTS lobbies (
    lobby_id TEXT PRIMARY KEY,
    lobby_name TEXT NOT NULL,
    host_account_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    started_at TIMESTAMP,
    ended_at TIMESTAMP
);

-- Lobby players table (tracks players in each lobby)
-- No ready flag: join auto-starts the game when the lobby fills.
CREATE TABLE IF NOT EXISTS lobby_players (
    lobby_id TEXT NOT NULL,
    account_id INTEGER NOT NULL,
    player_name TEXT NOT NULL,
    joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (lobby_id, account_id)
);

-- Games table (active Go Fish games)
CREATE TABLE IF NOT EXISTS games (
    game_id TEXT PRIMARY KEY,
    lobby_id TEXT,
    status TEXT NOT NULL DEFAULT 'in_progress',
    current_turn_account_id INTEGER,
    deck_remaining INTEGER DEFAULT 52,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    ended_at TIMESTAMP
);

-- Game players table (tracks players in active games)
CREATE TABLE IF NOT EXISTS game_players (
    game_id TEXT NOT NULL,
    account_id INTEGER NOT NULL,
    cards_in_hand INTEGER DEFAULT 7,
    books_count INTEGER DEFAULT 0,
    turn_order INTEGER NOT NULL,
    PRIMARY KEY (game_id, account_id)
);

-- Game moves table (tracks all game actions)
CREATE TABLE IF NOT EXISTS game_moves (
    move_id SERIAL PRIMARY KEY,
    game_id TEXT NOT NULL,
    account_id INTEGER NOT NULL,
    move_type TEXT NOT NULL,
    target_account_id INTEGER,
    rank TEXT,
    cards_transferred INTEGER DEFAULT 0,
    success BOOLEAN,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for common queries
CREATE INDEX IF NOT EXISTS idx_lobbies_status ON lobbies(status);
CREATE INDEX IF NOT EXISTS idx_lobbies_created ON lobbies(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lobby_players_lobby ON lobby_players(lobby_id);
CREATE INDEX IF NOT EXISTS idx_games_status ON games(status);
CREATE INDEX IF NOT EXISTS idx_game_players_game ON game_players(game_id);
CREATE INDEX IF NOT EXISTS idx_game_moves_game ON game_moves(game_id, created_at);
    `,
  },
  {
    name: "2_leaderboard",
    sql: `
-- Go Fish Leaderboard table
CREATE TABLE IF NOT EXISTS go_fish_leaderboard (
  midnight_address   TEXT    NOT NULL PRIMARY KEY,
  total_points       BIGINT  NOT NULL DEFAULT 0,
  games_played       INT     NOT NULL DEFAULT 0,
  games_won          INT     NOT NULL DEFAULT 0,
  last_updated_block BIGINT
);

-- Track each player's Midnight shielded address for leaderboard attribution
ALTER TABLE lobby_players
  ADD COLUMN IF NOT EXISTS midnight_address TEXT;
    `,
  },
  {
    name: "3_simplify_lobbies",
    sql: `
-- Simplify the lobby model to a fixed 2-player game with auto-start on join.
-- Drops the per-lobby max_players column and the per-player ready flag.
ALTER TABLE lobbies       DROP COLUMN IF EXISTS max_players;
ALTER TABLE lobby_players DROP COLUMN IF EXISTS is_ready;
    `,
  },
  {
    name: "4_host_mask_applied",
    sql: `
-- Host applies their Midnight mask immediately after createdLobby. While the
-- mask is still being proved / landed on-chain, the lobby is "Preparing" and
-- cannot be joined. The host flips this flag via the hostReady grammar tx.
ALTER TABLE lobbies
  ADD COLUMN IF NOT EXISTS host_mask_applied BOOLEAN NOT NULL DEFAULT false;
    `,
  },
  {
    name: "5_midnight_games",
    sql: `
-- Games projection driven purely from Midnight ledger diffs. No foreign keys;
-- no strong consistency with the EVM tables. evm_id is the ASCII decode of
-- midnight_id (the Bytes<32> key the contract uses), not a cross-reference.
CREATE TABLE IF NOT EXISTS midnight_games (
    midnight_id    TEXT PRIMARY KEY,
    evm_id         TEXT UNIQUE,
    host_pubkey    TEXT,
    joiner_pubkey  TEXT,
    created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ended_at       TIMESTAMP,
    state          TEXT NOT NULL DEFAULT 'ongoing'
);
CREATE INDEX IF NOT EXISTS idx_midnight_games_state ON midnight_games(state);
CREATE INDEX IF NOT EXISTS idx_midnight_games_evm_id ON midnight_games(evm_id);
    `,
  },
  {
    name: "6_midnight_games_scored",
    sql: `
ALTER TABLE midnight_games ADD COLUMN IF NOT EXISTS scored BOOLEAN NOT NULL DEFAULT false;
    `,
  },
];

-- Go Fish Game Database Schema
-- This migration creates the initial database structure

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
CREATE TABLE IF NOT EXISTS lobbies (
    lobby_id TEXT PRIMARY KEY,
    lobby_name TEXT NOT NULL,
    host_account_id INTEGER NOT NULL,
    max_players INTEGER NOT NULL DEFAULT 4,
    status TEXT NOT NULL DEFAULT 'open', -- open, in_progress, finished
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    started_at TIMESTAMP,
    ended_at TIMESTAMP
);

-- Lobby players table (tracks players in each lobby)
CREATE TABLE IF NOT EXISTS lobby_players (
    lobby_id TEXT NOT NULL,
    account_id INTEGER NOT NULL,
    player_name TEXT NOT NULL,
    is_ready BOOLEAN DEFAULT false,
    joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (lobby_id, account_id)
);

-- Games table (active Go Fish games)
CREATE TABLE IF NOT EXISTS games (
    game_id TEXT PRIMARY KEY,
    lobby_id TEXT,
    status TEXT NOT NULL DEFAULT 'in_progress', -- in_progress, completed
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
    move_type TEXT NOT NULL, -- ask, draw, declare_book
    target_account_id INTEGER,
    rank TEXT, -- '2'-'A' for card rank
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

/**
 * Shared type definitions for the Werewolf game
 */

export type GameStatus = 'waiting' | 'active' | 'completed';
export type GamePhase = 'lobby' | 'night' | 'day' | 'voting' | 'ended';
export type PlayerRole = 'werewolf' | 'villager' | 'seer' | 'doctor';
export type ActionType = 'kill' | 'protect' | 'investigate';

export interface GameConfig {
  maxPlayers: number;
  minPlayers: number;
  werewolfCount: number;
  nightDuration: number; // in seconds
  dayDuration: number; // in seconds
  votingDuration: number; // in seconds
}

export interface Player {
  accountId: number;
  displayName?: string;
  role?: PlayerRole;
  isAlive: boolean;
}

export interface GameState {
  gameId: number;
  status: GameStatus;
  phase: GamePhase;
  currentRound: number;
  players: Player[];
  maxPlayers: number;
}

export interface Vote {
  voterId: number;
  targetId: number;
  roundNumber: number;
}

export interface NightAction {
  actorId: number;
  actionType: ActionType;
  targetId: number;
  roundNumber: number;
}

// Default game configuration
export const DEFAULT_GAME_CONFIG: GameConfig = {
  maxPlayers: 8,
  minPlayers: 4,
  werewolfCount: 2,
  nightDuration: 60,
  dayDuration: 120,
  votingDuration: 60,
};

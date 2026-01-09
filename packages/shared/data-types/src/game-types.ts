/**
 * Game Types - Shared types for Werewolf game
 * These types are used both client-side and will map to on-chain state later
 */

export type PlayerRole = 'werewolf' | 'villager' | 'seer' | 'doctor';
export type GamePhase = 'lobby' | 'night' | 'day' | 'voting' | 'finished';
export type GameStatus = 'waiting' | 'in_progress' | 'finished';

export interface Player {
  id: string;
  name: string;
  role?: PlayerRole; // undefined in lobby, assigned when game starts
  isAlive: boolean;
  isReady: boolean; // for lobby ready-up
}

export interface ChatMessage {
  id: string;
  playerId: string;
  playerName: string;
  message: string;
  timestamp: number;
  isSystem?: boolean; // for game event messages
}

export interface Vote {
  voterId: string;
  targetId: string;
}

export interface NightAction {
  actorId: string;
  actionType: 'kill' | 'protect' | 'investigate';
  targetId: string;
}

export interface GameState {
  id: string;
  status: GameStatus;
  phase: GamePhase;
  round: number;
  players: Player[];
  maxPlayers: number;
  hostId: string;

  // Voting state
  votes: Vote[];
  votingDeadline?: number;

  // Night actions
  nightActions: NightAction[];
  nightDeadline?: number;

  // Game results
  winner?: 'werewolves' | 'villagers';
  eliminatedThisRound?: string[]; // player IDs

  // Timestamps
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
}

export interface Lobby {
  id: string;
  name: string;
  hostId: string;
  hostName: string;
  playerCount: number;
  maxPlayers: number;
  status: 'waiting' | 'starting' | 'in_progress';
  createdAt: number;
}

// Client-side only types (won't go on-chain)
export interface GameEvent {
  type: 'player_joined' | 'player_left' | 'game_started' | 'phase_changed' |
        'player_eliminated' | 'game_ended' | 'vote_cast' | 'chat_message';
  timestamp: number;
  data: any;
}

export interface PlayerAction {
  type: 'vote' | 'night_action' | 'ready';
  targetId?: string;
  actionType?: 'kill' | 'protect' | 'investigate';
}

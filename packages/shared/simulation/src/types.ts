/**
 * Simulation-specific types
 */

import type { GameState, Player, Vote, NightAction } from '@go-fish/data-types';

export interface SimulationResult {
  success: boolean;
  newState: GameState;
  events: GameEvent[];
  winner?: 'werewolves' | 'villagers';
}

export interface PhaseResult {
  eliminatedPlayers: number[];
  events: GameEvent[];
}

export type GameEvent =
  | { type: 'player_eliminated'; playerId: number; reason: string }
  | { type: 'phase_change'; from: string; to: string }
  | { type: 'game_ended'; winner: 'werewolves' | 'villagers' }
  | { type: 'role_revealed'; playerId: number; role: string }
  | { type: 'action_performed'; actorId: number; action: string; targetId: number };

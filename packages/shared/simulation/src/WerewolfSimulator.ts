/**
 * WerewolfSimulator - Core game simulation logic
 *
 * This runs on both frontend (for instant feedback) and backend (for authoritative state)
 */

import type { GameState, Player, Vote, NightAction } from '@werewolf/data-types';
import type { SimulationResult, PhaseResult, GameEvent } from './types.ts';

export class WerewolfSimulator {
  private gameState: GameState;

  constructor(gameState: GameState) {
    this.gameState = { ...gameState };
  }

  /**
   * Simulate the night phase
   * Werewolves choose a victim, other roles perform their actions
   */
  simulateNightPhase(actions: NightAction[]): PhaseResult {
    const events: GameEvent[] = [];
    const eliminatedPlayers: number[] = [];

    // Find kill action (werewolves)
    const killAction = actions.find((a) => a.actionType === 'kill');

    // Find protect action (doctor)
    const protectAction = actions.find((a) => a.actionType === 'protect');

    // Process kill
    if (killAction && (!protectAction || protectAction.targetId !== killAction.targetId)) {
      // Player was killed and not protected
      eliminatedPlayers.push(killAction.targetId);
      events.push({
        type: 'player_eliminated',
        playerId: killAction.targetId,
        reason: 'killed_by_werewolves',
      });
    }

    // Process investigate action (seer)
    const investigateAction = actions.find((a) => a.actionType === 'investigate');
    if (investigateAction) {
      events.push({
        type: 'action_performed',
        actorId: investigateAction.actorId,
        action: 'investigate',
        targetId: investigateAction.targetId,
      });
    }

    return { eliminatedPlayers, events };
  }

  /**
   * Simulate the voting phase
   * Players vote to eliminate someone during the day
   */
  simulateVotingPhase(votes: Vote[]): PhaseResult {
    const events: GameEvent[] = [];
    const eliminatedPlayers: number[] = [];

    // Count votes
    const voteCounts = new Map<number, number>();
    for (const vote of votes) {
      const count = voteCounts.get(vote.targetId) || 0;
      voteCounts.set(vote.targetId, count + 1);
    }

    // Find player with most votes
    let maxVotes = 0;
    let eliminatedPlayer: number | null = null;

    for (const [playerId, voteCount] of voteCounts.entries()) {
      if (voteCount > maxVotes) {
        maxVotes = voteCount;
        eliminatedPlayer = playerId;
      }
    }

    // Eliminate player if there's a clear majority
    if (eliminatedPlayer !== null && maxVotes > votes.length / 2) {
      eliminatedPlayers.push(eliminatedPlayer);
      events.push({
        type: 'player_eliminated',
        playerId: eliminatedPlayer,
        reason: 'voted_out',
      });
    }

    return { eliminatedPlayers, events };
  }

  /**
   * Check if the game has ended
   */
  checkGameEnd(): { ended: boolean; winner?: 'werewolves' | 'villagers' } {
    const alivePlayers = this.gameState.players.filter((p) => p.isAlive);
    const aliveWerewolves = alivePlayers.filter((p) => p.role === 'werewolf');
    const aliveVillagers = alivePlayers.filter((p) => p.role !== 'werewolf');

    // Werewolves win if they equal or outnumber villagers
    if (aliveWerewolves.length >= aliveVillagers.length && aliveWerewolves.length > 0) {
      return { ended: true, winner: 'werewolves' };
    }

    // Villagers win if all werewolves are eliminated
    if (aliveWerewolves.length === 0) {
      return { ended: true, winner: 'villagers' };
    }

    return { ended: false };
  }

  /**
   * Get the current game state
   */
  getState(): GameState {
    return { ...this.gameState };
  }

  /**
   * Update player alive status
   */
  eliminatePlayers(playerIds: number[]): void {
    for (const playerId of playerIds) {
      const player = this.gameState.players.find((p) => p.accountId === playerId);
      if (player) {
        player.isAlive = false;
      }
    }
  }
}

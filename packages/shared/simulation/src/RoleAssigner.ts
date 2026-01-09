/**
 * RoleAssigner - Handles random role assignment for players
 */

import type { Player, PlayerRole, GameConfig } from '@werewolf/data-types';
import { DEFAULT_GAME_CONFIG } from '@werewolf/data-types';

export class RoleAssigner {
  /**
   * Assign roles to players based on game configuration
   * Uses seeded randomness for deterministic results
   */
  static assignRoles(players: Player[], config: GameConfig = DEFAULT_GAME_CONFIG, seed: number): Player[] {
    const playerCount = players.length;

    // Determine role distribution
    const werewolfCount = Math.min(config.werewolfCount, Math.floor(playerCount / 3));
    const seerCount = 1;
    const doctorCount = 1;
    const villagerCount = playerCount - werewolfCount - seerCount - doctorCount;

    // Create role array
    const roles: PlayerRole[] = [
      ...Array(werewolfCount).fill('werewolf' as PlayerRole),
      ...Array(seerCount).fill('seer' as PlayerRole),
      ...Array(doctorCount).fill('doctor' as PlayerRole),
      ...Array(villagerCount).fill('villager' as PlayerRole),
    ];

    // Shuffle roles using seeded random
    const shuffledRoles = this.shuffle(roles, seed);

    // Assign roles to players
    return players.map((player, index) => ({
      ...player,
      role: shuffledRoles[index],
    }));
  }

  /**
   * Seeded random number generator
   */
  private static seededRandom(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state * 9301 + 49297) % 233280;
      return state / 233280;
    };
  }

  /**
   * Fisher-Yates shuffle with seeded randomness
   */
  private static shuffle<T>(array: T[], seed: number): T[] {
    const result = [...array];
    const random = this.seededRandom(seed);

    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }

    return result;
  }
}

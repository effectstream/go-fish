/**
 * Game API Router - Defines REST API endpoints for the game
 */

import type { FastifyInstance } from 'fastify';

export function createRouter(server: FastifyInstance, dbConn: any) {
  /**
   * Health check endpoint
   */
  server.get('/api/health', async (request, reply) => {
    return { status: 'ok', timestamp: Date.now() };
  });

  /**
   * Get user profile
   */
  server.get('/api/user/:address', async (request, reply) => {
    const { address } = request.params as { address: string };

    // TODO: Fetch user data from database
    return {
      address,
      name: 'Unknown',
      gamesPlayed: 0,
      gamesWon: 0,
    };
  });

  /**
   * Get game state
   */
  server.get('/api/game/:gameId', async (request, reply) => {
    const { gameId } = request.params as { gameId: string };

    // TODO: Fetch game state from database
    return {
      gameId,
      status: 'waiting',
      players: [],
      phase: 'lobby',
    };
  });

  /**
   * Get active games
   */
  server.get('/api/games/active', async (request, reply) => {
    // TODO: Fetch active games from database
    return {
      games: [],
    };
  });

  /**
   * Get leaderboard
   */
  server.get('/api/leaderboard', async (request, reply) => {
    // TODO: Fetch leaderboard from database
    return {
      leaderboard: [],
    };
  });

  console.log('Game API routes registered');
}

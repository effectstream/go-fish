/**
 * API Router - Defines REST API endpoints for the game
 */

import type { FastifyInstance } from "fastify";
import type { StartConfigApiRouter } from "@paimaexample/runtime";
import type { Pool } from "pg";
import pg from "pg";

// Global database connection pool
let dbPool: Pool | null = null;

// Get database connection - initialize on first call
function getDB(): Pool {
  if (!dbPool) {
    // Get database URL from environment
    const dbUrl = Deno.env.get("DATABASE_URL") || "postgresql://localhost:5432/go-fish";
    dbPool = new pg.Pool({ connectionString: dbUrl });
  }
  return dbPool;
}

export const apiRouter: StartConfigApiRouter = (server: FastifyInstance) => {
  // Add CORS headers for all routes
  server.addHook('onRequest', async (request, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  });

  /**
   * Health check endpoint
   */
  server.get("/api/health", async (request, reply) => {
    return { status: "ok", timestamp: Date.now() };
  });

  /**
   * Get open lobbies (for lobby list)
   */
  server.get("/open_lobbies", async (request, reply) => {
    const { page = 0, count = 10 } = request.query as { page?: number; count?: number };

    const db = getDB();
    const offset = page * count;

    const result = await db.query(`
      SELECT
        l.lobby_id,
        l.lobby_name,
        l.max_players,
        l.status,
        l.created_at,
        (SELECT COUNT(*) FROM lobby_players WHERE lobby_id = l.lobby_id) as player_count
      FROM lobbies l
      WHERE l.status = 'open'
      ORDER BY l.created_at DESC
      LIMIT $1 OFFSET $2
    `, [count, offset]);

    return {
      lobbies: result.rows,
    };
  });

  /**
   * Get user's lobbies
   */
  server.get("/user_lobbies", async (request, reply) => {
    const { wallet, page = 0, count = 10 } = request.query as {
      wallet: string;
      page?: number;
      count?: number;
    };

    const db = getDB();
    const offset = page * count;

    // Get account ID from wallet address via effectstream.addresses
    const accountResult = await db.query(`
      SELECT account_id FROM effectstream.addresses WHERE address = $1
    `, [wallet]);

    if (accountResult.rows.length === 0) {
      return { lobbies: [] };
    }

    const accountId = accountResult.rows[0].account_id;

    const result = await db.query(`
      SELECT
        l.lobby_id,
        l.lobby_name,
        l.max_players,
        l.status,
        l.created_at,
        (SELECT COUNT(*) FROM lobby_players WHERE lobby_id = l.lobby_id) as player_count
      FROM lobbies l
      INNER JOIN lobby_players lp ON l.lobby_id = lp.lobby_id
      WHERE lp.account_id = $1
      ORDER BY l.created_at DESC
      LIMIT $2 OFFSET $3
    `, [accountId, count, offset]);

    return {
      lobbies: result.rows,
    };
  });

  /**
   * Get lobby state
   */
  server.get("/lobby_state", async (request, reply) => {
    const { lobby_id } = request.query as { lobby_id: string };

    const db = getDB();

    // Get lobby info
    const lobbyResult = await db.query(`
      SELECT
        l.lobby_id,
        l.lobby_name,
        l.host_account_id,
        l.max_players,
        l.status,
        l.created_at,
        l.started_at
      FROM lobbies l
      WHERE l.lobby_id = $1
    `, [lobby_id]);

    if (lobbyResult.rows.length === 0) {
      return reply.code(404).send({ error: 'Lobby not found' });
    }

    const lobby = lobbyResult.rows[0];

    // Get lobby players
    const playersResult = await db.query(`
      SELECT
        lp.account_id,
        lp.player_name,
        lp.is_ready,
        lp.joined_at,
        addr.address as wallet_address
      FROM lobby_players lp
      INNER JOIN effectstream.addresses addr ON lp.account_id = addr.account_id
      WHERE lp.lobby_id = $1
      ORDER BY lp.joined_at ASC
    `, [lobby_id]);

    return {
      ...lobby,
      players: playersResult.rows,
    };
  });

  console.log("✓ Game API routes registered");
};

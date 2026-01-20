/**
 * API Router - Defines REST API endpoints for the game
 */

import type { FastifyInstance } from "fastify";
import type { StartConfigApiRouter } from "@paimaexample/runtime";
import type { Pool } from "pg";
import pg from "pg";
import {
  getGameState as getMidnightGameState,
  queryHasMaskApplied,
  queryHasDealt,
} from "./midnight-query.ts";
import {
  getPlayerHand as getMidnightPlayerHand,
  askForCard as midnightAskForCard,
  goFish as midnightGoFish,
  applyMask as midnightApplyMask,
  dealCards as midnightDealCards,
  respondToAsk as midnightRespondToAsk,
  afterGoFish as midnightAfterGoFish,
} from "./midnight-actions.ts";

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

// Rank names for display
const RANK_NAMES = ['Ace', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'Jack', 'Queen', 'King'];

/**
 * Build dynamic game log based on current game state
 */
function buildGameLog(
  midnightState: {
    phase: string;
    currentTurn: number;
    scores: [number, number];
    lastAskedRank: number | null;
    lastAskingPlayer: number | null;
    isGameOver: boolean;
  },
  players: Array<{ account_id: number; player_name: string }>
): string[] {
  const log: string[] = ['Game started'];

  // Get player names (default to "Player 1" / "Player 2" if not found)
  const player1Name = players[0]?.player_name || 'Player 1';
  const player2Name = players[1]?.player_name || 'Player 2';
  const getPlayerName = (id: number) => id === 1 ? player1Name : player2Name;
  const getOpponentName = (id: number) => id === 1 ? player2Name : player1Name;

  // Add phase-specific log entries
  if (midnightState.lastAskedRank !== null && midnightState.lastAskingPlayer !== null) {
    const askerName = getPlayerName(midnightState.lastAskingPlayer);
    const targetName = getOpponentName(midnightState.lastAskingPlayer);
    const rankName = RANK_NAMES[midnightState.lastAskedRank] || `rank ${midnightState.lastAskedRank}`;

    switch (midnightState.phase) {
      case 'wait_response':
        log.push(`${askerName} asked ${targetName} for ${rankName}s`);
        log.push(`Waiting for ${targetName} to respond...`);
        break;
      case 'wait_transfer':
        log.push(`${askerName} asked ${targetName} for ${rankName}s`);
        log.push(`${targetName} has ${rankName}s! Transferring cards...`);
        break;
      case 'wait_draw':
        log.push(`${askerName} asked ${targetName} for ${rankName}s`);
        log.push(`${targetName} says "Go Fish!"`);
        log.push(`${askerName} is drawing from the deck...`);
        break;
      case 'wait_draw_check':
        log.push(`${askerName} asked ${targetName} for ${rankName}s`);
        log.push(`${targetName} says "Go Fish!"`);
        log.push(`${askerName} drew a card. Checking if it matches...`);
        break;
      case 'turn_start':
        // If there's a last asked rank, show what happened last turn
        if (midnightState.currentTurn !== midnightState.lastAskingPlayer) {
          // Turn switched, so the last ask didn't get the card from draw
          log.push(`${askerName} asked for ${rankName}s but didn't get any`);
        }
        log.push(`${getPlayerName(midnightState.currentTurn)}'s turn`);
        break;
      default:
        log.push(`${getPlayerName(midnightState.currentTurn)}'s turn`);
    }
  } else {
    // No pending ask, just show whose turn it is
    if (midnightState.phase === 'finished') {
      const winner = midnightState.scores[0] > midnightState.scores[1] ? player1Name :
                     midnightState.scores[1] > midnightState.scores[0] ? player2Name : 'Tie';
      log.push(`Game Over! ${winner === 'Tie' ? "It's a tie!" : `${winner} wins!`}`);
      log.push(`Final scores: ${player1Name}: ${midnightState.scores[0]}, ${player2Name}: ${midnightState.scores[1]}`);
    } else if (midnightState.phase !== 'dealing') {
      log.push(`${getPlayerName(midnightState.currentTurn)}'s turn`);
    }
  }

  return log;
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
        l.host_account_id,
        (SELECT COUNT(*) FROM lobby_players WHERE lobby_id = l.lobby_id) as player_count,
        (SELECT player_name FROM lobby_players WHERE lobby_id = l.lobby_id AND account_id = l.host_account_id LIMIT 1) as host_name
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

  /**
   * Get game state for an in-progress game
   * Returns player-specific view (only your own hand visible)
   */
  server.get("/game_state", async (request, reply) => {
    const { lobby_id, wallet } = request.query as { lobby_id: string; wallet: string };

    if (!lobby_id || !wallet) {
      return reply.code(400).send({ error: 'Missing lobby_id or wallet parameter' });
    }

    const db = getDB();

    // Get lobby info to verify it's in_progress
    const lobbyResult = await db.query(`
      SELECT
        l.lobby_id,
        l.lobby_name,
        l.host_account_id,
        l.max_players,
        l.status,
        l.started_at
      FROM lobbies l
      WHERE l.lobby_id = $1
    `, [lobby_id]);

    if (lobbyResult.rows.length === 0) {
      return reply.code(404).send({ error: 'Lobby not found' });
    }

    const lobby = lobbyResult.rows[0];

    if (lobby.status !== 'in_progress') {
      return reply.code(400).send({ error: 'Game not in progress' });
    }

    // Get account ID from wallet address
    const accountResult = await db.query(`
      SELECT account_id FROM effectstream.addresses WHERE address = $1
    `, [wallet]);

    if (accountResult.rows.length === 0) {
      return reply.code(403).send({ error: 'Player not found' });
    }

    const accountId = accountResult.rows[0].account_id;

    // Get all players in the lobby
    const playersResult = await db.query(`
      SELECT
        lp.account_id,
        lp.player_name,
        addr.address as wallet_address
      FROM lobby_players lp
      INNER JOIN effectstream.addresses addr ON lp.account_id = addr.account_id
      WHERE lp.lobby_id = $1
      ORDER BY lp.joined_at ASC
    `, [lobby_id]);

    const players = playersResult.rows;

    // Determine player IDs (host = player1, first joiner = player2)
    const currentPlayerId = players.findIndex((p: any) => p.account_id === accountId) + 1;

    if (currentPlayerId === 0) {
      return reply.code(403).send({ error: 'Player not in this game' });
    }

    // Only query Midnight contract if game has started (prevents mutex deadlocks during lobby creation)
    let midnightState;
    if (lobby.status === 'in_progress') {
      midnightState = await getMidnightGameState(lobby_id);
    } else {
      // Use default values for lobby that hasn't started yet
      midnightState = {
        phase: 'waiting',
        currentTurn: 1,
        scores: [0, 0],
        handSizes: [0, 0],
        deckCount: 52,
        isGameOver: false,
      };
    }

    return {
      lobbyId: lobby_id,
      lobbyName: lobby.lobby_name,
      status: lobby.status,
      startedAt: lobby.started_at,

      // Player info
      playerId: currentPlayerId,
      players: players.map((p: any) => ({
        accountId: p.account_id,
        name: p.player_name,
        walletAddress: p.wallet_address,
      })),

      // Game state from Midnight contract
      phase: midnightState.phase,
      currentTurn: midnightState.currentTurn,
      scores: midnightState.scores,
      handSizes: midnightState.handSizes,
      deckCount: midnightState.deckCount,
      isGameOver: midnightState.isGameOver,

      // Player-specific private state (TODO: query from Midnight)
      // Frontend will decrypt using player's secret key
      myHand: [], // TODO: Query player's semi-masked cards from contract
      myBooks: [], // TODO: Calculate from player's completed books

      // Dynamic game log based on current state
      gameLog: buildGameLog(midnightState, players),
    };
  });

  /**
   * Midnight Actions API - Backend proxy for Midnight contract calls
   */

  // Get player's decrypted hand
  server.get("/api/midnight/player_hand", async (request, reply) => {
    const { lobby_id, player_id } = request.query as { lobby_id: string; player_id: string };

    if (!lobby_id || !player_id) {
      return reply.code(400).send({ error: 'Missing lobby_id or player_id' });
    }

    const playerId = parseInt(player_id) as 1 | 2;
    if (playerId !== 1 && playerId !== 2) {
      return reply.code(400).send({ error: 'Invalid player_id (must be 1 or 2)' });
    }

    const hand = await getMidnightPlayerHand(lobby_id, playerId);
    return { hand };
  });

  // Ask for card action
  server.post("/api/midnight/ask_for_card", async (request, reply) => {
    const { lobby_id, player_id, rank } = request.body as {
      lobby_id: string;
      player_id: number;
      rank: number;
    };

    if (!lobby_id || !player_id || rank === undefined) {
      return reply.code(400).send({ error: 'Missing required fields' });
    }

    const playerId = player_id as 1 | 2;
    if (playerId !== 1 && playerId !== 2) {
      return reply.code(400).send({ error: 'Invalid player_id (must be 1 or 2)' });
    }

    const result = await midnightAskForCard(lobby_id, playerId, rank);
    return result;
  });

  // Go Fish action
  server.post("/api/midnight/go_fish", async (request, reply) => {
    const { lobby_id, player_id } = request.body as {
      lobby_id: string;
      player_id: number;
    };

    if (!lobby_id || !player_id) {
      return reply.code(400).send({ error: 'Missing required fields' });
    }

    const playerId = player_id as 1 | 2;
    if (playerId !== 1 && playerId !== 2) {
      return reply.code(400).send({ error: 'Invalid player_id (must be 1 or 2)' });
    }

    const result = await midnightGoFish(lobby_id, playerId);
    return result;
  });

  // Apply Mask action (setup phase)
  server.post("/api/midnight/apply_mask", async (request, reply) => {
    const { lobby_id, player_id } = request.body as {
      lobby_id: string;
      player_id: number;
    };

    if (!lobby_id || !player_id) {
      return reply.code(400).send({ error: 'Missing required fields' });
    }

    const playerId = player_id as 1 | 2;
    if (playerId !== 1 && playerId !== 2) {
      return reply.code(400).send({ error: 'Invalid player_id (must be 1 or 2)' });
    }

    const result = await midnightApplyMask(lobby_id, playerId);
    return result;
  });

  // Deal Cards action (setup phase)
  server.post("/api/midnight/deal_cards", async (request, reply) => {
    const { lobby_id, player_id } = request.body as {
      lobby_id: string;
      player_id: number;
    };

    if (!lobby_id || !player_id) {
      return reply.code(400).send({ error: 'Missing required fields' });
    }

    const playerId = player_id as 1 | 2;
    if (playerId !== 1 && playerId !== 2) {
      return reply.code(400).send({ error: 'Invalid player_id (must be 1 or 2)' });
    }

    const result = await midnightDealCards(lobby_id, playerId);
    return result;
  });

  // Respond to ask action (opponent responds to card request)
  server.post("/api/midnight/respond_to_ask", async (request, reply) => {
    const { lobby_id, player_id } = request.body as {
      lobby_id: string;
      player_id: number;
    };

    if (!lobby_id || !player_id) {
      return reply.code(400).send({ error: 'Missing required fields' });
    }

    const playerId = player_id as 1 | 2;
    if (playerId !== 1 && playerId !== 2) {
      return reply.code(400).send({ error: 'Invalid player_id (must be 1 or 2)' });
    }

    const result = await midnightRespondToAsk(lobby_id, playerId);
    return result;
  });

  // After Go Fish action (complete the draw turn)
  server.post("/api/midnight/after_go_fish", async (request, reply) => {
    const { lobby_id, player_id, drew_requested_card } = request.body as {
      lobby_id: string;
      player_id: number;
      drew_requested_card: boolean;
    };

    if (!lobby_id || !player_id || drew_requested_card === undefined) {
      return reply.code(400).send({ error: 'Missing required fields' });
    }

    const playerId = player_id as 1 | 2;
    if (playerId !== 1 && playerId !== 2) {
      return reply.code(400).send({ error: 'Invalid player_id (must be 1 or 2)' });
    }

    const result = await midnightAfterGoFish(lobby_id, playerId, drew_requested_card);
    return result;
  });

  // Check setup status (for automatic setup coordination)
  server.get("/api/midnight/setup_status", async (request, reply) => {
    const { lobby_id, player_id } = request.query as {
      lobby_id: string;
      player_id: string;
    };

    if (!lobby_id || !player_id) {
      return reply.code(400).send({ error: 'Missing required fields' });
    }

    const playerId = parseInt(player_id) as 1 | 2;
    if (playerId !== 1 && playerId !== 2) {
      return reply.code(400).send({ error: 'Invalid player_id (must be 1 or 2)' });
    }

    const hasMaskApplied = await queryHasMaskApplied(lobby_id, playerId);
    const hasDealt = await queryHasDealt(lobby_id, playerId);

    // Also check opponent's status for coordination
    const opponentId = (playerId === 1 ? 2 : 1) as 1 | 2;
    const opponentHasMaskApplied = await queryHasMaskApplied(lobby_id, opponentId);
    const opponentHasDealt = await queryHasDealt(lobby_id, opponentId);

    return {
      hasMaskApplied,
      hasDealt,
      opponentHasMaskApplied,
      opponentHasDealt,
    };
  });

  console.log("✓ Game API routes registered");
};

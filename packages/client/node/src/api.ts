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
  markMaskApplied,
  markDealtComplete,
  updateGameState,
} from "./midnight-onchain.ts";
import {
  getPlayerHand as getMidnightPlayerHand,
  askForCard as midnightAskForCard,
  goFish as midnightGoFish,
  applyMask as midnightApplyMask,
  dealCards as midnightDealCards,
  respondToAsk as midnightRespondToAsk,
  afterGoFish as midnightAfterGoFish,
  skipDrawDeckEmpty as midnightSkipDrawDeckEmpty,
} from "./midnight-actions.ts";

// Global database connection pool
let dbPool: Pool | null = null;

// Get database connection - initialize on first call
function getDB(): Pool {
  if (!dbPool) {
    const dbUrl = Deno.env.get("DATABASE_URL");
    if (dbUrl) {
      dbPool = new pg.Pool({ connectionString: dbUrl });
    } else {
      // Fall back to individual env vars (DB_HOST, DB_NAME, DB_USER, DB_PW)
      dbPool = new pg.Pool({
        host: Deno.env.get("DB_HOST") || "localhost",
        port: Number(Deno.env.get("DB_PORT") || "5432"),
        database: Deno.env.get("DB_NAME") || "go-fish",
        user: Deno.env.get("DB_USER"),
        password: Deno.env.get("DB_PW"),
      });
    }
  }
  return dbPool;
}

// Rank names for display - simplified deck (7 ranks)
const RANK_NAMES = ['Ace', '2', '3', '4', '5', '6', '7'];

/**
 * Persistent game log storage - maintains full log history per game
 * Key: lobbyId, Value: { logs: string[], lastState: state snapshot }
 */
interface GameLogState {
  logs: string[];
  lastPhase: string | null;
  lastTurn: number | null;
  lastAskedRank: number | null;
  lastAskingPlayer: number | null;
  lastScores: [number, number];
  playerNames: [string, string];
}

const gameLogStorage = new Map<string, GameLogState>();

/**
 * Get or initialize game log state
 */
function getGameLogState(lobbyId: string, players: Array<{ player_name: string }>): GameLogState {
  let state = gameLogStorage.get(lobbyId);
  if (!state) {
    const player1Name = players[0]?.player_name || 'Player 1';
    const player2Name = players[1]?.player_name || 'Player 2';
    state = {
      logs: ['Game started'],
      lastPhase: null,
      lastTurn: null,
      lastAskedRank: null,
      lastAskingPlayer: null,
      lastScores: [0, 0],
      playerNames: [player1Name, player2Name],
    };
    gameLogStorage.set(lobbyId, state);
  }
  return state;
}

/**
 * Update game log based on state changes (appends new entries)
 */
function updateGameLog(
  lobbyId: string,
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
  const state = getGameLogState(lobbyId, players);
  const [player1Name, player2Name] = state.playerNames;
  const getPlayerName = (id: number) => id === 1 ? player1Name : player2Name;
  const getOpponentName = (id: number) => id === 1 ? player2Name : player1Name;

  // Detect state changes and append appropriate log entries
  const phaseChanged = state.lastPhase !== midnightState.phase;
  const turnChanged = state.lastTurn !== midnightState.currentTurn;
  const askChanged = state.lastAskedRank !== midnightState.lastAskedRank ||
                     state.lastAskingPlayer !== midnightState.lastAskingPlayer;

  // Handle phase transitions
  if (phaseChanged || askChanged) {
    const askerName = midnightState.lastAskingPlayer ? getPlayerName(midnightState.lastAskingPlayer) : null;
    const targetName = midnightState.lastAskingPlayer ? getOpponentName(midnightState.lastAskingPlayer) : null;
    const rankName = midnightState.lastAskedRank !== null
      ? RANK_NAMES[midnightState.lastAskedRank] || `rank ${midnightState.lastAskedRank}`
      : null;

    // Log new ask action
    if (askChanged && midnightState.lastAskedRank !== null && midnightState.phase === 'wait_response') {
      state.logs.push(`${askerName} asked ${targetName} for ${rankName}s`);
    }

    // Log response/go fish events based on phase transitions
    if (phaseChanged && state.lastPhase === 'wait_response') {
      if (midnightState.phase === 'wait_transfer') {
        state.logs.push(`${targetName} has ${rankName}s!`);
      } else if (midnightState.phase === 'wait_draw') {
        state.logs.push(`${targetName} says "Go Fish!"`);
      }
    }

    // Log draw event
    if (phaseChanged && state.lastPhase === 'wait_draw' && midnightState.phase === 'wait_draw_check') {
      state.logs.push(`${askerName} drew a card from the deck`);
    }

    // Log transfer completion
    if (phaseChanged && state.lastPhase === 'wait_transfer' && midnightState.phase === 'turn_start') {
      const prevAskerName = state.lastAskingPlayer ? getPlayerName(state.lastAskingPlayer) : askerName;
      const prevRankName = state.lastAskedRank !== null
        ? RANK_NAMES[state.lastAskedRank] || `rank ${state.lastAskedRank}`
        : rankName;
      state.logs.push(`${prevAskerName} received ${prevRankName}s!`);
    }

    // Log turn change after go fish
    if (phaseChanged && state.lastPhase === 'wait_draw_check' && midnightState.phase === 'turn_start') {
      const prevAskerName = state.lastAskingPlayer ? getPlayerName(state.lastAskingPlayer) : null;
      if (turnChanged && prevAskerName) {
        state.logs.push(`${prevAskerName} didn't get the requested card`);
      } else if (!turnChanged && prevAskerName) {
        state.logs.push(`${prevAskerName} got the requested card! Another turn!`);
      }
    }

    // Log turn changes
    if (turnChanged && midnightState.phase === 'turn_start') {
      state.logs.push(`${getPlayerName(midnightState.currentTurn)}'s turn`);
    }

    // Log game over
    if (midnightState.isGameOver && state.lastPhase !== 'finished' && midnightState.phase === 'finished') {
      const winner = midnightState.scores[0] > midnightState.scores[1] ? player1Name :
                     midnightState.scores[1] > midnightState.scores[0] ? player2Name : 'Tie';
      state.logs.push(`Game Over! ${winner === 'Tie' ? "It's a tie!" : `${winner} wins!`}`);
      state.logs.push(`Final scores: ${player1Name}: ${midnightState.scores[0]}, ${player2Name}: ${midnightState.scores[1]}`);
    }
  }

  // Log book completions (score changes)
  if (state.lastScores) {
    const player1ScoreDiff = midnightState.scores[0] - state.lastScores[0];
    const player2ScoreDiff = midnightState.scores[1] - state.lastScores[1];

    if (player1ScoreDiff > 0) {
      state.logs.push(`📚 ${player1Name} completed a book! (${midnightState.scores[0]} total)`);
    }
    if (player2ScoreDiff > 0) {
      state.logs.push(`📚 ${player2Name} completed a book! (${midnightState.scores[1]} total)`);
    }
  }

  // Update tracked state
  state.lastPhase = midnightState.phase;
  state.lastTurn = midnightState.currentTurn;
  state.lastAskedRank = midnightState.lastAskedRank;
  state.lastAskingPlayer = midnightState.lastAskingPlayer;
  state.lastScores = [...midnightState.scores] as [number, number];

  // Note: No limit on log size - a typical Go Fish game has ~100-200 log entries
  // which is negligible memory usage. The log is cleared when the game ends.

  return [...state.logs]; // Return a copy
}

/**
 * Clear game log (call when game ends or lobby is deleted)
 */
export function clearGameLog(lobbyId: string): void {
  gameLogStorage.delete(lobbyId);
}

// Check if we're using the TypeScript-compiled contract (mock mode)
// First check env var, then fall back to runtime config file written by orchestrator
function getUseTypescriptContract(): boolean {
  // Check env var first
  const envValue = Deno.env.get("USE_TYPESCRIPT_CONTRACT");
  if (envValue !== undefined) {
    const result = envValue === "true";
    console.log(`[API] USE_TYPESCRIPT_CONTRACT from env: "${envValue}" -> mock mode: ${result}`);
    return result;
  }

  // Fall back to runtime config file (written by start.dev.ts)
  try {
    const configPath = new URL("../runtime-config.json", import.meta.url);
    const configText = Deno.readTextFileSync(configPath);
    const config = JSON.parse(configText);
    const result = config.useTypescriptContract === true;
    console.log(`[API] USE_TYPESCRIPT_CONTRACT from config file -> mock mode: ${result}`);
    return result;
  } catch {
    // Config file doesn't exist or is invalid - default to production mode
    console.log(`[API] USE_TYPESCRIPT_CONTRACT: no env or config file -> mock mode: false (production default)`);
    return false;
  }
}

const USE_TYPESCRIPT_CONTRACT = getUseTypescriptContract();

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
   * Config endpoint - tells frontend which mode we're running in
   * USE_TYPESCRIPT_CONTRACT=true: Mock mode, only EVM wallet needed
   * USE_TYPESCRIPT_CONTRACT=false: Production mode, both EVM and Lace wallets needed
   */
  server.get("/api/config", async (request, reply) => {
    return {
      useMockedMidnight: USE_TYPESCRIPT_CONTRACT,
      requiresLaceWallet: !USE_TYPESCRIPT_CONTRACT,
      requiresEvmWallet: true, // Always need EVM for Paima Engine
    };
  });

  /**
   * Get deployed contract address (for on-chain mode)
   * Returns the Midnight contract address if a deployment file exists
   */
  server.get("/api/midnight/contract_address", async (request, reply) => {
    try {
      // Try to read the deployment file
      const deploymentPath = new URL(
        "../../../shared/contracts/midnight/contract-go-fish.undeployed.json",
        import.meta.url
      );
      const deploymentText = await Deno.readTextFile(deploymentPath);
      const deployment = JSON.parse(deploymentText);
      return {
        contractAddress: deployment.contractAddress || null,
        networkId: deployment.networkId || "undeployed",
      };
    } catch {
      // No deployment file exists yet
      return {
        contractAddress: null,
        networkId: null,
        message: "Contract not deployed. Run: deno task midnight:deploy",
      };
    }
  });

  /**
   * Get open lobbies (for lobby list)
   */
  server.get("/open_lobbies", async (request, reply) => {
    const { page = 0, count = 10, wallet } = request.query as { page?: number; count?: number; wallet?: string };

    const db = getDB();
    const offset = page * count;

    try {
      // Get account ID from wallet if provided (to check membership)
      let accountId: number | null = null;
      if (wallet) {
        const accountResult = await db.query(`
          SELECT account_id FROM effectstream.addresses WHERE address = $1
        `, [wallet]);
        if (accountResult.rows.length > 0) {
          accountId = accountResult.rows[0].account_id;
        }
      }

      // Query lobbies with optional membership check
      const result = await db.query(`
        SELECT
          l.lobby_id,
          l.lobby_name,
          l.max_players,
          l.status,
          l.created_at,
          l.host_account_id,
          (SELECT COUNT(*) FROM lobby_players WHERE lobby_id = l.lobby_id) as player_count,
          (SELECT player_name FROM lobby_players WHERE lobby_id = l.lobby_id AND account_id = l.host_account_id LIMIT 1) as host_name,
          ${accountId !== null ? `EXISTS(SELECT 1 FROM lobby_players WHERE lobby_id = l.lobby_id AND account_id = ${accountId})` : 'false'} as is_player_in_lobby
        FROM lobbies l
        WHERE l.status = 'open'
        ORDER BY l.created_at DESC
        LIMIT $1 OFFSET $2
      `, [count, offset]);

      return {
        lobbies: result.rows,
      };
    } catch (error) {
      // Table may not exist yet on fresh start (created by first state transition)
      console.warn('open_lobbies query failed (table may not exist yet):', (error as Error).message);
      return { lobbies: [] };
    }
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
    // Use a subquery to pick one address per account, avoiding duplicate rows
    // when an account has multiple entries in effectstream.addresses (which
    // happens when Paima auto-tracks the sender address AND our state machine
    // also creates an address record).
    const playersResult = await db.query(`
      SELECT
        lp.account_id,
        lp.player_name,
        lp.is_ready,
        lp.joined_at,
        (SELECT addr.address FROM effectstream.addresses addr
         WHERE addr.account_id = lp.account_id LIMIT 1) as wallet_address
      FROM lobby_players lp
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
    // Use subquery to avoid duplicates from multiple address entries per account
    const playersResult = await db.query(`
      SELECT
        lp.account_id,
        lp.player_name,
        (SELECT addr.address FROM effectstream.addresses addr
         WHERE addr.account_id = lp.account_id LIMIT 1) as wallet_address
      FROM lobby_players lp
      WHERE lp.lobby_id = $1
      ORDER BY lp.joined_at ASC
    `, [lobby_id]);

    const players = playersResult.rows;

    // Determine player IDs (host = player1, first joiner = player2)
    const currentPlayerId = players.findIndex((p: any) => p.account_id === accountId) + 1;
    console.log(`[API] game_state: wallet=${wallet}, accountId=${accountId}, playerId=${currentPlayerId}, players=${JSON.stringify(players.map((p: any) => ({ id: p.account_id, addr: p.wallet_address })))}`);

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

      // Dynamic game log - persisted across state changes
      gameLog: updateGameLog(lobby_id, midnightState, players),
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

  // Skip draw when deck is empty - ends turn without drawing
  server.post("/api/midnight/skip_draw_deck_empty", async (request, reply) => {
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

    const result = await midnightSkipDrawDeckEmpty(lobby_id, playerId);
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

  // Notify setup complete (called by frontend after batcher transaction succeeds)
  server.post("/api/midnight/notify_setup", async (request, reply) => {
    const { lobby_id, player_id, action } = request.body as {
      lobby_id: string;
      player_id: number;
      action: "mask_applied" | "dealt_complete";
    };

    if (!lobby_id || !player_id || !action) {
      return reply.code(400).send({ error: 'Missing required fields' });
    }

    const playerId = player_id as 1 | 2;
    if (playerId !== 1 && playerId !== 2) {
      return reply.code(400).send({ error: 'Invalid player_id (must be 1 or 2)' });
    }

    if (action !== "mask_applied" && action !== "dealt_complete") {
      return reply.code(400).send({ error: 'Invalid action' });
    }

    // Update local state tracking
    if (action === "mask_applied") {
      markMaskApplied(lobby_id, playerId);
    } else if (action === "dealt_complete") {
      markDealtComplete(lobby_id, playerId);
    }

    console.log(`[API] Setup notification received: ${action} for lobby ${lobby_id} player ${playerId}`);
    return { success: true };
  });

  // Notify game action complete (called by frontend after batcher transaction succeeds)
  server.post("/api/midnight/notify_game_action", async (request, reply) => {
    const { lobby_id, player_id, action, rank, hasCards, cardCount, drewRequestedCard } = request.body as {
      lobby_id: string;
      player_id: number;
      action: "ask_for_card" | "respond_to_ask" | "go_fish" | "after_go_fish";
      rank?: number;
      hasCards?: boolean;
      cardCount?: number;
      drewRequestedCard?: boolean;
    };

    if (!lobby_id || !player_id || !action) {
      return reply.code(400).send({ error: 'Missing required fields' });
    }

    const playerId = player_id as 1 | 2;
    if (playerId !== 1 && playerId !== 2) {
      return reply.code(400).send({ error: 'Invalid player_id (must be 1 or 2)' });
    }

    const opponentId = playerId === 1 ? 2 : 1;

    // Update game state based on action
    switch (action) {
      case "ask_for_card":
        // After asking, it's the opponent's turn to respond
        // Phase changes to "wait_response" (frontend expects this name)
        updateGameState(lobby_id, {
          phase: "wait_response",
          lastAskedRank: rank ?? null,
          lastAskingPlayer: playerId,
        });
        console.log(`[API] Game action: ${playerId} asked for rank ${rank} in lobby ${lobby_id}`);
        break;

      case "respond_to_ask":
        // After responding, check if cards were given
        // If no cards (Go Fish), phase changes to "wait_draw"
        // If cards given, turn goes back to asking player, phase = "turn_start"
        if (hasCards && cardCount && cardCount > 0) {
          // Cards transferred, asking player gets another turn
          updateGameState(lobby_id, {
            phase: "turn_start",
            // currentTurn stays the same (asking player)
          });
          console.log(`[API] Game action: ${playerId} gave ${cardCount} cards in lobby ${lobby_id}`);
        } else {
          // No cards - Go Fish (asking player must draw)
          updateGameState(lobby_id, {
            phase: "wait_draw",  // Frontend expects "wait_draw" for Go Fish
          });
          console.log(`[API] Game action: ${playerId} said Go Fish in lobby ${lobby_id}`);
        }
        break;

      case "go_fish":
        // After drawing from deck, check if it matches
        updateGameState(lobby_id, {
          phase: "wait_draw_check",  // Frontend expects "wait_draw_check"
        });
        console.log(`[API] Game action: ${playerId} drew from deck in lobby ${lobby_id}`);
        break;

      case "after_go_fish":
        // After completing go fish, check if drew requested card
        if (drewRequestedCard) {
          // Drew requested card, get another turn
          updateGameState(lobby_id, {
            phase: "turn_start",
            // currentTurn stays the same
          });
          console.log(`[API] Game action: ${playerId} drew requested card, gets another turn`);
        } else {
          // Didn't draw requested card, turn switches
          updateGameState(lobby_id, {
            phase: "turn_start",
            currentTurn: opponentId,
          });
          console.log(`[API] Game action: Turn switches to player ${opponentId} in lobby ${lobby_id}`);
        }
        break;

      default:
        return reply.code(400).send({ error: 'Invalid action' });
    }

    return { success: true };
  });

  console.log("✓ Game API routes registered");
};

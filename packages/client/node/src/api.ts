/**
 * API Router - Defines REST API endpoints for the game
 */

import type { FastifyInstance } from "fastify";
import type { StartConfigApiRouter } from "@paimaexample/runtime";
import type { Pool } from "pg";
import {
  getGameState as getMidnightGameState,
  queryHasMaskApplied,
  queryHasDealt,
} from "./midnight-query.ts";
import {
  markMaskApplied,
  markDealtComplete,
  isValidLobbyId,
  queryOnChainSetupStatuses,
} from "./midnight-onchain.ts";
import {
  getPlayerHand as getMidnightPlayerHand,
  getPlayerHandWithSecret as getMidnightPlayerHandWithSecret,
  ensureGameReplayedIfNeeded as midnightEnsureGameReplayedIfNeeded,
  askForCard as midnightAskForCard,
  goFish as midnightGoFish,
  applyMask as midnightApplyMask,
  dealCards as midnightDealCards,
  respondToAsk as midnightRespondToAsk,
  afterGoFish as midnightAfterGoFish,
  skipDrawDeckEmpty as midnightSkipDrawDeckEmpty,
  getStoredPlayerSecret,
  getStoredShuffleSeed,
  storePlayerSecret,
} from "./midnight-actions.ts";
import { calculateAndPersistScores } from "./leaderboard.ts";

// Database connection pool - set by apiRouter from the runtime-provided connection
let dbPool: Pool | null = null;

// Rank names for display — must match the Rank type in go-fish-types.ts
const RANK_NAMES = ['A', '2', '3', '4', '5', '6', '7'] as const;

/**
 * Parse and validate a player_id parameter from an API request.
 * Returns 1 | 2 or null (caller must return 400 when null).
 */
function parsePlayerId(raw: unknown): 1 | 2 | null {
  const n = parseInt(String(raw), 10);
  return n === 1 || n === 2 ? n : null;
}

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

// Tracks lobbies where leaderboard scores have already been persisted.
// Prevents double-counting when multiple game_state polls see phase="finished".
const leaderboardProcessed = new Set<string>();

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

      // Fire-and-forget leaderboard scoring (deduplicated — only runs once per game)
      if (dbPool && !leaderboardProcessed.has(lobbyId)) {
        leaderboardProcessed.add(lobbyId);
        const winnerPlayerId = midnightState.scores[0] > midnightState.scores[1] ? 1
                             : midnightState.scores[1] > midnightState.scores[0] ? 2 : 0;
        if (winnerPlayerId !== 0) {
          calculateAndPersistScores(lobbyId, winnerPlayerId as 1 | 2, Date.now(), dbPool)
            .catch(err => console.error('[leaderboard] Score persistence failed:', err));
        }
      }
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

export const apiRouter: StartConfigApiRouter = async (server: FastifyInstance, dbConn: Pool) => {
  // Use the runtime-provided database connection (works with PGLite in dev mode)
  dbPool = dbConn;
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
   * Global leaderboard — top players by total points across all games
   */
  server.get<{ Querystring: { limit?: string; offset?: string } }>(
    "/api/leaderboard",
    async (request, reply) => {
      if (!dbPool) {
        return reply.code(503).send({ error: 'Database not ready' });
      }
      const limit = Math.min(Number(request.query.limit ?? 50), 100);
      const offset = Number(request.query.offset ?? 0);
      try {
        const result = await dbPool.query<{
          midnight_address: string;
          total_points: string;
          games_played: number;
          games_won: number;
        }>(
          `SELECT midnight_address, total_points, games_played, games_won
           FROM go_fish_leaderboard
           ORDER BY total_points DESC
           LIMIT $1 OFFSET $2`,
          [limit, offset]
        );
        return result.rows.map(r => ({
          midnight_address: r.midnight_address,
          total_points: Number(r.total_points),
          games_played: r.games_played,
          games_won: r.games_won,
        }));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[API] /api/leaderboard error:', message);
        return reply.code(500).send({ error: message });
      }
    }
  );

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

    const db = dbPool!;
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

    const db = dbPool!;
    const offset = page * count;

    try {
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
    } catch (error) {
      console.warn('user_lobbies query failed (table may not exist yet):', (error as Error).message);
      return { lobbies: [] };
    }
  });

  /**
   * Get lobby state
   */
  server.get("/lobby_state", async (request, reply) => {
    const { lobby_id } = request.query as { lobby_id: string };

    const db = dbPool!;

    try {
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
    } catch (error) {
      console.warn('lobby_state query failed (table may not exist yet):', (error as Error).message);
      return reply.code(500).send({ error: 'Database error' });
    }
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
    if (!isValidLobbyId(lobby_id)) {
      return reply.code(400).send({ error: 'Invalid lobby_id format' });
    }

    const db = dbPool!;

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
    console.log(`[API] game_state: wallet=${wallet}, playerId=${currentPlayerId}, player_count=${players.length}`);

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
      lastAskedRank: midnightState.lastAskedRank ?? null,
      lastAskingPlayer: midnightState.lastAskingPlayer ?? null,

      // Frontend queries the player's hand directly from the Midnight indexer
      myHand: [],
      myBooks: [],

      // Dynamic game log - persisted across state changes
      gameLog: updateGameLog(lobby_id, midnightState, players),
    };
  });

  /**
   * Midnight Actions API - Backend proxy for Midnight contract calls
   */

  // Get the last asked rank for a lobby (public game state — no wallet required).
  // Used by the frontend in batcher mode to determine hasCards for respondToAsk.
  server.get("/api/midnight/last_asked_rank", async (request, reply) => {
    const { lobby_id } = request.query as { lobby_id: string };
    if (!lobby_id || !isValidLobbyId(lobby_id)) {
      return reply.code(400).send({ error: 'Missing or invalid lobby_id' });
    }
    const midnightState = await getMidnightGameState(lobby_id);
    return { lastAskedRank: midnightState.lastAskedRank ?? null };
  });

  // Get player's decrypted hand
  server.get("/api/midnight/player_hand", async (request, reply) => {
    const { lobby_id, player_id } = request.query as { lobby_id: string; player_id: string };

    if (!lobby_id || !player_id) {
      return reply.code(400).send({ error: 'Missing lobby_id or player_id' });
    }

    const playerId = parsePlayerId(player_id);
    if (!playerId) {
      return reply.code(400).send({ error: 'Invalid player_id (must be 1 or 2)' });
    }

    const hand = await getMidnightPlayerHand(lobby_id, playerId);
    return { hand };
  });

  // Get player's real hand using their secret key (batcher mode)
  // The frontend passes its secret so the backend can run doesPlayerHaveSpecificCard
  // with the correct witness. The secret is never persisted — used only for this call.
  server.post("/api/midnight/player_hand_with_secret", async (request, reply) => {
    const { lobby_id, player_id, player_secret, shuffle_seed, opponent_secret, opponent_shuffle_seed } = request.body as {
      lobby_id: string;
      player_id: number;
      player_secret: string;          // hex-encoded bigint, no 0x prefix
      shuffle_seed?: string;          // hex-encoded 32 bytes — used for setup replay
      opponent_secret?: string;       // opponent's secret — used for setup replay
      opponent_shuffle_seed?: string; // opponent's shuffle seed — used for setup replay
    };

    if (!lobby_id || !player_id || !player_secret) {
      return reply.code(400).send({ error: 'Missing lobby_id, player_id, or player_secret' });
    }

    const playerId = parsePlayerId(player_id);
    if (!playerId) {
      return reply.code(400).send({ error: 'Invalid player_id (must be 1 or 2)' });
    }

    // If the local simulation doesn't have this game's state (e.g. node restarted),
    // replay the setup sequence using the provided secrets before querying the hand.
    // This is a no-op when the game is already in the actionContext.
    await midnightEnsureGameReplayedIfNeeded(
      lobby_id,
      playerId,
      player_secret,
      shuffle_seed,
      opponent_secret,
      opponent_shuffle_seed,
    );

    const hand = await getMidnightPlayerHandWithSecret(lobby_id, playerId, player_secret, opponent_secret);
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

    const playerId = parsePlayerId(player_id);
    if (!playerId) {
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

    const playerId = parsePlayerId(player_id);
    if (!playerId) {
      return reply.code(400).send({ error: 'Invalid player_id (must be 1 or 2)' });
    }

    const result = await midnightGoFish(lobby_id, playerId);
    return result;
  });

  // Apply Mask action (setup phase)
  server.post("/api/midnight/apply_mask", async (request, reply) => {
    const { lobby_id, player_id, player_secret, shuffle_seed } = request.body as {
      lobby_id: string;
      player_id: number;
      player_secret?: string;
      shuffle_seed?: string;
    };

    if (!lobby_id || !player_id) {
      return reply.code(400).send({ error: 'Missing required fields' });
    }

    const playerId = parsePlayerId(player_id);
    if (!playerId) {
      return reply.code(400).send({ error: 'Invalid player_id (must be 1 or 2)' });
    }

    const result = await midnightApplyMask(lobby_id, playerId, player_secret, shuffle_seed);
    return result;
  });

  // Deal Cards action (setup phase)
  server.post("/api/midnight/deal_cards", async (request, reply) => {
    const { lobby_id, player_id, player_secret, shuffle_seed } = request.body as {
      lobby_id: string;
      player_id: number;
      player_secret?: string;
      shuffle_seed?: string;
    };

    if (!lobby_id || !player_id) {
      return reply.code(400).send({ error: 'Missing required fields' });
    }

    const playerId = parsePlayerId(player_id);
    if (!playerId) {
      return reply.code(400).send({ error: 'Invalid player_id (must be 1 or 2)' });
    }

    const result = await midnightDealCards(lobby_id, playerId, player_secret, shuffle_seed);
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

    const playerId = parsePlayerId(player_id);
    if (!playerId) {
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

    const playerId = parsePlayerId(player_id);
    if (!playerId) {
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

    const playerId = parsePlayerId(player_id);
    if (!playerId) {
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

    const playerId = parsePlayerId(player_id);
    if (!playerId) {
      return reply.code(400).send({ error: 'Invalid player_id (must be 1 or 2)' });
    }

    let hasMaskApplied = await queryHasMaskApplied(lobby_id, playerId);
    let hasDealt = await queryHasDealt(lobby_id, playerId);

    // Also check opponent's status for coordination
    const opponentId = (playerId === 1 ? 2 : 1) as 1 | 2;
    let opponentHasMaskApplied = await queryHasMaskApplied(lobby_id, opponentId);
    let opponentHasDealt = await queryHasDealt(lobby_id, opponentId);

    // Always cross-check against the real on-chain state via the batcher query.
    // This handles the case where notify_setup was missed (e.g. browser timing, network failure).
    // Run in parallel with the map reads above, so latency is hidden.
    {
      const onChainSetup = await queryOnChainSetupStatuses(lobby_id);
      if (onChainSetup) {
        const [p1Mask, p2Mask] = onChainSetup.maskApplied;
        const [p1Dealt, p2Dealt] = onChainSetup.hasDealt;

        // Back-populate setupStateMap for any player whose on-chain state is ahead of local map
        if (p1Mask && !await queryHasMaskApplied(lobby_id, 1)) {
          markMaskApplied(lobby_id, 1);
          console.log(`[API] setup_status: back-populated maskApplied for lobby=${lobby_id} player=1 from on-chain`);
        }
        if (p2Mask && !await queryHasMaskApplied(lobby_id, 2)) {
          markMaskApplied(lobby_id, 2);
          console.log(`[API] setup_status: back-populated maskApplied for lobby=${lobby_id} player=2 from on-chain`);
        }
        if (p1Dealt && !await queryHasDealt(lobby_id, 1)) {
          markDealtComplete(lobby_id, 1);
          console.log(`[API] setup_status: back-populated hasDealt for lobby=${lobby_id} player=1 from on-chain`);
        }
        if (p2Dealt && !await queryHasDealt(lobby_id, 2)) {
          markDealtComplete(lobby_id, 2);
          console.log(`[API] setup_status: back-populated hasDealt for lobby=${lobby_id} player=2 from on-chain`);
        }

        // Re-read from map after potential updates
        hasMaskApplied = await queryHasMaskApplied(lobby_id, playerId);
        hasDealt = await queryHasDealt(lobby_id, playerId);
        opponentHasMaskApplied = await queryHasMaskApplied(lobby_id, opponentId);
        opponentHasDealt = await queryHasDealt(lobby_id, opponentId);
      }
    }

    console.log(`[API] setup_status response: lobby=${lobby_id} player=${playerId} mask=${hasMaskApplied} dealt=${hasDealt} oppMask=${opponentHasMaskApplied} oppDealt=${opponentHasDealt}`);
    return {
      hasMaskApplied,
      hasDealt,
      opponentHasMaskApplied,
      opponentHasDealt,
    };
  });

  // Get a stored player secret — called by the batcher adapter to retrieve the opponent's
  // secret for circuits that require both players' secrets (askForCard, respondToAsk, etc.).
  // The secret is only available after notify_setup has been processed for this player.
  // This endpoint is intentionally NOT authenticated — it's only reachable from localhost
  // (the batcher runs on the same host as the node).
  server.get("/api/midnight/player_secret", async (request, reply) => {
    const { lobby_id, player_id } = request.query as {
      lobby_id: string;
      player_id: string;
    };

    if (!lobby_id || !player_id) {
      return reply.code(400).send({ error: 'Missing required fields' });
    }

    const playerId = parsePlayerId(player_id);
    if (!playerId) {
      return reply.code(400).send({ error: 'Invalid player_id (must be 1 or 2)' });
    }

    const secret = getStoredPlayerSecret(lobby_id, playerId);
    const shuffleSeed = getStoredShuffleSeed(lobby_id, playerId);

    if (secret === null) {
      return reply.code(404).send({ error: 'No secret stored for this player/game' });
    }

    console.log(`[API] player_secret: returning secret for lobby=${lobby_id} player=${playerId} secret=0x${secret.slice(0, 16)}...`);
    return { secret, shuffleSeed };
  });

  // Register (or refresh) a player's secret outside of setup replay.
  // The frontend calls this on game reconnect / page load so the backend always has
  // the latest secrets for batcher-side proof generation, even after a node restart.
  server.post("/api/midnight/register_secret", async (request, reply) => {
    const { lobby_id, player_id, player_secret, shuffle_seed } = request.body as {
      lobby_id: string;
      player_id: number;
      player_secret: string;   // hex-encoded bigint, no 0x prefix
      shuffle_seed?: string;   // hex-encoded 32 bytes, no 0x prefix
    };

    if (!lobby_id || !player_id || !player_secret) {
      return reply.code(400).send({ error: 'Missing required fields' });
    }

    const playerId = parsePlayerId(player_id);
    if (!playerId) {
      return reply.code(400).send({ error: 'Invalid player_id (must be 1 or 2)' });
    }

    // Store directly in the persistent map (no circuit execution).
    storePlayerSecret(lobby_id, playerId, player_secret, shuffle_seed);

    console.log(`[API] register_secret: stored secret for lobby=${lobby_id} player=${playerId}`);
    return { success: true };
  });

  // Register a player's Midnight shielded address for leaderboard attribution.
  // Called by the frontend on game start so scores can be persisted at game end.
  server.post("/api/midnight/register_address", async (request, reply) => {
    const { lobby_id, player_id, midnight_address } = request.body as {
      lobby_id: string;
      player_id: number;
      midnight_address: string;
    };

    if (!lobby_id || !player_id || !midnight_address) {
      return reply.code(400).send({ error: 'Missing required fields' });
    }

    const playerId = parsePlayerId(player_id);
    if (!playerId) {
      return reply.code(400).send({ error: 'Invalid player_id (must be 1 or 2)' });
    }

    if (!isValidLobbyId(lobby_id)) {
      return reply.code(400).send({ error: 'Invalid lobby_id format' });
    }

    // Midnight shielded addresses are hex strings, 64–200 chars
    if (!/^[0-9a-fA-F]{64,200}$/.test(midnight_address)) {
      return reply.code(400).send({ error: 'Invalid midnight_address format' });
    }

    const db = dbPool!;

    // Determine which account_id corresponds to this player (by join order)
    const playersResult = await db.query<{ account_id: number }>(
      `SELECT account_id FROM lobby_players WHERE lobby_id = $1 ORDER BY joined_at ASC`,
      [lobby_id]
    );
    const target = playersResult.rows[playerId - 1]; // player 1 = index 0
    if (!target) {
      return reply.code(404).send({ error: 'Player not found in lobby' });
    }

    await db.query(
      `UPDATE lobby_players SET midnight_address = $1 WHERE lobby_id = $2 AND account_id = $3`,
      [midnight_address, lobby_id, target.account_id]
    );

    console.log(`[API] register_address: lobby=${lobby_id} player=${playerId} addr=${midnight_address.slice(0, 16)}…`);
    return { success: true };
  });

  // Notify setup complete (called by batcher after on-chain transaction succeeds).
  // When player_secret is included, also replays the circuit on the local actionContract
  // so the node's in-memory state stays in sync with the real Midnight chain state.
  server.post("/api/midnight/notify_setup", async (request, reply) => {
    console.log(`[API] notify_setup RAW body: player_id=${(request.body as any)?.player_id} action=${(request.body as any)?.action} lobby=${(request.body as any)?.lobby_id}`);
    const { lobby_id, player_id, action, player_secret, shuffle_seed, opponent_secret, opponent_shuffle_seed } = request.body as {
      lobby_id: string;
      player_id: number;
      action: "mask_applied" | "dealt_complete";
      player_secret?: string;         // hex-encoded bigint, no 0x prefix
      shuffle_seed?: string;          // hex-encoded 32 bytes, no 0x prefix
      opponent_secret?: string;       // hex-encoded bigint, no 0x prefix
      opponent_shuffle_seed?: string; // hex-encoded 32 bytes, no 0x prefix
    };

    if (!lobby_id || !player_id || !action) {
      return reply.code(400).send({ error: 'Missing required fields' });
    }

    const playerId = parsePlayerId(player_id);
    if (!playerId) {
      return reply.code(400).send({ error: 'Invalid player_id (must be 1 or 2)' });
    }

    if (action !== "mask_applied" && action !== "dealt_complete") {
      return reply.code(400).send({ error: 'Invalid action' });
    }

    const opponentId = (playerId === 1 ? 2 : 1) as 1 | 2;

    // Eagerly store all secrets into persistentSecrets BEFORE the async replay so that
    // fetchSecretFromBackend (called by the batcher for game-phase circuits) can find them
    // immediately, even if the circuit replay queue hasn't started yet.
    if (player_secret) storePlayerSecret(lobby_id, playerId, player_secret, shuffle_seed);
    if (opponent_secret) storePlayerSecret(lobby_id, opponentId, opponent_secret, opponent_shuffle_seed);

    // Update local state tracking
    if (action === "mask_applied") {
      markMaskApplied(lobby_id, playerId);
      console.log(`[API] notify_setup: setupStateMap now has mask=true for lobby=${lobby_id} player=${playerId}`);
      // Replay applyMask on local actionContract so getPlayerHandWithSecret works later.
      // IMPORTANT: the contract requires P1 to act before P2. Always replay P1 first.
      // Pass shuffle seeds so the local simulation's shuffle matches the on-chain transaction.
      const p1Secret = playerId === 1 ? player_secret : opponent_secret;
      const p1Seed = playerId === 1 ? shuffle_seed : opponent_shuffle_seed;
      const p2Secret = playerId === 2 ? player_secret : opponent_secret;
      const p2Seed = playerId === 2 ? shuffle_seed : opponent_shuffle_seed;
      const replayMasks = async () => {
        for (const [pid, sec, seed] of [[1, p1Secret, p1Seed], [2, p2Secret, p2Seed]] as const) {
          if (sec) {
            await midnightApplyMask(lobby_id, pid, sec, seed).catch((err: Error) => {
              console.warn(`[API] Local applyMask P${pid} replay failed (non-critical):`, err?.message);
            });
          }
        }
      };
      replayMasks().catch(() => {});
    } else if (action === "dealt_complete") {
      markDealtComplete(lobby_id, playerId);
      // Replay dealCards on local actionContract so getPlayerHandWithSecret works later.
      // Both player_secret AND shuffle_seed are required for the local replay to produce
      // the same cardOwnership ledger as the real on-chain transaction.
      // IMPORTANT: the contract requires P1 to deal before P2. Always replay P1 first.
      const p1Secret = playerId === 1 ? player_secret : opponent_secret;
      const p1Seed = playerId === 1 ? shuffle_seed : opponent_shuffle_seed;
      const p2Secret = playerId === 2 ? player_secret : opponent_secret;
      const p2Seed = playerId === 2 ? shuffle_seed : opponent_shuffle_seed;
      const replayDeals = async () => {
        for (const [pid, sec, seed] of [[1, p1Secret, p1Seed], [2, p2Secret, p2Seed]] as const) {
          if (sec) {
            await midnightDealCards(lobby_id, pid, sec, seed).catch((err: Error) => {
              console.warn(`[API] Local dealCards P${pid} replay failed (non-critical):`, err?.message);
            });
          }
        }
      };
      replayDeals().catch(() => {});
    }

    console.log(`[API] Setup notification received: ${action} for lobby ${lobby_id} player ${playerId}`);
    return { success: true };
  });

  // ============================================================================
  // PRC-6: Midnight dApp Integration API
  // https://github.com/effectstream/midnight-game-api-spec
  //
  // Three required endpoints for the Midnight Platform aggregator:
  //   GET /metrics              — app metadata, achievement definitions, channel list
  //   GET /metrics/:channel     — ranked entries for a specific metric channel
  //   GET /metrics/users/:address — per-user identity + optional channel stats
  //
  // Go Fish exposes a single channel: "leaderboard" (total_points, DESC).
  // Identity delegation (Session → Main Wallet) is not yet implemented;
  // midnight_address is treated as both session and main wallet.
  // ============================================================================

  const PRC6_APP_NAME = "Go Fish";
  const PRC6_APP_DESCRIPTION =
    "Privacy-preserving Go Fish card game on the Midnight blockchain. " +
    "Players hold and trade cards in a ZK-proven mental poker deck.";

  /** The single channel Go Fish exposes to the Platform. */
  const PRC6_CHANNELS = [
    {
      id: "leaderboard",
      name: "Leaderboard",
      description: "Total points earned across all games. Win = 100 pts, loss = 10 pts.",
      scoreUnit: "Points",
      sortOrder: "DESC",
      type: "cumulative",
    },
  ] as const;

  /** No achievements are defined yet — array is empty but shape is spec-compliant. */
  const PRC6_ACHIEVEMENTS: unknown[] = [];

  /**
   * GET /metrics
   * Returns app display metadata, achievement definitions, and the channel list.
   * Used by the Midnight Platform to render the app profile.
   */
  server.get("/metrics", async (_request, _reply) => {
    return {
      name: PRC6_APP_NAME,
      description: PRC6_APP_DESCRIPTION,
      achievements: PRC6_ACHIEVEMENTS,
      channels: PRC6_CHANNELS,
    };
  });

  /**
   * GET /metrics/:channel
   * Returns ranked entries for the specified channel with optional pagination and
   * date-range filtering (ignored for snapshot channels; leaderboard is cumulative).
   *
   * PRC-6 §2 — Channel Rankings
   */
  server.get<{
    Params: { channel: string };
    Querystring: {
      limit?: string;
      offset?: string;
      startDate?: string;
      endDate?: string;
      minAchievements?: string;
    };
  }>("/metrics/:channel", async (request, reply) => {
    const { channel } = request.params;

    // Only "leaderboard" is supported
    if (channel !== "leaderboard") {
      return reply.code(404).send({ error: `Channel '${channel}' not found.` });
    }

    if (!dbPool) {
      return reply.code(503).send({ error: "Database not ready" });
    }

    const limit = Math.min(Number(request.query.limit ?? 50), 1000);
    const offset = Math.max(Number(request.query.offset ?? 0), 0);

    // Compute default date window (now − 1 year → now) for the envelope
    const now = new Date();
    const oneYearAgo = new Date(now);
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    const appliedStart = request.query.startDate ?? oneYearAgo.toISOString();
    const appliedEnd = request.query.endDate ?? now.toISOString();

    try {
      // Fetch total counts/score for the envelope fields
      const totalsResult = await dbPool.query<{
        total_players: string;
        total_score: string;
      }>(
        `SELECT COUNT(*) AS total_players, COALESCE(SUM(total_points), 0) AS total_score
         FROM go_fish_leaderboard`
      );

      const totalPlayers = Number(totalsResult.rows[0]?.total_players ?? 0);
      const totalScore = Number(totalsResult.rows[0]?.total_score ?? 0);

      // Fetch paginated entries ordered by score descending
      const entriesResult = await dbPool.query<{
        midnight_address: string;
        total_points: string;
        games_played: number;
      }>(
        `SELECT midnight_address, total_points, games_played
         FROM go_fish_leaderboard
         ORDER BY total_points DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset]
      );

      const entries = entriesResult.rows.map((row, idx) => ({
        rank: offset + idx + 1,
        address: row.midnight_address,
        displayName: null,
        score: Number(row.total_points),
      }));

      return {
        channel,
        startDate: appliedStart,
        endDate: appliedEnd,
        totalPlayers,
        totalScore,
        entries,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[API] /metrics/:channel error:", message);
      return reply.code(500).send({ error: message });
    }
  });

  /**
   * GET /metrics/users/:address
   * Returns identity and optionally per-channel stats for a wallet address.
   * Accepts both Session and Main Wallet addresses (currently they are identical —
   * Go Fish uses midnight_address as a stable identifier with no delegation layer).
   *
   * PRC-6 §3 — User Profile
   */
  server.get<{
    Params: { address: string };
    Querystring: {
      channel?: string | string[];
      startDate?: string;
      endDate?: string;
    };
  }>("/metrics/users/:address", async (request, reply) => {
    const { address } = request.params;

    if (!dbPool) {
      return reply.code(503).send({ error: "Database not ready" });
    }

    // Look up this address in the leaderboard
    const userResult = await dbPool.query<{
      midnight_address: string;
      total_points: string;
      games_played: number;
      games_won: number;
    }>(
      `SELECT midnight_address, total_points, games_played, games_won
       FROM go_fish_leaderboard
       WHERE midnight_address = $1`,
      [address]
    );

    if (userResult.rows.length === 0) {
      return reply.code(404).send({ error: `Address '${address}' not found.` });
    }

    const user = userResult.rows[0];

    // Identity: Go Fish has no Session→Main delegation yet; delegatedFrom is empty.
    const identity = {
      address: user.midnight_address,
      delegatedFrom: [] as string[],
    };

    // Normalise the channel query param (single string or array)
    const rawChannels = request.query.channel;
    const requestedChannels: string[] = !rawChannels
      ? []
      : Array.isArray(rawChannels)
      ? rawChannels
      : [rawChannels];

    // No channel params → identity + achievements only
    if (requestedChannels.length === 0) {
      return { identity, achievements: [] };
    }

    // Compute default date window
    const now = new Date();
    const oneYearAgo = new Date(now);
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    const appliedStart = request.query.startDate ?? oneYearAgo.toISOString();
    const appliedEnd = request.query.endDate ?? now.toISOString();

    const channels: Record<string, unknown> = {};

    for (const channelId of requestedChannels) {
      if (channelId !== "leaderboard") continue; // skip unknown channels

      // Compute dynamic rank
      const rankResult = await dbPool.query<{ rank: string }>(
        `SELECT COUNT(*) + 1 AS rank
         FROM go_fish_leaderboard
         WHERE total_points > $1`,
        [user.total_points]
      );
      const rank = Number(rankResult.rows[0]?.rank ?? 1);

      channels[channelId] = {
        startDate: appliedStart,
        endDate: appliedEnd,
        stats: {
          score: Number(user.total_points),
          rank,
          matchesPlayed: user.games_played,
        },
      };
    }

    return { identity, achievements: [], channels };
  });

  console.log("✓ Game API routes registered");
};

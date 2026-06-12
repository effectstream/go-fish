/**
 * API Router - Defines REST API endpoints for the game
 */

import type { FastifyInstance } from "fastify";
import type { StartConfigApiRouter } from "@effectstream/runtime";
import type { Pool } from "pg";
import {
  getGameState as getMidnightGameState,
} from "./midnight-query.ts";
import {
  isValidLobbyId,
} from "./midnight-onchain.ts";


// Database connection pool - set by apiRouter from the runtime-provided connection
let dbPool: Pool | null = null;


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
          wallet_address: string;
          total_points: string;
          games_played: number;
          games_won: number;
        }>(
          `WITH pubkey_wallet AS (
             SELECT DISTINCT ON (lb.midnight_address)
               lb.midnight_address,
               COALESCE(
                 (SELECT addr.address FROM effectstream.addresses addr
                  WHERE addr.account_id =
                    CASE WHEN lb.midnight_address = mg.host_pubkey
                         THEN l.host_account_id
                         ELSE (SELECT lp.account_id FROM lobby_players lp
                               WHERE lp.lobby_id = mg.evm_id
                                 AND lp.account_id != l.host_account_id LIMIT 1)
                    END
                  LIMIT 1),
                 (SELECT acct.primary_address FROM effectstream.accounts acct
                  WHERE acct.id =
                    CASE WHEN lb.midnight_address = mg.host_pubkey
                         THEN l.host_account_id
                         ELSE (SELECT lp.account_id FROM lobby_players lp
                               WHERE lp.lobby_id = mg.evm_id
                                 AND lp.account_id != l.host_account_id LIMIT 1)
                    END)
               ) as wallet_address
             FROM go_fish_leaderboard lb
             JOIN midnight_games mg
               ON lb.midnight_address IN (mg.host_pubkey, mg.joiner_pubkey)
             JOIN lobbies l ON l.lobby_id = mg.evm_id
           )
           SELECT
             pw.wallet_address,
             SUM(lb.total_points)::bigint as total_points,
             SUM(lb.games_played)::int as games_played,
             SUM(lb.games_won)::int as games_won
           FROM go_fish_leaderboard lb
           JOIN pubkey_wallet pw ON pw.midnight_address = lb.midnight_address
           WHERE pw.wallet_address IS NOT NULL
           GROUP BY pw.wallet_address
           ORDER BY total_points DESC
           LIMIT $1 OFFSET $2`,
          [limit, offset]
        );
        return result.rows.map(r => ({
          wallet_address: r.wallet_address,
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
   * Get open lobbies (for lobby list)
   */
  server.get("/open_lobbies", async (request, reply) => {
    const { page = 0, count = 10, wallet } = request.query as { page?: number; count?: number; wallet?: string };

    const db = dbPool!;
    if (!db) {
      return reply.code(503).send({ error: 'Database not ready' });
    }
    const offset = page * count;

    try {
      // Get account ID from wallet if provided (to check membership)
      let accountId: number | null = null;
      if (wallet) {
        const accountResult = await db.query(`
          SELECT account_id FROM effectstream.addresses WHERE address = LOWER($1)
        `, [wallet]);
        if (accountResult.rows.length > 0) {
          accountId = accountResult.rows[0].account_id;
        }
      }

      // Query lobbies with optional membership check.
      // Lobbies older than 10 minutes are hidden from the list (soft TTL).
      const result = await db.query(`
        SELECT
          l.lobby_id,
          l.lobby_name,
          l.status,
          l.created_at,
          l.host_account_id,
          l.host_mask_applied,
          (SELECT COUNT(*) FROM lobby_players WHERE lobby_id = l.lobby_id) as player_count,
          (SELECT player_name FROM lobby_players WHERE lobby_id = l.lobby_id AND account_id = l.host_account_id LIMIT 1) as host_name,
          (SELECT player_name FROM lobby_players WHERE lobby_id = l.lobby_id AND account_id != l.host_account_id LIMIT 1) as guest_name,
          ${accountId !== null ? `EXISTS(SELECT 1 FROM lobby_players WHERE lobby_id = l.lobby_id AND account_id = ${accountId})` : 'false'} as is_player_in_lobby
        FROM lobbies l
        WHERE (
          (l.status = 'open' AND l.created_at > NOW() - INTERVAL '10 minutes')
          OR (l.status = 'in_progress' AND ${accountId !== null ? `EXISTS(SELECT 1 FROM lobby_players WHERE lobby_id = l.lobby_id AND account_id = ${accountId})` : 'false'})
        )
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
        SELECT account_id FROM effectstream.addresses WHERE address = LOWER($1)
      `, [wallet]);

      if (accountResult.rows.length === 0) {
        return { lobbies: [] };
      }

      const accountId = accountResult.rows[0].account_id;

      const result = await db.query(`
        SELECT
          l.lobby_id,
          l.lobby_name,
          l.status,
          l.created_at,
          (SELECT COUNT(*) FROM lobby_players WHERE lobby_id = l.lobby_id) as player_count
        FROM lobbies l
        INNER JOIN lobby_players lp ON l.lobby_id = lp.lobby_id
        WHERE lp.account_id = $1
          AND (
            l.status != 'open'
            OR l.created_at > NOW() - INTERVAL '10 minutes'
          )
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
    if (!db) {
      return reply.code(503).send({ error: 'Database not ready' });
    }

    try {
      // Get lobby info
      const lobbyResult = await db.query(`
        SELECT
          l.lobby_id,
          l.lobby_name,
          l.host_account_id,
          l.host_mask_applied,
          l.status,
          l.created_at,
          l.started_at,
          (l.status = 'open'
           AND l.created_at <= NOW() - INTERVAL '10 minutes') AS is_expired
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
      // COALESCE fallback: if the account_id from lobby_players has no
      // matching effectstream.addresses row (can happen when a case-sensitive
      // address lookup in the state machine created a new account whose
      // address insert collided with the existing lowercase entry), fall
      // back to the account's primary_address from effectstream.accounts.
      const playersResult = await db.query(`
        SELECT
          lp.account_id,
          lp.player_name,
          lp.joined_at,
          COALESCE(
            (SELECT addr.address FROM effectstream.addresses addr
             WHERE addr.account_id = lp.account_id LIMIT 1),
            (SELECT acct.primary_address FROM effectstream.accounts acct
             WHERE acct.id = lp.account_id)
          ) as wallet_address
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
    if (!db) {
      return reply.code(503).send({ error: 'Database not ready' });
    }

    // Get lobby info to verify it's in_progress
    const lobbyResult = await db.query(`
      SELECT
        l.lobby_id,
        l.lobby_name,
        l.host_account_id,
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
      SELECT account_id FROM effectstream.addresses WHERE address = LOWER($1)
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
      // gameLog: updateGameLog(lobby_id, midnightState, players),
    };
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

      // Fetch paginated entries ordered by score descending, resolving wallet addresses
      const entriesResult = await dbPool.query<{
        wallet_address: string;
        total_points: string;
        games_played: number;
      }>(
        `WITH pubkey_wallet AS (
           SELECT DISTINCT ON (lb.midnight_address)
             lb.midnight_address,
             COALESCE(
               (SELECT addr.address FROM effectstream.addresses addr
                WHERE addr.account_id =
                  CASE WHEN lb.midnight_address = mg.host_pubkey
                       THEN l.host_account_id
                       ELSE (SELECT lp.account_id FROM lobby_players lp
                             WHERE lp.lobby_id = mg.evm_id
                               AND lp.account_id != l.host_account_id LIMIT 1)
                  END
                LIMIT 1),
               (SELECT acct.primary_address FROM effectstream.accounts acct
                WHERE acct.id =
                  CASE WHEN lb.midnight_address = mg.host_pubkey
                       THEN l.host_account_id
                       ELSE (SELECT lp.account_id FROM lobby_players lp
                             WHERE lp.lobby_id = mg.evm_id
                               AND lp.account_id != l.host_account_id LIMIT 1)
                  END)
             ) as wallet_address
           FROM go_fish_leaderboard lb
           JOIN midnight_games mg
             ON lb.midnight_address IN (mg.host_pubkey, mg.joiner_pubkey)
           JOIN lobbies l ON l.lobby_id = mg.evm_id
         )
         SELECT
           pw.wallet_address,
           SUM(lb.total_points)::bigint as total_points,
           SUM(lb.games_played)::int as games_played
         FROM go_fish_leaderboard lb
         JOIN pubkey_wallet pw ON pw.midnight_address = lb.midnight_address
         WHERE pw.wallet_address IS NOT NULL
         GROUP BY pw.wallet_address
         ORDER BY total_points DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset]
      );

      const entries = entriesResult.rows.map((row, idx) => ({
        rank: offset + idx + 1,
        address: row.wallet_address,
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

    // Resolve wallet address → aggregated leaderboard stats via the same
    // pubkey→wallet CTE used by /api/leaderboard.
    const userResult = await dbPool.query<{
      wallet_address: string;
      total_points: string;
      games_played: number;
      games_won: number;
    }>(
      `WITH pubkey_wallet AS (
         SELECT DISTINCT ON (lb.midnight_address)
           lb.midnight_address,
           COALESCE(
             (SELECT addr.address FROM effectstream.addresses addr
              WHERE addr.account_id =
                CASE WHEN lb.midnight_address = mg.host_pubkey
                     THEN l.host_account_id
                     ELSE (SELECT lp2.account_id FROM lobby_players lp2
                           WHERE lp2.lobby_id = mg.evm_id
                             AND lp2.account_id != l.host_account_id LIMIT 1)
                END
              LIMIT 1),
             (SELECT acct.primary_address FROM effectstream.accounts acct
              WHERE acct.id =
                CASE WHEN lb.midnight_address = mg.host_pubkey
                     THEN l.host_account_id
                     ELSE (SELECT lp2.account_id FROM lobby_players lp2
                           WHERE lp2.lobby_id = mg.evm_id
                             AND lp2.account_id != l.host_account_id LIMIT 1)
                END)
           ) as wallet_address
         FROM go_fish_leaderboard lb
         JOIN midnight_games mg
           ON lb.midnight_address IN (mg.host_pubkey, mg.joiner_pubkey)
         JOIN lobbies l ON l.lobby_id = mg.evm_id
       )
       SELECT
         pw.wallet_address,
         SUM(lb.total_points)::bigint as total_points,
         SUM(lb.games_played)::int as games_played,
         SUM(lb.games_won)::int as games_won
       FROM go_fish_leaderboard lb
       JOIN pubkey_wallet pw ON pw.midnight_address = lb.midnight_address
       WHERE pw.wallet_address = $1
       GROUP BY pw.wallet_address`,
      [address]
    );

    if (userResult.rows.length === 0) {
      return reply.code(404).send({ error: `Address '${address}' not found.` });
    }

    const user = userResult.rows[0];

    const identity = {
      address: user.wallet_address,
      delegatedFrom: [] as string[],
      displayName: null as string | null,
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

      // Compute dynamic rank among wallet-aggregated scores
      const rankResult = await dbPool.query<{ rank: string }>(
        `WITH wallet_scores AS (
           SELECT pw.wallet_address, SUM(lb.total_points)::bigint as total_points
           FROM go_fish_leaderboard lb
           JOIN (
             SELECT DISTINCT ON (lb2.midnight_address)
               lb2.midnight_address,
               COALESCE(
                 (SELECT addr.address FROM effectstream.addresses addr
                  WHERE addr.account_id =
                    CASE WHEN lb2.midnight_address = mg.host_pubkey
                         THEN l.host_account_id
                         ELSE (SELECT lp2.account_id FROM lobby_players lp2
                               WHERE lp2.lobby_id = mg.evm_id
                                 AND lp2.account_id != l.host_account_id LIMIT 1)
                    END
                  LIMIT 1),
                 (SELECT acct.primary_address FROM effectstream.accounts acct
                  WHERE acct.id =
                    CASE WHEN lb2.midnight_address = mg.host_pubkey
                         THEN l.host_account_id
                         ELSE (SELECT lp2.account_id FROM lobby_players lp2
                               WHERE lp2.lobby_id = mg.evm_id
                                 AND lp2.account_id != l.host_account_id LIMIT 1)
                    END)
               ) as wallet_address
             FROM go_fish_leaderboard lb2
             JOIN midnight_games mg ON lb2.midnight_address IN (mg.host_pubkey, mg.joiner_pubkey)
             JOIN lobbies l ON l.lobby_id = mg.evm_id
           ) pw ON pw.midnight_address = lb.midnight_address
           WHERE pw.wallet_address IS NOT NULL
           GROUP BY pw.wallet_address
         )
         SELECT COUNT(*) + 1 AS rank FROM wallet_scores WHERE total_points > $1`,
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

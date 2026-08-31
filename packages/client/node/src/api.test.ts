/**
 * API endpoint tests
 *
 * Tests for:
 *   - GET /api/leaderboard       (internal leaderboard)
 *   - GET /metrics               (PRC-6 app metadata)
 *   - GET /metrics/:channel      (PRC-6 channel rankings)
 *   - GET /metrics/users/:address (PRC-6 user profile)
 *
 * Spins up a real Fastify instance with a mock database pool so no live
 * database or Midnight infrastructure is required.
 *
 * Run:
 *   bun run test                          (from packages/client/node/)
 *   bun run test              (from repo root, delegates to node package)
 */

import { test, expect, beforeAll, afterAll } from "bun:test";
import Fastify from "fastify";
import type { Pool, QueryResult } from "pg";
import { apiRouter } from "./api.ts";

// ---------------------------------------------------------------------------
// Mock database pool
// ---------------------------------------------------------------------------

/**
 * Fixture rows that represent the go_fish_leaderboard table.
 * Ordered by total_points DESC (as the real queries do).
 */
const FIXTURE_ROWS = [
  {
    midnight_address: "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
    total_points: "310",
    games_played: 4,
    games_won: 3,
    last_updated_block: 100n,
  },
  {
    midnight_address: "1122334455667788990011223344556677889900112233445566778899001122",
    total_points: "120",
    games_played: 3,
    games_won: 1,
    last_updated_block: 95n,
  },
  {
    midnight_address: "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100",
    total_points: "10",
    games_played: 1,
    games_won: 0,
    last_updated_block: 80n,
  },
] as const;

type FixtureRow = (typeof FIXTURE_ROWS)[number];

/**
 * Fixture lobby rows for the /open_lobbies TTL test.
 * `created_at` is computed at test time so the mock can apply the 10-minute
 * cutoff the same way the real query does.
 */
const TEN_MINUTES_MS = 10 * 60 * 1000;
const NOW = Date.now();

const LOBBY_FIXTURES: Array<{
  lobby_id: string;
  lobby_name: string;
  status: string;
  created_at: Date;
  host_account_id: number;
  player_count: number;
  host_name: string;
}> = [
  {
    lobby_id: "lobby_recent_alice",
    lobby_name: "Alice's Game",
    status: "open",
    created_at: new Date(NOW - 2 * 60 * 1000), // 2 min old — fresh
    host_account_id: 1,
    player_count: 1,
    host_name: "Alice",
  },
  {
    lobby_id: "lobby_edge_bob",
    lobby_name: "Bob's Table",
    status: "open",
    created_at: new Date(NOW - 9 * 60 * 1000), // 9 min old — still fresh
    host_account_id: 2,
    player_count: 1,
    host_name: "Bob",
  },
  {
    lobby_id: "lobby_stale_carol",
    lobby_name: "Carol's Den",
    status: "open",
    created_at: new Date(NOW - 11 * 60 * 1000), // 11 min old — EXPIRED
    host_account_id: 3,
    player_count: 1,
    host_name: "Carol",
  },
];

/**
 * Build a minimal pg-Pool mock.
 * Intercepts SQL queries by pattern-matching against the query string and
 * returns pre-canned rows. Unrecognised queries return empty results so tests
 * fail informatively rather than throwing.
 */
function makeMockPool(): Pool {
  const pool = {
    query: async (sql: string, params?: unknown[]): Promise<QueryResult> => {
      const q = sql.replace(/\s+/g, " ").trim().toLowerCase();

      // ── go_fish_leaderboard: paginated list ──────────────────────────────
      if (q.includes("from go_fish_leaderboard") && q.includes("order by total_points desc") && q.includes("limit")) {
        const limit = Number(params?.[0] ?? 50);
        const offset = Number(params?.[1] ?? 0);
        const rows = [...FIXTURE_ROWS]
          .sort((a, b) => Number(b.total_points) - Number(a.total_points))
          .slice(offset, offset + limit);
        return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] };
      }

      // ── go_fish_leaderboard: count + sum (totals for /metrics/:channel) ──
      if (q.includes("count(*)") && q.includes("sum(total_points)") && q.includes("go_fish_leaderboard")) {
        const total_players = String(FIXTURE_ROWS.length);
        const total_score = String(FIXTURE_ROWS.reduce((s, r) => s + Number(r.total_points), 0));
        return {
          rows: [{ total_players, total_score }],
          rowCount: 1, command: "SELECT", oid: 0, fields: [],
        };
      }

      // ── go_fish_leaderboard: single address lookup ───────────────────────
      if (q.includes("from go_fish_leaderboard") && q.includes("where midnight_address =")) {
        const addr = String(params?.[0] ?? "");
        const found = FIXTURE_ROWS.find(r => r.midnight_address === addr);
        const rows = found ? [found] : [];
        return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] };
      }

      // ── go_fish_leaderboard: rank computation ────────────────────────────
      if (q.includes("count(*) + 1") && q.includes("go_fish_leaderboard") && q.includes("total_points >")) {
        const targetPoints = Number(params?.[0] ?? 0);
        const rank = String(FIXTURE_ROWS.filter(r => Number(r.total_points) > targetPoints).length + 1);
        return { rows: [{ rank }], rowCount: 1, command: "SELECT", oid: 0, fields: [] };
      }

      // ── open_lobbies: optional wallet lookup (is_player_in_lobby) ────────
      if (q.includes("from effectstream.addresses") && q.includes("where address =")) {
        // No wallet is bound in these tests — return empty so the route
        // takes the `false as is_player_in_lobby` path.
        return { rows: [], rowCount: 0, command: "SELECT", oid: 0, fields: [] };
      }

      // ── open_lobbies: list query with 10-minute TTL cutoff ───────────────
      if (q.includes("from lobbies l") && q.includes("where l.status = 'open'")) {
        const limit = Number(params?.[0] ?? 10);
        const offset = Number(params?.[1] ?? 0);
        const cutoff = Date.now() - TEN_MINUTES_MS;
        const filtered = LOBBY_FIXTURES
          .filter(l => l.status === "open" && l.created_at.getTime() > cutoff)
          .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
          .slice(offset, offset + limit)
          .map(l => ({
            ...l,
            is_player_in_lobby: false,
          }));
        return { rows: filtered, rowCount: filtered.length, command: "SELECT", oid: 0, fields: [] };
      }

      // Default: empty result (unrecognised query)
      return { rows: [], rowCount: 0, command: "SELECT", oid: 0, fields: [] };
    },
    // Stub connect/end so apiRouter doesn't throw if it calls these
    connect: async () => {},
    end: async () => {},
  } as unknown as Pool;

  return pool;
}

// ---------------------------------------------------------------------------
// Test server factory
// ---------------------------------------------------------------------------

async function buildTestServer() {
  // Silence Fastify logs during tests
  const server = Fastify({ logger: false });

  // Register the full apiRouter with our mock pool.
  // apiRouter sets module-level `dbPool` and registers all routes.
  await apiRouter(server, makeMockPool());

  // Ensure the server is fully initialised before returning
  await server.ready();
  return server;
}

// ---------------------------------------------------------------------------
// Helper: inject and parse JSON
// ---------------------------------------------------------------------------

async function getJSON(server: Awaited<ReturnType<typeof buildTestServer>>, url: string) {
  const resp = await server.inject({ method: "GET", url });
  return { status: resp.statusCode, body: resp.json() };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

// Shared server instance — created once per test file, closed at the end.
let server: Awaited<ReturnType<typeof buildTestServer>>;

beforeAll(async () => {
  server = await buildTestServer();
});

// ── GET /api/health ──────────────────────────────────────────────────────────

test("GET /api/health → 200 { status: 'ok' }", async () => {
    const { status, body } = await getJSON(server, "/api/health");
    expect(status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.timestamp).toBeDefined();
});

// ── GET /api/leaderboard ────────────────────────────────────────────────────

test("GET /api/leaderboard → 200 with all fixture rows", async () => {
    const { status, body } = await getJSON(server, "/api/leaderboard");
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(FIXTURE_ROWS.length);

    // First entry must be the top scorer
    expect(body[0].midnight_address).toBe(FIXTURE_ROWS[0].midnight_address);
    expect(body[0].total_points).toBe(310);
    expect(body[0].games_played).toBe(4);
    expect(body[0].games_won).toBe(3);
});

test("GET /api/leaderboard?limit=1 → 200 with exactly 1 row", async () => {
    const { status, body } = await getJSON(server, "/api/leaderboard?limit=1");
    expect(status).toBe(200);
    expect(body.length).toBe(1);
    expect(body[0].total_points).toBe(310);
});

test("GET /api/leaderboard?limit=1&offset=1 → 200 with second row", async () => {
    const { status, body } = await getJSON(server, "/api/leaderboard?limit=1&offset=1");
    expect(status).toBe(200);
    expect(body.length).toBe(1);
    expect(body[0].midnight_address).toBe(FIXTURE_ROWS[1].midnight_address);
    expect(body[0].total_points).toBe(120);
});

test("GET /api/leaderboard response shape has expected fields", async () => {
    const { status, body } = await getJSON(server, "/api/leaderboard");
    expect(status).toBe(200);
    const row = body[0];
    expect(row.midnight_address).toBeDefined();
    expect(row.total_points).toBeDefined();
    expect(row.games_played).toBeDefined();
    expect(row.games_won).toBeDefined();
});

// ── GET /metrics ─────────────────────────────────────────────────────────────

test("GET /metrics → 200 with PRC-6 app metadata", async () => {
    const { status, body } = await getJSON(server, "/metrics");
    expect(status).toBe(200);
    expect(body.name).toBeDefined();
    expect(body.description).toBeDefined();
    expect(Array.isArray(body.achievements)).toBe(true);
    expect(Array.isArray(body.channels)).toBe(true);
});

test("GET /metrics → declares leaderboard channel", async () => {
    const { status, body } = await getJSON(server, "/metrics");
    expect(status).toBe(200);
    const leaderboard = body.channels.find((c: { id: string }) => c.id === "leaderboard");
    expect(leaderboard).toBeDefined();
    expect(leaderboard.sortOrder).toBe("DESC");
    expect(leaderboard.name).toBeDefined();
    expect(leaderboard.description).toBeDefined();
    expect(leaderboard.scoreUnit).toBeDefined();
});

test("GET /metrics → channel object has all required PRC-6 fields", async () => {
    const { status, body } = await getJSON(server, "/metrics");
    expect(status).toBe(200);
    for (const ch of body.channels) {
      expect(ch.id).toBeDefined();
      expect(ch.name).toBeDefined();
      expect(ch.description).toBeDefined();
      expect(ch.scoreUnit).toBeDefined();
      expect(ch.sortOrder).toBeDefined();
    }
});

// ── GET /metrics/:channel ────────────────────────────────────────────────────

test("GET /metrics/leaderboard → 200 with PRC-6 rankings envelope", async () => {
    const { status, body } = await getJSON(server, "/metrics/leaderboard");
    expect(status).toBe(200);
    expect(body.channel).toBe("leaderboard");
    expect(body.startDate).toBeDefined();
    expect(body.endDate).toBeDefined();
    expect(body.totalPlayers).toBeDefined();
    expect(body.totalScore).toBeDefined();
    expect(Array.isArray(body.entries)).toBe(true);
});

test("GET /metrics/leaderboard → correct totalPlayers and totalScore", async () => {
    const { status, body } = await getJSON(server, "/metrics/leaderboard");
    expect(status).toBe(200);
    expect(body.totalPlayers).toBe(FIXTURE_ROWS.length);
    const expectedTotal = FIXTURE_ROWS.reduce((s, r) => s + Number(r.total_points), 0);
    expect(body.totalScore).toBe(expectedTotal);
});

test("GET /metrics/leaderboard → entries are 1-based ranked", async () => {
    const { status, body } = await getJSON(server, "/metrics/leaderboard");
    expect(status).toBe(200);
    expect(body.entries[0].rank).toBe(1);
    expect(body.entries[1].rank).toBe(2);
    expect(body.entries[2].rank).toBe(3);
});

test("GET /metrics/leaderboard → entry has required PRC-6 fields", async () => {
    const { status, body } = await getJSON(server, "/metrics/leaderboard");
    expect(status).toBe(200);
    const entry = body.entries[0];
    expect(entry.rank).toBeDefined();
    expect(entry.address).toBeDefined();
    // displayName may be null per spec — just assert it's present as a key
    expect("displayName" in entry).toBe(true);
    expect(entry.score).toBeDefined();
});

test("GET /metrics/leaderboard → top entry matches highest scorer", async () => {
    const { status, body } = await getJSON(server, "/metrics/leaderboard");
    expect(status).toBe(200);
    expect(body.entries[0].address).toBe(FIXTURE_ROWS[0].midnight_address);
    expect(body.entries[0].score).toBe(310);
});

test("GET /metrics/leaderboard?limit=1 → returns exactly 1 entry", async () => {
    const { status, body } = await getJSON(server, "/metrics/leaderboard?limit=1");
    expect(status).toBe(200);
    expect(body.entries.length).toBe(1);
    expect(body.entries[0].rank).toBe(1);
});

test("GET /metrics/leaderboard?offset=1 → rank starts at 2", async () => {
    const { status, body } = await getJSON(server, "/metrics/leaderboard?limit=1&offset=1");
    expect(status).toBe(200);
    expect(body.entries.length).toBe(1);
    expect(body.entries[0].rank).toBe(2);
    expect(body.entries[0].address).toBe(FIXTURE_ROWS[1].midnight_address);
});

test("GET /metrics/unknown-channel → 404", async () => {
    const { status, body } = await getJSON(server, "/metrics/nonexistent");
    expect(status).toBe(404);
    expect(body.error).toBeDefined();
});

// ── GET /metrics/users/:address ───────────────────────────────────────────────

test("GET /metrics/users/:address → 200 with identity + empty achievements", async () => {
    const addr = FIXTURE_ROWS[0].midnight_address;
    const { status, body } = await getJSON(server, `/metrics/users/${addr}`);
    expect(status).toBe(200);
    expect(body.identity).toBeDefined();
    expect(body.identity.address).toBe(addr);
    expect(Array.isArray(body.identity.delegatedFrom)).toBe(true);
    expect(Array.isArray(body.achievements)).toBe(true);
    // No channel param → no channels field
    expect(body.channels).toBe(undefined);
});

test("GET /metrics/users/:address?channel=leaderboard → includes channel stats", async () => {
    const addr = FIXTURE_ROWS[0].midnight_address;
    const { status, body } = await getJSON(server, `/metrics/users/${addr}?channel=leaderboard`);
    expect(status).toBe(200);
    expect(body.channels).toBeDefined();
    expect(body.channels.leaderboard).toBeDefined();
    const ch = body.channels.leaderboard;
    expect(ch.stats).toBeDefined();
    expect(ch.stats.score).toBe(310);
    expect(ch.stats.rank).toBe(1);
    expect(ch.stats.matchesPlayed).toBeDefined();
    expect(ch.startDate).toBeDefined();
    expect(ch.endDate).toBeDefined();
});

test("GET /metrics/users/:address?channel=leaderboard → rank reflects position", async () => {
    // Third player (lowest score) should have rank 3
    const addr = FIXTURE_ROWS[2].midnight_address;
    const { status, body } = await getJSON(server, `/metrics/users/${addr}?channel=leaderboard`);
    expect(status).toBe(200);
    expect(body.channels.leaderboard.stats.rank).toBe(3);
    expect(body.channels.leaderboard.stats.score).toBe(10);
});

test("GET /metrics/users/unknown → 404", async () => {
    const { status, body } = await getJSON(server, "/metrics/users/doesnotexist");
    expect(status).toBe(404);
    expect(body.error).toBeDefined();
});

test("GET /metrics/users/:address — unknown channel param is silently skipped", async () => {
    const addr = FIXTURE_ROWS[0].midnight_address;
    const { status, body } = await getJSON(server, `/metrics/users/${addr}?channel=nonexistent`);
    expect(status).toBe(200);
    // channels object exists but the unknown channel is absent
    expect(body.channels).toBeDefined();
    expect(body.channels.nonexistent).toBe(undefined);
});

test("GET /metrics/users/:address — identity.delegatedFrom is always an array", async () => {
    const addr = FIXTURE_ROWS[1].midnight_address;
    const { status, body } = await getJSON(server, `/metrics/users/${addr}`);
    expect(status).toBe(200);
    expect(Array.isArray(body.identity.delegatedFrom)).toBe(true);
});

// ── GET /open_lobbies ────────────────────────────────────────────────────────

test("GET /open_lobbies → 200 with { lobbies: [...] }", async () => {
    const { status, body } = await getJSON(server, "/open_lobbies");
    expect(status).toBe(200);
    expect(Array.isArray(body.lobbies)).toBe(true);
});

test("GET /open_lobbies → hides lobbies older than 10 minutes", async () => {
    const { status, body } = await getJSON(server, "/open_lobbies");
    expect(status).toBe(200);

    const ids = body.lobbies.map((l: { lobby_id: string }) => l.lobby_id);
    // Fresh lobby (2 min old) — must be present
    expect(ids.includes("lobby_recent_alice")).toBe(true);
    // Edge-of-window lobby (9 min old) — must be present
    expect(ids.includes("lobby_edge_bob")).toBe(true);
    // Stale lobby (11 min old) — must be hidden by the TTL filter
    expect(ids.includes("lobby_stale_carol")).toBe(false);
});

test("GET /open_lobbies → response rows do not expose max_players", async () => {
    const { status, body } = await getJSON(server, "/open_lobbies");
    expect(status).toBe(200);
    for (const lobby of body.lobbies) {
      expect("max_players" in lobby).toBe(false);
    }
});

// ── teardown ─────────────────────────────────────────────────────────────────

afterAll(async () => {
  await server.close();
});

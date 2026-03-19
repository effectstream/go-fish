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
 *   deno task test                          (from packages/client/node/)
 *   deno task test              (from repo root, delegates to node package)
 */

import { assertEquals, assertExists } from "jsr:@std/assert";
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

Deno.test({
  name: "setup",
  fn: async () => {
    server = await buildTestServer();
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

// ── GET /api/health ──────────────────────────────────────────────────────────

Deno.test({
  name: "GET /api/health → 200 { status: 'ok' }",
  fn: async () => {
    const { status, body } = await getJSON(server, "/api/health");
    assertEquals(status, 200);
    assertEquals(body.status, "ok");
    assertExists(body.timestamp);
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

// ── GET /api/leaderboard ────────────────────────────────────────────────────

Deno.test({
  name: "GET /api/leaderboard → 200 with all fixture rows",
  fn: async () => {
    const { status, body } = await getJSON(server, "/api/leaderboard");
    assertEquals(status, 200);
    assertEquals(Array.isArray(body), true);
    assertEquals(body.length, FIXTURE_ROWS.length);

    // First entry must be the top scorer
    assertEquals(body[0].midnight_address, FIXTURE_ROWS[0].midnight_address);
    assertEquals(body[0].total_points, 310);
    assertEquals(body[0].games_played, 4);
    assertEquals(body[0].games_won, 3);
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "GET /api/leaderboard?limit=1 → 200 with exactly 1 row",
  fn: async () => {
    const { status, body } = await getJSON(server, "/api/leaderboard?limit=1");
    assertEquals(status, 200);
    assertEquals(body.length, 1);
    assertEquals(body[0].total_points, 310);
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "GET /api/leaderboard?limit=1&offset=1 → 200 with second row",
  fn: async () => {
    const { status, body } = await getJSON(server, "/api/leaderboard?limit=1&offset=1");
    assertEquals(status, 200);
    assertEquals(body.length, 1);
    assertEquals(body[0].midnight_address, FIXTURE_ROWS[1].midnight_address);
    assertEquals(body[0].total_points, 120);
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "GET /api/leaderboard response shape has expected fields",
  fn: async () => {
    const { status, body } = await getJSON(server, "/api/leaderboard");
    assertEquals(status, 200);
    const row = body[0];
    assertExists(row.midnight_address);
    assertExists(row.total_points);
    assertExists(row.games_played);
    assertExists(row.games_won);
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

// ── GET /metrics ─────────────────────────────────────────────────────────────

Deno.test({
  name: "GET /metrics → 200 with PRC-6 app metadata",
  fn: async () => {
    const { status, body } = await getJSON(server, "/metrics");
    assertEquals(status, 200);
    assertExists(body.name);
    assertExists(body.description);
    assertEquals(Array.isArray(body.achievements), true);
    assertEquals(Array.isArray(body.channels), true);
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "GET /metrics → declares leaderboard channel",
  fn: async () => {
    const { status, body } = await getJSON(server, "/metrics");
    assertEquals(status, 200);
    const leaderboard = body.channels.find((c: { id: string }) => c.id === "leaderboard");
    assertExists(leaderboard);
    assertEquals(leaderboard.sortOrder, "DESC");
    assertExists(leaderboard.name);
    assertExists(leaderboard.description);
    assertExists(leaderboard.scoreUnit);
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "GET /metrics → channel object has all required PRC-6 fields",
  fn: async () => {
    const { status, body } = await getJSON(server, "/metrics");
    assertEquals(status, 200);
    for (const ch of body.channels) {
      assertExists(ch.id, "channel.id missing");
      assertExists(ch.name, "channel.name missing");
      assertExists(ch.description, "channel.description missing");
      assertExists(ch.scoreUnit, "channel.scoreUnit missing");
      assertExists(ch.sortOrder, "channel.sortOrder missing");
    }
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

// ── GET /metrics/:channel ────────────────────────────────────────────────────

Deno.test({
  name: "GET /metrics/leaderboard → 200 with PRC-6 rankings envelope",
  fn: async () => {
    const { status, body } = await getJSON(server, "/metrics/leaderboard");
    assertEquals(status, 200);
    assertEquals(body.channel, "leaderboard");
    assertExists(body.startDate);
    assertExists(body.endDate);
    assertExists(body.totalPlayers);
    assertExists(body.totalScore);
    assertEquals(Array.isArray(body.entries), true);
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "GET /metrics/leaderboard → correct totalPlayers and totalScore",
  fn: async () => {
    const { status, body } = await getJSON(server, "/metrics/leaderboard");
    assertEquals(status, 200);
    assertEquals(body.totalPlayers, FIXTURE_ROWS.length);
    const expectedTotal = FIXTURE_ROWS.reduce((s, r) => s + Number(r.total_points), 0);
    assertEquals(body.totalScore, expectedTotal);
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "GET /metrics/leaderboard → entries are 1-based ranked",
  fn: async () => {
    const { status, body } = await getJSON(server, "/metrics/leaderboard");
    assertEquals(status, 200);
    assertEquals(body.entries[0].rank, 1);
    assertEquals(body.entries[1].rank, 2);
    assertEquals(body.entries[2].rank, 3);
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "GET /metrics/leaderboard → entry has required PRC-6 fields",
  fn: async () => {
    const { status, body } = await getJSON(server, "/metrics/leaderboard");
    assertEquals(status, 200);
    const entry = body.entries[0];
    assertExists(entry.rank);
    assertExists(entry.address);
    // displayName may be null per spec — just assert it's present as a key
    assertEquals("displayName" in entry, true);
    assertExists(entry.score);
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "GET /metrics/leaderboard → top entry matches highest scorer",
  fn: async () => {
    const { status, body } = await getJSON(server, "/metrics/leaderboard");
    assertEquals(status, 200);
    assertEquals(body.entries[0].address, FIXTURE_ROWS[0].midnight_address);
    assertEquals(body.entries[0].score, 310);
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "GET /metrics/leaderboard?limit=1 → returns exactly 1 entry",
  fn: async () => {
    const { status, body } = await getJSON(server, "/metrics/leaderboard?limit=1");
    assertEquals(status, 200);
    assertEquals(body.entries.length, 1);
    assertEquals(body.entries[0].rank, 1);
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "GET /metrics/leaderboard?offset=1 → rank starts at 2",
  fn: async () => {
    const { status, body } = await getJSON(server, "/metrics/leaderboard?limit=1&offset=1");
    assertEquals(status, 200);
    assertEquals(body.entries.length, 1);
    assertEquals(body.entries[0].rank, 2);
    assertEquals(body.entries[0].address, FIXTURE_ROWS[1].midnight_address);
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "GET /metrics/unknown-channel → 404",
  fn: async () => {
    const { status, body } = await getJSON(server, "/metrics/nonexistent");
    assertEquals(status, 404);
    assertExists(body.error);
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

// ── GET /metrics/users/:address ───────────────────────────────────────────────

Deno.test({
  name: "GET /metrics/users/:address → 200 with identity + empty achievements",
  fn: async () => {
    const addr = FIXTURE_ROWS[0].midnight_address;
    const { status, body } = await getJSON(server, `/metrics/users/${addr}`);
    assertEquals(status, 200);
    assertExists(body.identity);
    assertEquals(body.identity.address, addr);
    assertEquals(Array.isArray(body.identity.delegatedFrom), true);
    assertEquals(Array.isArray(body.achievements), true);
    // No channel param → no channels field
    assertEquals(body.channels, undefined);
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "GET /metrics/users/:address?channel=leaderboard → includes channel stats",
  fn: async () => {
    const addr = FIXTURE_ROWS[0].midnight_address;
    const { status, body } = await getJSON(server, `/metrics/users/${addr}?channel=leaderboard`);
    assertEquals(status, 200);
    assertExists(body.channels);
    assertExists(body.channels.leaderboard);
    const ch = body.channels.leaderboard;
    assertExists(ch.stats);
    assertEquals(ch.stats.score, 310);
    assertEquals(ch.stats.rank, 1);
    assertExists(ch.stats.matchesPlayed);
    assertExists(ch.startDate);
    assertExists(ch.endDate);
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "GET /metrics/users/:address?channel=leaderboard → rank reflects position",
  fn: async () => {
    // Third player (lowest score) should have rank 3
    const addr = FIXTURE_ROWS[2].midnight_address;
    const { status, body } = await getJSON(server, `/metrics/users/${addr}?channel=leaderboard`);
    assertEquals(status, 200);
    assertEquals(body.channels.leaderboard.stats.rank, 3);
    assertEquals(body.channels.leaderboard.stats.score, 10);
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "GET /metrics/users/unknown → 404",
  fn: async () => {
    const { status, body } = await getJSON(server, "/metrics/users/doesnotexist");
    assertEquals(status, 404);
    assertExists(body.error);
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "GET /metrics/users/:address — unknown channel param is silently skipped",
  fn: async () => {
    const addr = FIXTURE_ROWS[0].midnight_address;
    const { status, body } = await getJSON(server, `/metrics/users/${addr}?channel=nonexistent`);
    assertEquals(status, 200);
    // channels object exists but the unknown channel is absent
    assertExists(body.channels);
    assertEquals(body.channels.nonexistent, undefined);
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "GET /metrics/users/:address — identity.delegatedFrom is always an array",
  fn: async () => {
    const addr = FIXTURE_ROWS[1].midnight_address;
    const { status, body } = await getJSON(server, `/metrics/users/${addr}`);
    assertEquals(status, 200);
    assertEquals(Array.isArray(body.identity.delegatedFrom), true);
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

// ── teardown ─────────────────────────────────────────────────────────────────

Deno.test({
  name: "teardown",
  fn: async () => {
    await server.close();
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

/**
 * Seed Leaderboard — populates go_fish_leaderboard with test data.
 *
 * Usage (run from packages/client/node):
 *   deno run -A scripts/seed-leaderboard.ts
 *
 * Environment variables:
 *   DB_URL  — postgres connection string (default: postgres://localhost:5432/go-fish)
 *             The dev stack uses PGLite on port 5432 with the "go-fish" database.
 *
 * Options (pass as CLI args):
 *   --clear     wipe go_fish_leaderboard before seeding
 *   --count=N   number of fake players to insert (default: 10)
 *
 * Example:
 *   deno run -A scripts/seed-leaderboard.ts --clear --count=20
 */

import { Pool } from "pg";

// ---------------------------------------------------------------------------
// Parse CLI flags
// ---------------------------------------------------------------------------
const args = Deno.args;
const shouldClear = args.includes("--clear");
const countArg = args.find(a => a.startsWith("--count="));
const count = countArg ? Math.max(1, parseInt(countArg.split("=")[1], 10)) : 10;

// ---------------------------------------------------------------------------
// Database connection
// ---------------------------------------------------------------------------
const DB_URL =
  Deno.env.get("DB_URL") ||
  Deno.env.get("DATABASE_URL") ||
  "postgres://localhost:5432/go-fish";

const pool = new Pool({ connectionString: DB_URL });

// ---------------------------------------------------------------------------
// Fake data helpers
// ---------------------------------------------------------------------------

/** Generate a plausible-looking Midnight shielded address (64 hex chars). */
function fakeAddress(seed: number): string {
  const base = seed.toString(16).padStart(8, "0");
  // Deterministic but varied: repeat the seed-derived bytes to 64 chars.
  return (base.repeat(8)).slice(0, 64);
}

interface PlayerSeed {
  midnightAddress: string;
  gamesPlayed: number;
  gamesWon: number;
  totalPoints: number;
}

function generatePlayers(n: number): PlayerSeed[] {
  const players: PlayerSeed[] = [];
  for (let i = 1; i <= n; i++) {
    // Vary play count: more experienced players have played more games
    const gamesPlayed = Math.floor(Math.random() * 20) + 1;
    const gamesWon = Math.floor(Math.random() * (gamesPlayed + 1));
    const gamesLost = gamesPlayed - gamesWon;
    const totalPoints = gamesWon * 100 + gamesLost * 10;

    players.push({
      midnightAddress: fakeAddress(i * 0xdeadbeef),
      gamesPlayed,
      gamesWon,
      totalPoints,
    });
  }
  return players;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const client = await pool.connect();

  try {
    console.log(`[seed-leaderboard] Connecting to: ${DB_URL.replace(/\/\/.*@/, "//***@")}`);

    // Verify the leaderboard table exists
    const tableCheck = await client.query(`
      SELECT to_regclass('public.go_fish_leaderboard') AS tbl
    `);
    if (!tableCheck.rows[0]?.tbl) {
      console.error(
        "[seed-leaderboard] ERROR: go_fish_leaderboard table does not exist.\n" +
        "  Run the node server once so the migration applies, then retry."
      );
      Deno.exit(1);
    }

    if (shouldClear) {
      await client.query("DELETE FROM go_fish_leaderboard");
      console.log("[seed-leaderboard] Cleared existing leaderboard entries.");
    }

    const players = generatePlayers(count);
    let inserted = 0;

    for (const p of players) {
      await client.query(
        `INSERT INTO go_fish_leaderboard
           (midnight_address, total_points, games_played, games_won, last_updated_block)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (midnight_address) DO UPDATE SET
           total_points       = go_fish_leaderboard.total_points + EXCLUDED.total_points,
           games_played       = go_fish_leaderboard.games_played + EXCLUDED.games_played,
           games_won          = go_fish_leaderboard.games_won + EXCLUDED.games_won,
           last_updated_block = EXCLUDED.last_updated_block`,
        [p.midnightAddress, p.totalPoints, p.gamesPlayed, p.gamesWon, Date.now()]
      );
      inserted++;
      console.log(
        `[seed-leaderboard] Inserted ${p.midnightAddress.slice(0, 16)}… ` +
          `points=${p.totalPoints} won=${p.gamesWon}/${p.gamesPlayed}`
      );
    }

    // Show top 5 after seeding
    const top = await client.query(
      `SELECT midnight_address, total_points, games_won, games_played
       FROM go_fish_leaderboard
       ORDER BY total_points DESC
       LIMIT 5`
    );

    console.log(`\n[seed-leaderboard] Done — inserted ${inserted} player(s). Top 5:`);
    top.rows.forEach((row, i) => {
      console.log(
        `  ${i + 1}. ${row.midnight_address.slice(0, 16)}…  ` +
          `${row.total_points} pts  ${row.games_won}W/${row.games_played}G`
      );
    });
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[seed-leaderboard] Fatal error:", err.message ?? err);
  Deno.exit(1);
});

/**
 * Leaderboard score calculation and persistence.
 *
 * Called once per game when the game phase transitions to "finished".
 * Only players who registered a Midnight shielded address are tracked.
 *
 * Scoring:
 *  - 100 pts: winner
 *  - 10 pts: loser (participation)
 */

import type { Pool } from "pg";

const POINTS_WIN = 100;
const POINTS_LOSS = 10;

export async function calculateAndPersistScores(
  lobbyId: string,
  winnerPlayerId: 1 | 2,
  blockHeight: number,
  dbConn: Pool,
): Promise<void> {
  console.log(`[leaderboard] Calculating scores for lobby=${lobbyId} winner=player${winnerPlayerId}`);

  // Fetch midnight addresses for all players ordered by join time.
  // Join order determines player ID assignment (first joined = player 1).
  const result = await dbConn.query<{ account_id: number; midnight_address: string }>(
    `SELECT account_id, midnight_address
     FROM lobby_players
     WHERE lobby_id = $1 AND midnight_address IS NOT NULL
     ORDER BY joined_at ASC`,
    [lobbyId]
  );

  if (result.rows.length === 0) {
    console.log(`[leaderboard] lobby=${lobbyId}: no players with Midnight addresses — skipping`);
    return;
  }

  for (let i = 0; i < result.rows.length; i++) {
    const player = result.rows[i];
    const position = i + 1; // 1-indexed; position 1 = player 1 (host/first joined)
    const isWinner = position === winnerPlayerId;
    const points = isWinner ? POINTS_WIN : POINTS_LOSS;

    await dbConn.query(
      `INSERT INTO go_fish_leaderboard
         (midnight_address, total_points, games_played, games_won, last_updated_block)
       VALUES ($1, $2, 1, $3, $4)
       ON CONFLICT (midnight_address) DO UPDATE SET
         total_points       = go_fish_leaderboard.total_points + EXCLUDED.total_points,
         games_played       = go_fish_leaderboard.games_played + 1,
         games_won          = go_fish_leaderboard.games_won + EXCLUDED.games_won,
         last_updated_block = EXCLUDED.last_updated_block`,
      [player.midnight_address, points, isWinner ? 1 : 0, blockHeight]
    );

    console.log(
      `[leaderboard] lobby=${lobbyId} midnight=${player.midnight_address.slice(0, 16)}…` +
        ` position=${position} isWinner=${isWinner} points=${points}`
    );
  }

  console.log(`[leaderboard] lobby=${lobbyId}: scores persisted for ${result.rows.length} player(s)`);
}

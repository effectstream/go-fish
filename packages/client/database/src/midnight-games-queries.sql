/* @name InsertMidnightGame */
INSERT INTO midnight_games (midnight_id, evm_id, state)
VALUES (:midnightId!, :evmId!, 'ongoing')
ON CONFLICT (midnight_id) DO NOTHING;

/* @name SetMidnightGameHostPubkey */
UPDATE midnight_games
SET host_pubkey = :hostPubkey!
WHERE midnight_id = :midnightId!;

/* @name SetMidnightGameJoinerPubkey */
UPDATE midnight_games
SET joiner_pubkey = :joinerPubkey!
WHERE midnight_id = :midnightId!;

/* @name SetMidnightGameWinner */
UPDATE midnight_games
SET state = :state!,
    ended_at = CURRENT_TIMESTAMP
WHERE midnight_id = :midnightId! AND ended_at IS NULL;

/* @name GetMidnightGame */
SELECT * FROM midnight_games WHERE midnight_id = :midnightId!;

/* @name UpsertLeaderboardScore */
INSERT INTO go_fish_leaderboard
  (midnight_address, total_points, games_played, games_won, last_updated_block)
VALUES (:address!, :points!, 1, :won!, :blockHeight!)
ON CONFLICT (midnight_address) DO UPDATE SET
  total_points       = go_fish_leaderboard.total_points + EXCLUDED.total_points,
  games_played       = go_fish_leaderboard.games_played + 1,
  games_won          = go_fish_leaderboard.games_won + EXCLUDED.games_won,
  last_updated_block = EXCLUDED.last_updated_block;

/* @name MarkMidnightGameScored */
UPDATE midnight_games SET scored = true WHERE midnight_id = :midnightId!;

/* @name FinishLobby */
UPDATE lobbies
SET status = 'finished', ended_at = CURRENT_TIMESTAMP
WHERE lobby_id = :lobbyId! AND status = 'in_progress';

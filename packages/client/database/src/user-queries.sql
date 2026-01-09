/* @name GetUserProfile */
SELECT
    account_id,
    display_name,
    games_played,
    games_won,
    created_at
FROM user_game_state
WHERE account_id = :accountId;

/* @name SetUserName */
INSERT INTO user_game_state (account_id, display_name)
VALUES (:accountId, :displayName)
ON CONFLICT (account_id)
DO UPDATE SET
    display_name = EXCLUDED.display_name,
    updated_at = CURRENT_TIMESTAMP;

/* @name IncrementGamesPlayed */
UPDATE user_game_state
SET
    games_played = games_played + 1,
    updated_at = CURRENT_TIMESTAMP
WHERE account_id = :accountId;

/* @name IncrementGamesWon */
UPDATE user_game_state
SET
    games_won = games_won + 1,
    updated_at = CURRENT_TIMESTAMP
WHERE account_id = :accountId;

/* @name GetLeaderboard */
SELECT
    account_id,
    display_name,
    games_played,
    games_won,
    CASE
        WHEN games_played > 0 THEN ROUND((games_won::float / games_played::float) * 100, 2)
        ELSE 0
    END as win_rate
FROM user_game_state
WHERE games_played > 0
ORDER BY games_won DESC, win_rate DESC
LIMIT :limit;

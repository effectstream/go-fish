/* @name GetGameState */
SELECT
    g.game_id,
    g.status,
    g.phase,
    g.max_players,
    g.current_round,
    g.created_at,
    g.started_at
FROM games g
WHERE g.game_id = :gameId;

/* @name GetGamePlayers */
SELECT
    gp.account_id,
    gp.role,
    gp.is_alive,
    u.display_name
FROM game_players gp
LEFT JOIN user_game_state u ON gp.account_id = u.account_id
WHERE gp.game_id = :gameId;

/* @name CreateGame */
INSERT INTO games (max_players)
VALUES (:maxPlayers)
RETURNING game_id;

/* @name JoinGame */
INSERT INTO game_players (game_id, account_id)
VALUES (:gameId, :accountId)
ON CONFLICT DO NOTHING;

/* @name GetActiveGames */
SELECT
    game_id,
    status,
    phase,
    max_players,
    (SELECT COUNT(*) FROM game_players WHERE game_id = g.game_id) as player_count,
    created_at
FROM games g
WHERE status IN ('waiting', 'active')
ORDER BY created_at DESC;

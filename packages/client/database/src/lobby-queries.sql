/* @name CreateLobby */
INSERT INTO lobbies (lobby_id, lobby_name, host_account_id, status)
VALUES (:lobbyId, :lobbyName, :hostAccountId, 'open')
RETURNING *;

/* @name JoinLobby */
INSERT INTO lobby_players (lobby_id, account_id, player_name)
VALUES (:lobbyId, :accountId, :playerName)
ON CONFLICT (lobby_id, account_id) DO NOTHING
RETURNING *;

/* @name GetOpenLobbies */
SELECT
    l.lobby_id,
    l.lobby_name,
    l.status,
    l.created_at,
    (SELECT COUNT(*) FROM lobby_players WHERE lobby_id = l.lobby_id) as player_count
FROM lobbies l
WHERE l.status = 'open'
  AND l.created_at > NOW() - INTERVAL '10 minutes'
ORDER BY l.created_at DESC
LIMIT :count OFFSET :offset;

/* @name GetUserLobbies */
SELECT
    l.lobby_id,
    l.lobby_name,
    l.status,
    l.created_at,
    (SELECT COUNT(*) FROM lobby_players WHERE lobby_id = l.lobby_id) as player_count
FROM lobbies l
INNER JOIN lobby_players lp ON l.lobby_id = lp.lobby_id
WHERE lp.account_id = :accountId
ORDER BY l.created_at DESC
LIMIT :count OFFSET :offset;

/* @name GetLobbyState */
SELECT
    l.lobby_id,
    l.lobby_name,
    l.host_account_id,
    l.status,
    l.created_at,
    l.started_at
FROM lobbies l
WHERE l.lobby_id = :lobbyId;

/* @name GetLobbyPlayers */
SELECT
    lp.account_id,
    lp.player_name,
    lp.joined_at,
    a.address as wallet_address
FROM lobby_players lp
INNER JOIN effectstream.accounts a ON lp.account_id = a.account_id
WHERE lp.lobby_id = :lobbyId
ORDER BY lp.joined_at ASC;

/* @name CountLobbyPlayers */
SELECT COUNT(*)::int as count FROM lobby_players WHERE lobby_id = :lobbyId;

/* @name StartGame */
UPDATE lobbies
SET status = 'in_progress', started_at = CURRENT_TIMESTAMP
WHERE lobby_id = :lobbyId AND status = 'open'
RETURNING *;

/* @name DeleteLobbyPlayers */
DELETE FROM lobby_players WHERE lobby_id = :lobbyId;

/* @name DeleteLobby */
DELETE FROM lobbies WHERE lobby_id = :lobbyId;

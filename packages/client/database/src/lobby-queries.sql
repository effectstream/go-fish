/* @name CreateLobby */
INSERT INTO lobbies (lobby_id, lobby_name, host_account_id, max_players, status)
VALUES (:lobbyId, :lobbyName, :hostAccountId, :maxPlayers, 'open')
RETURNING *;

/* @name JoinLobby */
INSERT INTO lobby_players (lobby_id, account_id, player_name, is_ready)
VALUES (:lobbyId, :accountId, :playerName, false)
ON CONFLICT (lobby_id, account_id) DO UPDATE SET
  player_name = EXCLUDED.player_name,
  is_ready = false
RETURNING *;

/* @name LeaveLobby */
DELETE FROM lobby_players
WHERE lobby_id = :lobbyId AND account_id = :accountId;

/* @name GetOpenLobbies */
SELECT
    l.lobby_id,
    l.lobby_name,
    l.max_players,
    l.status,
    l.created_at,
    (SELECT COUNT(*) FROM lobby_players WHERE lobby_id = l.lobby_id) as player_count
FROM lobbies l
WHERE l.status = 'open'
ORDER BY l.created_at DESC
LIMIT :count OFFSET :offset;

/* @name GetUserLobbies */
SELECT
    l.lobby_id,
    l.lobby_name,
    l.max_players,
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
    l.max_players,
    l.status,
    l.created_at,
    l.started_at
FROM lobbies l
WHERE l.lobby_id = :lobbyId;

/* @name GetLobbyPlayers */
SELECT
    lp.account_id,
    lp.player_name,
    lp.is_ready,
    lp.joined_at,
    a.address as wallet_address
FROM lobby_players lp
INNER JOIN effectstream.accounts a ON lp.account_id = a.account_id
WHERE lp.lobby_id = :lobbyId
ORDER BY lp.joined_at ASC;

/* @name TogglePlayerReady */
UPDATE lobby_players
SET is_ready = NOT is_ready
WHERE lobby_id = :lobbyId AND account_id = :accountId
RETURNING is_ready;

/* @name StartGame */
UPDATE lobbies
SET status = 'in_progress', started_at = CURRENT_TIMESTAMP
WHERE lobby_id = :lobbyId AND host_account_id = :hostAccountId
RETURNING *;

/* @name CloseLobby */
UPDATE lobbies
SET status = 'finished', ended_at = CURRENT_TIMESTAMP
WHERE lobby_id = :lobbyId AND host_account_id = :hostAccountId
RETURNING *;

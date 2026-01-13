/** Types generated for queries found in "src/lobby-queries.sql" */
import { PreparedQuery } from '@pgtyped/runtime';

/** Query 'CreateLobby' is invalid, so its result is assigned type 'never'.
 *  */
export type CreateLobbyResult = never;

/** Query 'CreateLobby' is invalid, so its parameters are assigned type 'never'.
 *  */
export type CreateLobbyParams = never;

const createLobbyIR: any = {"usedParamSet":{"lobbyId":true,"lobbyName":true,"hostAccountId":true,"maxPlayers":true},"params":[{"name":"lobbyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":89,"b":96}]},{"name":"lobbyName","required":false,"transform":{"type":"scalar"},"locs":[{"a":99,"b":108}]},{"name":"hostAccountId","required":false,"transform":{"type":"scalar"},"locs":[{"a":111,"b":124}]},{"name":"maxPlayers","required":false,"transform":{"type":"scalar"},"locs":[{"a":127,"b":137}]}],"statement":"INSERT INTO lobbies (lobby_id, lobby_name, host_account_id, max_players, status)\nVALUES (:lobbyId, :lobbyName, :hostAccountId, :maxPlayers, 'open')\nRETURNING *"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO lobbies (lobby_id, lobby_name, host_account_id, max_players, status)
 * VALUES (:lobbyId, :lobbyName, :hostAccountId, :maxPlayers, 'open')
 * RETURNING *
 * ```
 */
export const createLobby = new PreparedQuery<CreateLobbyParams,CreateLobbyResult>(createLobbyIR);


/** Query 'JoinLobby' is invalid, so its result is assigned type 'never'.
 *  */
export type JoinLobbyResult = never;

/** Query 'JoinLobby' is invalid, so its parameters are assigned type 'never'.
 *  */
export type JoinLobbyParams = never;

const joinLobbyIR: any = {"usedParamSet":{"lobbyId":true,"accountId":true,"playerName":true},"params":[{"name":"lobbyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":80,"b":87}]},{"name":"accountId","required":false,"transform":{"type":"scalar"},"locs":[{"a":90,"b":99}]},{"name":"playerName","required":false,"transform":{"type":"scalar"},"locs":[{"a":102,"b":112}]}],"statement":"INSERT INTO lobby_players (lobby_id, account_id, player_name, is_ready)\nVALUES (:lobbyId, :accountId, :playerName, false)\nON CONFLICT (lobby_id, account_id) DO NOTHING\nRETURNING *"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO lobby_players (lobby_id, account_id, player_name, is_ready)
 * VALUES (:lobbyId, :accountId, :playerName, false)
 * ON CONFLICT (lobby_id, account_id) DO NOTHING
 * RETURNING *
 * ```
 */
export const joinLobby = new PreparedQuery<JoinLobbyParams,JoinLobbyResult>(joinLobbyIR);


/** Query 'LeaveLobby' is invalid, so its result is assigned type 'never'.
 *  */
export type LeaveLobbyResult = never;

/** Query 'LeaveLobby' is invalid, so its parameters are assigned type 'never'.
 *  */
export type LeaveLobbyParams = never;

const leaveLobbyIR: any = {"usedParamSet":{"lobbyId":true,"accountId":true},"params":[{"name":"lobbyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":43,"b":50}]},{"name":"accountId","required":false,"transform":{"type":"scalar"},"locs":[{"a":69,"b":78}]}],"statement":"DELETE FROM lobby_players\nWHERE lobby_id = :lobbyId AND account_id = :accountId"};

/**
 * Query generated from SQL:
 * ```
 * DELETE FROM lobby_players
 * WHERE lobby_id = :lobbyId AND account_id = :accountId
 * ```
 */
export const leaveLobby = new PreparedQuery<LeaveLobbyParams,LeaveLobbyResult>(leaveLobbyIR);


/** Query 'GetOpenLobbies' is invalid, so its result is assigned type 'never'.
 *  */
export type GetOpenLobbiesResult = never;

/** Query 'GetOpenLobbies' is invalid, so its parameters are assigned type 'never'.
 *  */
export type GetOpenLobbiesParams = never;

const getOpenLobbiesIR: any = {"usedParamSet":{"count":true,"offset":true},"params":[{"name":"count","required":false,"transform":{"type":"scalar"},"locs":[{"a":249,"b":254}]},{"name":"offset","required":false,"transform":{"type":"scalar"},"locs":[{"a":263,"b":269}]}],"statement":"SELECT\n    l.lobby_id,\n    l.lobby_name,\n    l.max_players,\n    l.status,\n    l.created_at,\n    (SELECT COUNT(*) FROM lobby_players WHERE lobby_id = l.lobby_id) as player_count\nFROM lobbies l\nWHERE l.status = 'open'\nORDER BY l.created_at DESC\nLIMIT :count OFFSET :offset"};

/**
 * Query generated from SQL:
 * ```
 * SELECT
 *     l.lobby_id,
 *     l.lobby_name,
 *     l.max_players,
 *     l.status,
 *     l.created_at,
 *     (SELECT COUNT(*) FROM lobby_players WHERE lobby_id = l.lobby_id) as player_count
 * FROM lobbies l
 * WHERE l.status = 'open'
 * ORDER BY l.created_at DESC
 * LIMIT :count OFFSET :offset
 * ```
 */
export const getOpenLobbies = new PreparedQuery<GetOpenLobbiesParams,GetOpenLobbiesResult>(getOpenLobbiesIR);


/** Query 'GetUserLobbies' is invalid, so its result is assigned type 'never'.
 *  */
export type GetUserLobbiesResult = never;

/** Query 'GetUserLobbies' is invalid, so its parameters are assigned type 'never'.
 *  */
export type GetUserLobbiesParams = never;

const getUserLobbiesIR: any = {"usedParamSet":{"accountId":true,"count":true,"offset":true},"params":[{"name":"accountId","required":false,"transform":{"type":"scalar"},"locs":[{"a":270,"b":279}]},{"name":"count","required":false,"transform":{"type":"scalar"},"locs":[{"a":314,"b":319}]},{"name":"offset","required":false,"transform":{"type":"scalar"},"locs":[{"a":328,"b":334}]}],"statement":"SELECT\n    l.lobby_id,\n    l.lobby_name,\n    l.max_players,\n    l.status,\n    l.created_at,\n    (SELECT COUNT(*) FROM lobby_players WHERE lobby_id = l.lobby_id) as player_count\nFROM lobbies l\nINNER JOIN lobby_players lp ON l.lobby_id = lp.lobby_id\nWHERE lp.account_id = :accountId\nORDER BY l.created_at DESC\nLIMIT :count OFFSET :offset"};

/**
 * Query generated from SQL:
 * ```
 * SELECT
 *     l.lobby_id,
 *     l.lobby_name,
 *     l.max_players,
 *     l.status,
 *     l.created_at,
 *     (SELECT COUNT(*) FROM lobby_players WHERE lobby_id = l.lobby_id) as player_count
 * FROM lobbies l
 * INNER JOIN lobby_players lp ON l.lobby_id = lp.lobby_id
 * WHERE lp.account_id = :accountId
 * ORDER BY l.created_at DESC
 * LIMIT :count OFFSET :offset
 * ```
 */
export const getUserLobbies = new PreparedQuery<GetUserLobbiesParams,GetUserLobbiesResult>(getUserLobbiesIR);


/** Query 'GetLobbyState' is invalid, so its result is assigned type 'never'.
 *  */
export type GetLobbyStateResult = never;

/** Query 'GetLobbyState' is invalid, so its parameters are assigned type 'never'.
 *  */
export type GetLobbyStateParams = never;

const getLobbyStateIR: any = {"usedParamSet":{"lobbyId":true},"params":[{"name":"lobbyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":166,"b":173}]}],"statement":"SELECT\n    l.lobby_id,\n    l.lobby_name,\n    l.host_account_id,\n    l.max_players,\n    l.status,\n    l.created_at,\n    l.started_at\nFROM lobbies l\nWHERE l.lobby_id = :lobbyId"};

/**
 * Query generated from SQL:
 * ```
 * SELECT
 *     l.lobby_id,
 *     l.lobby_name,
 *     l.host_account_id,
 *     l.max_players,
 *     l.status,
 *     l.created_at,
 *     l.started_at
 * FROM lobbies l
 * WHERE l.lobby_id = :lobbyId
 * ```
 */
export const getLobbyState = new PreparedQuery<GetLobbyStateParams,GetLobbyStateResult>(getLobbyStateIR);


/** Query 'GetLobbyPlayers' is invalid, so its result is assigned type 'never'.
 *  */
export type GetLobbyPlayersResult = never;

/** Query 'GetLobbyPlayers' is invalid, so its parameters are assigned type 'never'.
 *  */
export type GetLobbyPlayersParams = never;

const getLobbyPlayersIR: any = {"usedParamSet":{"lobbyId":true},"params":[{"name":"lobbyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":222,"b":229}]}],"statement":"SELECT\n    lp.account_id,\n    lp.player_name,\n    lp.is_ready,\n    lp.joined_at,\n    a.address as wallet_address\nFROM lobby_players lp\nINNER JOIN effectstream.accounts a ON lp.account_id = a.account_id\nWHERE lp.lobby_id = :lobbyId\nORDER BY lp.joined_at ASC"};

/**
 * Query generated from SQL:
 * ```
 * SELECT
 *     lp.account_id,
 *     lp.player_name,
 *     lp.is_ready,
 *     lp.joined_at,
 *     a.address as wallet_address
 * FROM lobby_players lp
 * INNER JOIN effectstream.accounts a ON lp.account_id = a.account_id
 * WHERE lp.lobby_id = :lobbyId
 * ORDER BY lp.joined_at ASC
 * ```
 */
export const getLobbyPlayers = new PreparedQuery<GetLobbyPlayersParams,GetLobbyPlayersResult>(getLobbyPlayersIR);


/** Query 'TogglePlayerReady' is invalid, so its result is assigned type 'never'.
 *  */
export type TogglePlayerReadyResult = never;

/** Query 'TogglePlayerReady' is invalid, so its parameters are assigned type 'never'.
 *  */
export type TogglePlayerReadyParams = never;

const togglePlayerReadyIR: any = {"usedParamSet":{"lobbyId":true,"accountId":true},"params":[{"name":"lobbyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":66,"b":73}]},{"name":"accountId","required":false,"transform":{"type":"scalar"},"locs":[{"a":92,"b":101}]}],"statement":"UPDATE lobby_players\nSET is_ready = NOT is_ready\nWHERE lobby_id = :lobbyId AND account_id = :accountId\nRETURNING is_ready"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE lobby_players
 * SET is_ready = NOT is_ready
 * WHERE lobby_id = :lobbyId AND account_id = :accountId
 * RETURNING is_ready
 * ```
 */
export const togglePlayerReady = new PreparedQuery<TogglePlayerReadyParams,TogglePlayerReadyResult>(togglePlayerReadyIR);


/** Query 'StartGame' is invalid, so its result is assigned type 'never'.
 *  */
export type StartGameResult = never;

/** Query 'StartGame' is invalid, so its parameters are assigned type 'never'.
 *  */
export type StartGameParams = never;

const startGameIR: any = {"usedParamSet":{"lobbyId":true,"hostAccountId":true},"params":[{"name":"lobbyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":91,"b":98}]},{"name":"hostAccountId","required":false,"transform":{"type":"scalar"},"locs":[{"a":122,"b":135}]}],"statement":"UPDATE lobbies\nSET status = 'in_progress', started_at = CURRENT_TIMESTAMP\nWHERE lobby_id = :lobbyId AND host_account_id = :hostAccountId\nRETURNING *"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE lobbies
 * SET status = 'in_progress', started_at = CURRENT_TIMESTAMP
 * WHERE lobby_id = :lobbyId AND host_account_id = :hostAccountId
 * RETURNING *
 * ```
 */
export const startGame = new PreparedQuery<StartGameParams,StartGameResult>(startGameIR);


/** Query 'CloseLobby' is invalid, so its result is assigned type 'never'.
 *  */
export type CloseLobbyResult = never;

/** Query 'CloseLobby' is invalid, so its parameters are assigned type 'never'.
 *  */
export type CloseLobbyParams = never;

const closeLobbyIR: any = {"usedParamSet":{"lobbyId":true,"hostAccountId":true},"params":[{"name":"lobbyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":86,"b":93}]},{"name":"hostAccountId","required":false,"transform":{"type":"scalar"},"locs":[{"a":117,"b":130}]}],"statement":"UPDATE lobbies\nSET status = 'finished', ended_at = CURRENT_TIMESTAMP\nWHERE lobby_id = :lobbyId AND host_account_id = :hostAccountId\nRETURNING *"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE lobbies
 * SET status = 'finished', ended_at = CURRENT_TIMESTAMP
 * WHERE lobby_id = :lobbyId AND host_account_id = :hostAccountId
 * RETURNING *
 * ```
 */
export const closeLobby = new PreparedQuery<CloseLobbyParams,CloseLobbyResult>(closeLobbyIR);



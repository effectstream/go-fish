/** Types generated for queries found in "src/lobby-queries.sql" */
import { PreparedQuery } from '@pgtyped/runtime';

/** 'CreateLobby' parameters type */
export type ICreateLobbyParams = {
  lobbyId: string;
  lobbyName: string;
  hostAccountId: number;
};

/** 'CreateLobby' return type */
export type ICreateLobbyResult = any;

const createLobbyIR: any = {"usedParamSet":{"lobbyId":true,"lobbyName":true,"hostAccountId":true},"params":[{"name":"lobbyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":76,"b":83}]},{"name":"lobbyName","required":false,"transform":{"type":"scalar"},"locs":[{"a":86,"b":95}]},{"name":"hostAccountId","required":false,"transform":{"type":"scalar"},"locs":[{"a":98,"b":111}]}],"statement":"INSERT INTO lobbies (lobby_id, lobby_name, host_account_id, status)\nVALUES (:lobbyId, :lobbyName, :hostAccountId, 'open')\nRETURNING *"};

/**
 * ```
 * INSERT INTO lobbies (lobby_id, lobby_name, host_account_id, status)
 * VALUES (:lobbyId, :lobbyName, :hostAccountId, 'open')
 * RETURNING *
 * ```
 */
export const createLobby = new PreparedQuery<ICreateLobbyParams, ICreateLobbyResult>(createLobbyIR);


/** 'JoinLobby' parameters type */
export type IJoinLobbyParams = {
  lobbyId: string;
  accountId: number;
  playerName: string;
};

/** 'JoinLobby' return type */
export type IJoinLobbyResult = any;

const joinLobbyIR: any = {"usedParamSet":{"lobbyId":true,"accountId":true,"playerName":true},"params":[{"name":"lobbyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":70,"b":77}]},{"name":"accountId","required":false,"transform":{"type":"scalar"},"locs":[{"a":80,"b":89}]},{"name":"playerName","required":false,"transform":{"type":"scalar"},"locs":[{"a":92,"b":102}]}],"statement":"INSERT INTO lobby_players (lobby_id, account_id, player_name)\nVALUES (:lobbyId, :accountId, :playerName)\nON CONFLICT (lobby_id, account_id) DO NOTHING\nRETURNING *"};

/**
 * ```
 * INSERT INTO lobby_players (lobby_id, account_id, player_name)
 * VALUES (:lobbyId, :accountId, :playerName)
 * ON CONFLICT (lobby_id, account_id) DO NOTHING
 * RETURNING *
 * ```
 */
export const joinLobby = new PreparedQuery<IJoinLobbyParams, IJoinLobbyResult>(joinLobbyIR);


/** 'GetOpenLobbies' parameters type */
export type IGetOpenLobbiesParams = {
  count: number;
  offset: number;
};

/** 'GetOpenLobbies' return type */
export type IGetOpenLobbiesResult = any;

const getOpenLobbiesIR: any = {"usedParamSet":{"count":true,"offset":true},"params":[{"name":"count","required":false,"transform":{"type":"scalar"},"locs":[{"a":281,"b":286}]},{"name":"offset","required":false,"transform":{"type":"scalar"},"locs":[{"a":295,"b":301}]}],"statement":"SELECT\n    l.lobby_id,\n    l.lobby_name,\n    l.status,\n    l.created_at,\n    (SELECT COUNT(*) FROM lobby_players WHERE lobby_id = l.lobby_id) as player_count\nFROM lobbies l\nWHERE l.status = 'open'\n  AND l.created_at > NOW() - INTERVAL '10 minutes'\nORDER BY l.created_at DESC\nLIMIT :count OFFSET :offset"};

/**
 * ```
 * SELECT
 *     l.lobby_id,
 *     l.lobby_name,
 *     l.status,
 *     l.created_at,
 *     (SELECT COUNT(*) FROM lobby_players WHERE lobby_id = l.lobby_id) as player_count
 * FROM lobbies l
 * WHERE l.status = 'open'
 *   AND l.created_at > NOW() - INTERVAL '10 minutes'
 * ORDER BY l.created_at DESC
 * LIMIT :count OFFSET :offset
 * ```
 */
export const getOpenLobbies = new PreparedQuery<IGetOpenLobbiesParams, IGetOpenLobbiesResult>(getOpenLobbiesIR);


/** 'GetUserLobbies' parameters type */
export type IGetUserLobbiesParams = {
  accountId: number;
  count: number;
  offset: number;
};

/** 'GetUserLobbies' return type */
export type IGetUserLobbiesResult = any;

const getUserLobbiesIR: any = {"usedParamSet":{"accountId":true,"count":true,"offset":true},"params":[{"name":"accountId","required":false,"transform":{"type":"scalar"},"locs":[{"a":251,"b":260}]},{"name":"count","required":false,"transform":{"type":"scalar"},"locs":[{"a":295,"b":300}]},{"name":"offset","required":false,"transform":{"type":"scalar"},"locs":[{"a":309,"b":315}]}],"statement":"SELECT\n    l.lobby_id,\n    l.lobby_name,\n    l.status,\n    l.created_at,\n    (SELECT COUNT(*) FROM lobby_players WHERE lobby_id = l.lobby_id) as player_count\nFROM lobbies l\nINNER JOIN lobby_players lp ON l.lobby_id = lp.lobby_id\nWHERE lp.account_id = :accountId\nORDER BY l.created_at DESC\nLIMIT :count OFFSET :offset"};

/**
 * ```
 * SELECT
 *     l.lobby_id,
 *     l.lobby_name,
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
export const getUserLobbies = new PreparedQuery<IGetUserLobbiesParams, IGetUserLobbiesResult>(getUserLobbiesIR);


/** 'GetLobbyState' parameters type */
export type IGetLobbyStateParams = {
  lobbyId: string;
};

/** 'GetLobbyState' return type */
export type IGetLobbyStateResult = any;

const getLobbyStateIR: any = {"usedParamSet":{"lobbyId":true},"params":[{"name":"lobbyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":147,"b":154}]}],"statement":"SELECT\n    l.lobby_id,\n    l.lobby_name,\n    l.host_account_id,\n    l.status,\n    l.created_at,\n    l.started_at\nFROM lobbies l\nWHERE l.lobby_id = :lobbyId"};

/**
 * ```
 * SELECT
 *     l.lobby_id,
 *     l.lobby_name,
 *     l.host_account_id,
 *     l.status,
 *     l.created_at,
 *     l.started_at
 * FROM lobbies l
 * WHERE l.lobby_id = :lobbyId
 * ```
 */
export const getLobbyState = new PreparedQuery<IGetLobbyStateParams, IGetLobbyStateResult>(getLobbyStateIR);


/** 'GetLobbyPlayers' parameters type */
export type IGetLobbyPlayersParams = {
  lobbyId: string;
};

/** 'GetLobbyPlayers' return type */
export type IGetLobbyPlayersResult = any;

const getLobbyPlayersIR: any = {"usedParamSet":{"lobbyId":true},"params":[{"name":"lobbyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":205,"b":212}]}],"statement":"SELECT\n    lp.account_id,\n    lp.player_name,\n    lp.joined_at,\n    a.address as wallet_address\nFROM lobby_players lp\nINNER JOIN effectstream.accounts a ON lp.account_id = a.account_id\nWHERE lp.lobby_id = :lobbyId\nORDER BY lp.joined_at ASC"};

/**
 * ```
 * SELECT
 *     lp.account_id,
 *     lp.player_name,
 *     lp.joined_at,
 *     a.address as wallet_address
 * FROM lobby_players lp
 * INNER JOIN effectstream.accounts a ON lp.account_id = a.account_id
 * WHERE lp.lobby_id = :lobbyId
 * ORDER BY lp.joined_at ASC
 * ```
 */
export const getLobbyPlayers = new PreparedQuery<IGetLobbyPlayersParams, IGetLobbyPlayersResult>(getLobbyPlayersIR);


/** 'CountLobbyPlayers' parameters type */
export type ICountLobbyPlayersParams = {
  lobbyId: string;
};

/** 'CountLobbyPlayers' return type */
export type ICountLobbyPlayersResult = any;

const countLobbyPlayersIR: any = {"usedParamSet":{"lobbyId":true},"params":[{"name":"lobbyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":66,"b":73}]}],"statement":"SELECT COUNT(*)::int as count FROM lobby_players WHERE lobby_id = :lobbyId"};

/**
 * ```
 * SELECT COUNT(*)::int as count FROM lobby_players WHERE lobby_id = :lobbyId
 * ```
 */
export const countLobbyPlayers = new PreparedQuery<ICountLobbyPlayersParams, ICountLobbyPlayersResult>(countLobbyPlayersIR);


/** 'StartGame' parameters type */
export type IStartGameParams = {
  lobbyId: string;
};

/** 'StartGame' return type */
export type IStartGameResult = any;

const startGameIR: any = {"usedParamSet":{"lobbyId":true},"params":[{"name":"lobbyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":91,"b":98}]}],"statement":"UPDATE lobbies\nSET status = 'in_progress', started_at = CURRENT_TIMESTAMP\nWHERE lobby_id = :lobbyId AND status = 'open'\nRETURNING *"};

/**
 * ```
 * UPDATE lobbies
 * SET status = 'in_progress', started_at = CURRENT_TIMESTAMP
 * WHERE lobby_id = :lobbyId AND status = 'open'
 * RETURNING *
 * ```
 */
export const startGame = new PreparedQuery<IStartGameParams, IStartGameResult>(startGameIR);


/** 'SetHostMaskApplied' parameters type */
export type ISetHostMaskAppliedParams = {
  lobbyId: string;
};

/** 'SetHostMaskApplied' return type */
export type ISetHostMaskAppliedResult = any;

const setHostMaskAppliedIR: any = {"usedParamSet":{"lobbyId":true},"params":[{"name":"lobbyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":61,"b":68}]}],"statement":"UPDATE lobbies\nSET host_mask_applied = true\nWHERE lobby_id = :lobbyId\nRETURNING *"};

/**
 * ```
 * UPDATE lobbies
 * SET host_mask_applied = true
 * WHERE lobby_id = :lobbyId
 * RETURNING *
 * ```
 */
export const setHostMaskApplied = new PreparedQuery<ISetHostMaskAppliedParams, ISetHostMaskAppliedResult>(setHostMaskAppliedIR);


/** 'DeleteLobbyPlayers' parameters type */
export type IDeleteLobbyPlayersParams = {
  lobbyId: string;
};

/** 'DeleteLobbyPlayers' return type */
export type IDeleteLobbyPlayersResult = any;

const deleteLobbyPlayersIR: any = {"usedParamSet":{"lobbyId":true},"params":[{"name":"lobbyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":43,"b":50}]}],"statement":"DELETE FROM lobby_players WHERE lobby_id = :lobbyId"};

/**
 * ```
 * DELETE FROM lobby_players WHERE lobby_id = :lobbyId
 * ```
 */
export const deleteLobbyPlayers = new PreparedQuery<IDeleteLobbyPlayersParams, IDeleteLobbyPlayersResult>(deleteLobbyPlayersIR);


/** 'DeleteLobby' parameters type */
export type IDeleteLobbyParams = {
  lobbyId: string;
};

/** 'DeleteLobby' return type */
export type IDeleteLobbyResult = any;

const deleteLobbyIR: any = {"usedParamSet":{"lobbyId":true},"params":[{"name":"lobbyId","required":false,"transform":{"type":"scalar"},"locs":[{"a":37,"b":44}]}],"statement":"DELETE FROM lobbies WHERE lobby_id = :lobbyId"};

/**
 * ```
 * DELETE FROM lobbies WHERE lobby_id = :lobbyId
 * ```
 */
export const deleteLobby = new PreparedQuery<IDeleteLobbyParams, IDeleteLobbyResult>(deleteLobbyIR);

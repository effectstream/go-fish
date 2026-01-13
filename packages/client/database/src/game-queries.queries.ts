/** Types generated for queries found in "src/game-queries.sql" */
import { PreparedQuery } from '@pgtyped/runtime';

/** Query 'GetGameState' is invalid, so its result is assigned type 'never'.
 *  */
export type GetGameStateResult = never;

/** Query 'GetGameState' is invalid, so its parameters are assigned type 'never'.
 *  */
export type GetGameStateParams = never;

const getGameStateIR: any = {"usedParamSet":{"gameId":true},"params":[{"name":"gameId","required":false,"transform":{"type":"scalar"},"locs":[{"a":155,"b":161}]}],"statement":"SELECT\n    g.game_id,\n    g.status,\n    g.phase,\n    g.max_players,\n    g.current_round,\n    g.created_at,\n    g.started_at\nFROM games g\nWHERE g.game_id = :gameId"};

/**
 * Query generated from SQL:
 * ```
 * SELECT
 *     g.game_id,
 *     g.status,
 *     g.phase,
 *     g.max_players,
 *     g.current_round,
 *     g.created_at,
 *     g.started_at
 * FROM games g
 * WHERE g.game_id = :gameId
 * ```
 */
export const getGameState = new PreparedQuery<GetGameStateParams,GetGameStateResult>(getGameStateIR);


/** Query 'GetGamePlayers' is invalid, so its result is assigned type 'never'.
 *  */
export type GetGamePlayersResult = never;

/** Query 'GetGamePlayers' is invalid, so its parameters are assigned type 'never'.
 *  */
export type GetGamePlayersParams = never;

const getGamePlayersIR: any = {"usedParamSet":{"gameId":true},"params":[{"name":"gameId","required":false,"transform":{"type":"scalar"},"locs":[{"a":175,"b":181}]}],"statement":"SELECT\n    gp.account_id,\n    gp.role,\n    gp.is_alive,\n    u.display_name\nFROM game_players gp\nLEFT JOIN user_game_state u ON gp.account_id = u.account_id\nWHERE gp.game_id = :gameId"};

/**
 * Query generated from SQL:
 * ```
 * SELECT
 *     gp.account_id,
 *     gp.role,
 *     gp.is_alive,
 *     u.display_name
 * FROM game_players gp
 * LEFT JOIN user_game_state u ON gp.account_id = u.account_id
 * WHERE gp.game_id = :gameId
 * ```
 */
export const getGamePlayers = new PreparedQuery<GetGamePlayersParams,GetGamePlayersResult>(getGamePlayersIR);


/** Query 'CreateGame' is invalid, so its result is assigned type 'never'.
 *  */
export type CreateGameResult = never;

/** Query 'CreateGame' is invalid, so its parameters are assigned type 'never'.
 *  */
export type CreateGameParams = never;

const createGameIR: any = {"usedParamSet":{"maxPlayers":true},"params":[{"name":"maxPlayers","required":false,"transform":{"type":"scalar"},"locs":[{"a":40,"b":50}]}],"statement":"INSERT INTO games (max_players)\nVALUES (:maxPlayers)\nRETURNING game_id"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO games (max_players)
 * VALUES (:maxPlayers)
 * RETURNING game_id
 * ```
 */
export const createGame = new PreparedQuery<CreateGameParams,CreateGameResult>(createGameIR);


/** Query 'JoinGame' is invalid, so its result is assigned type 'never'.
 *  */
export type JoinGameResult = never;

/** Query 'JoinGame' is invalid, so its parameters are assigned type 'never'.
 *  */
export type JoinGameParams = never;

const joinGameIR: any = {"usedParamSet":{"gameId":true,"accountId":true},"params":[{"name":"gameId","required":false,"transform":{"type":"scalar"},"locs":[{"a":55,"b":61}]},{"name":"accountId","required":false,"transform":{"type":"scalar"},"locs":[{"a":64,"b":73}]}],"statement":"INSERT INTO game_players (game_id, account_id)\nVALUES (:gameId, :accountId)\nON CONFLICT DO NOTHING"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO game_players (game_id, account_id)
 * VALUES (:gameId, :accountId)
 * ON CONFLICT DO NOTHING
 * ```
 */
export const joinGame = new PreparedQuery<JoinGameParams,JoinGameResult>(joinGameIR);


/** Query 'GetActiveGames' is invalid, so its result is assigned type 'never'.
 *  */
export type GetActiveGamesResult = never;

/** Query 'GetActiveGames' is invalid, so its parameters are assigned type 'never'.
 *  */
export type GetActiveGamesParams = never;

const getActiveGamesIR: any = {"usedParamSet":{},"params":[],"statement":"SELECT\n    game_id,\n    status,\n    phase,\n    max_players,\n    (SELECT COUNT(*) FROM game_players WHERE game_id = g.game_id) as player_count,\n    created_at\nFROM games g\nWHERE status IN ('waiting', 'active')\nORDER BY created_at DESC"};

/**
 * Query generated from SQL:
 * ```
 * SELECT
 *     game_id,
 *     status,
 *     phase,
 *     max_players,
 *     (SELECT COUNT(*) FROM game_players WHERE game_id = g.game_id) as player_count,
 *     created_at
 * FROM games g
 * WHERE status IN ('waiting', 'active')
 * ORDER BY created_at DESC
 * ```
 */
export const getActiveGames = new PreparedQuery<GetActiveGamesParams,GetActiveGamesResult>(getActiveGamesIR);



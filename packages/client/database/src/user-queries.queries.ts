/** Types generated for queries found in "src/user-queries.sql" */
import { PreparedQuery } from '@pgtyped/runtime';

/** Query 'GetUserProfile' is invalid, so its result is assigned type 'never'.
 *  */
export type GetUserProfileResult = never;

/** Query 'GetUserProfile' is invalid, so its parameters are assigned type 'never'.
 *  */
export type GetUserProfileParams = never;

const getUserProfileIR: any = {"usedParamSet":{"accountId":true},"params":[{"name":"accountId","required":false,"transform":{"type":"scalar"},"locs":[{"a":129,"b":138}]}],"statement":"SELECT\n    account_id,\n    display_name,\n    games_played,\n    games_won,\n    created_at\nFROM user_game_state\nWHERE account_id = :accountId"};

/**
 * Query generated from SQL:
 * ```
 * SELECT
 *     account_id,
 *     display_name,
 *     games_played,
 *     games_won,
 *     created_at
 * FROM user_game_state
 * WHERE account_id = :accountId
 * ```
 */
export const getUserProfile = new PreparedQuery<GetUserProfileParams,GetUserProfileResult>(getUserProfileIR);


/** Query 'SetUserName' is invalid, so its result is assigned type 'never'.
 *  */
export type SetUserNameResult = never;

/** Query 'SetUserName' is invalid, so its parameters are assigned type 'never'.
 *  */
export type SetUserNameParams = never;

const setUserNameIR: any = {"usedParamSet":{"accountId":true,"displayName":true},"params":[{"name":"accountId","required":false,"transform":{"type":"scalar"},"locs":[{"a":63,"b":72}]},{"name":"displayName","required":false,"transform":{"type":"scalar"},"locs":[{"a":75,"b":86}]}],"statement":"INSERT INTO user_game_state (account_id, display_name)\nVALUES (:accountId, :displayName)\nON CONFLICT (account_id)\nDO UPDATE SET\n    display_name = EXCLUDED.display_name,\n    updated_at = CURRENT_TIMESTAMP"};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO user_game_state (account_id, display_name)
 * VALUES (:accountId, :displayName)
 * ON CONFLICT (account_id)
 * DO UPDATE SET
 *     display_name = EXCLUDED.display_name,
 *     updated_at = CURRENT_TIMESTAMP
 * ```
 */
export const setUserName = new PreparedQuery<SetUserNameParams,SetUserNameResult>(setUserNameIR);


/** Query 'IncrementGamesPlayed' is invalid, so its result is assigned type 'never'.
 *  */
export type IncrementGamesPlayedResult = never;

/** Query 'IncrementGamesPlayed' is invalid, so its parameters are assigned type 'never'.
 *  */
export type IncrementGamesPlayedParams = never;

const incrementGamesPlayedIR: any = {"usedParamSet":{"accountId":true},"params":[{"name":"accountId","required":false,"transform":{"type":"scalar"},"locs":[{"a":118,"b":127}]}],"statement":"UPDATE user_game_state\nSET\n    games_played = games_played + 1,\n    updated_at = CURRENT_TIMESTAMP\nWHERE account_id = :accountId"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE user_game_state
 * SET
 *     games_played = games_played + 1,
 *     updated_at = CURRENT_TIMESTAMP
 * WHERE account_id = :accountId
 * ```
 */
export const incrementGamesPlayed = new PreparedQuery<IncrementGamesPlayedParams,IncrementGamesPlayedResult>(incrementGamesPlayedIR);


/** Query 'IncrementGamesWon' is invalid, so its result is assigned type 'never'.
 *  */
export type IncrementGamesWonResult = never;

/** Query 'IncrementGamesWon' is invalid, so its parameters are assigned type 'never'.
 *  */
export type IncrementGamesWonParams = never;

const incrementGamesWonIR: any = {"usedParamSet":{"accountId":true},"params":[{"name":"accountId","required":false,"transform":{"type":"scalar"},"locs":[{"a":112,"b":121}]}],"statement":"UPDATE user_game_state\nSET\n    games_won = games_won + 1,\n    updated_at = CURRENT_TIMESTAMP\nWHERE account_id = :accountId"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE user_game_state
 * SET
 *     games_won = games_won + 1,
 *     updated_at = CURRENT_TIMESTAMP
 * WHERE account_id = :accountId
 * ```
 */
export const incrementGamesWon = new PreparedQuery<IncrementGamesWonParams,IncrementGamesWonResult>(incrementGamesWonIR);


/** Query 'GetLeaderboard' is invalid, so its result is assigned type 'never'.
 *  */
export type GetLeaderboardResult = never;

/** Query 'GetLeaderboard' is invalid, so its parameters are assigned type 'never'.
 *  */
export type GetLeaderboardParams = never;

const getLeaderboardIR: any = {"usedParamSet":{"limit":true},"params":[{"name":"limit","required":false,"transform":{"type":"scalar"},"locs":[{"a":299,"b":304}]}],"statement":"SELECT\n    account_id,\n    display_name,\n    games_played,\n    games_won,\n    CASE\n        WHEN games_played > 0 THEN ROUND((games_won::float / games_played::float) * 100, 2)\n        ELSE 0\n    END as win_rate\nFROM user_game_state\nWHERE games_played > 0\nORDER BY games_won DESC, win_rate DESC\nLIMIT :limit"};

/**
 * Query generated from SQL:
 * ```
 * SELECT
 *     account_id,
 *     display_name,
 *     games_played,
 *     games_won,
 *     CASE
 *         WHEN games_played > 0 THEN ROUND((games_won::float / games_played::float) * 100, 2)
 *         ELSE 0
 *     END as win_rate
 * FROM user_game_state
 * WHERE games_played > 0
 * ORDER BY games_won DESC, win_rate DESC
 * LIMIT :limit
 * ```
 */
export const getLeaderboard = new PreparedQuery<GetLeaderboardParams,GetLeaderboardResult>(getLeaderboardIR);



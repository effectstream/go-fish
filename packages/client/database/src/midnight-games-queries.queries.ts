/** Types for queries in "src/midnight-games-queries.sql".
 *  IRs are built at module load by scanning the SQL for `:paramName` tokens,
 *  so we don't hand-count offsets the way pgtyped codegen does. Behavior at
 *  runtime is identical — PreparedQuery only reads `statement`, `params`, and
 *  `usedParamSet` from the IR to substitute named params with $N placeholders. */

import { PreparedQuery } from "@pgtyped/runtime";

type Loc = { a: number; b: number };
type ParamSpec = {
  name: string;
  required: boolean;
  transform: { type: "scalar" };
  locs: Loc[];
};

function buildIR(sql: string, paramNames: string[]) {
  const locs = new Map<string, Loc[]>(paramNames.map((n) => [n, []]));
  const re = /:([a-zA-Z_][a-zA-Z0-9_]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const name = m[1];
    const bucket = locs.get(name);
    if (bucket) bucket.push({ a: m.index, b: m.index + m[0].length - 1 });
  }
  const usedParamSet: Record<string, true> = {};
  const params: ParamSpec[] = paramNames.map((n) => {
    usedParamSet[n] = true;
    return {
      name: n,
      required: false,
      transform: { type: "scalar" },
      locs: locs.get(n) ?? [],
    };
  });
  return { usedParamSet, params, statement: sql };
}

// ---------------------------------------------------------------------------
// InsertMidnightGame
// ---------------------------------------------------------------------------

export type IInsertMidnightGameParams = {
  midnightId: string;
  evmId: string;
};
export type IInsertMidnightGameResult = any;

const insertMidnightGameIR: any = buildIR(
  "INSERT INTO midnight_games (midnight_id, evm_id, state)\n" +
    "VALUES (:midnightId, :evmId, 'ongoing')\n" +
    "ON CONFLICT (midnight_id) DO NOTHING",
  ["midnightId", "evmId"],
);

export const insertMidnightGame = new PreparedQuery<
  IInsertMidnightGameParams,
  IInsertMidnightGameResult
>(insertMidnightGameIR);

// ---------------------------------------------------------------------------
// SetMidnightGameHostPubkey
// ---------------------------------------------------------------------------

export type ISetMidnightGameHostPubkeyParams = {
  midnightId: string;
  hostPubkey: string;
};
export type ISetMidnightGameHostPubkeyResult = any;

const setMidnightGameHostPubkeyIR: any = buildIR(
  "UPDATE midnight_games\n" +
    "SET host_pubkey = :hostPubkey\n" +
    "WHERE midnight_id = :midnightId",
  ["hostPubkey", "midnightId"],
);

export const setMidnightGameHostPubkey = new PreparedQuery<
  ISetMidnightGameHostPubkeyParams,
  ISetMidnightGameHostPubkeyResult
>(setMidnightGameHostPubkeyIR);

// ---------------------------------------------------------------------------
// SetMidnightGameJoinerPubkey
// ---------------------------------------------------------------------------

export type ISetMidnightGameJoinerPubkeyParams = {
  midnightId: string;
  joinerPubkey: string;
};
export type ISetMidnightGameJoinerPubkeyResult = any;

const setMidnightGameJoinerPubkeyIR: any = buildIR(
  "UPDATE midnight_games\n" +
    "SET joiner_pubkey = :joinerPubkey\n" +
    "WHERE midnight_id = :midnightId",
  ["joinerPubkey", "midnightId"],
);

export const setMidnightGameJoinerPubkey = new PreparedQuery<
  ISetMidnightGameJoinerPubkeyParams,
  ISetMidnightGameJoinerPubkeyResult
>(setMidnightGameJoinerPubkeyIR);

// ---------------------------------------------------------------------------
// SetMidnightGameWinner
// ---------------------------------------------------------------------------

export type ISetMidnightGameWinnerParams = {
  midnightId: string;
  state: string;
};
export type ISetMidnightGameWinnerResult = any;

const setMidnightGameWinnerIR: any = buildIR(
  "UPDATE midnight_games\n" +
    "SET state = :state,\n" +
    "    ended_at = CURRENT_TIMESTAMP\n" +
    "WHERE midnight_id = :midnightId AND ended_at IS NULL",
  ["state", "midnightId"],
);

export const setMidnightGameWinner = new PreparedQuery<
  ISetMidnightGameWinnerParams,
  ISetMidnightGameWinnerResult
>(setMidnightGameWinnerIR);

// ---------------------------------------------------------------------------
// GetMidnightGame
// ---------------------------------------------------------------------------

export type IGetMidnightGameParams = {
  midnightId: string;
};
export type IGetMidnightGameResult = any;

const getMidnightGameIR: any = buildIR(
  "SELECT * FROM midnight_games WHERE midnight_id = :midnightId",
  ["midnightId"],
);

export const getMidnightGame = new PreparedQuery<
  IGetMidnightGameParams,
  IGetMidnightGameResult
>(getMidnightGameIR);

// ---------------------------------------------------------------------------
// UpsertLeaderboardScore
// ---------------------------------------------------------------------------

export type IUpsertLeaderboardScoreParams = {
  address: string;
  points: number;
  won: number;
  blockHeight: number;
};
export type IUpsertLeaderboardScoreResult = any;

const upsertLeaderboardScoreIR: any = buildIR(
  "INSERT INTO go_fish_leaderboard\n" +
    "  (midnight_address, total_points, games_played, games_won, last_updated_block)\n" +
    "VALUES (:address, :points, 1, :won, :blockHeight)\n" +
    "ON CONFLICT (midnight_address) DO UPDATE SET\n" +
    "  total_points       = go_fish_leaderboard.total_points + EXCLUDED.total_points,\n" +
    "  games_played       = go_fish_leaderboard.games_played + 1,\n" +
    "  games_won          = go_fish_leaderboard.games_won + EXCLUDED.games_won,\n" +
    "  last_updated_block = EXCLUDED.last_updated_block",
  ["address", "points", "won", "blockHeight"],
);

export const upsertLeaderboardScore = new PreparedQuery<
  IUpsertLeaderboardScoreParams,
  IUpsertLeaderboardScoreResult
>(upsertLeaderboardScoreIR);

// ---------------------------------------------------------------------------
// MarkMidnightGameScored
// ---------------------------------------------------------------------------

export type IMarkMidnightGameScoredParams = {
  midnightId: string;
};
export type IMarkMidnightGameScoredResult = any;

const markMidnightGameScoredIR: any = buildIR(
  "UPDATE midnight_games SET scored = true WHERE midnight_id = :midnightId",
  ["midnightId"],
);

export const markMidnightGameScored = new PreparedQuery<
  IMarkMidnightGameScoredParams,
  IMarkMidnightGameScoredResult
>(markMidnightGameScoredIR);

// ---------------------------------------------------------------------------
// FinishLobby
// ---------------------------------------------------------------------------

export type IFinishLobbyParams = {
  lobbyId: string;
};
export type IFinishLobbyResult = any;

const finishLobbyIR: any = buildIR(
  "UPDATE lobbies\n" +
    "SET status = 'finished', ended_at = CURRENT_TIMESTAMP\n" +
    "WHERE lobby_id = :lobbyId AND status = 'in_progress'",
  ["lobbyId"],
);

export const finishLobby = new PreparedQuery<
  IFinishLobbyParams,
  IFinishLobbyResult
>(finishLobbyIR);

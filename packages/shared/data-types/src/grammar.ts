/**
 * Grammar definitions for Effectstream command parsing
 * Go Fish Game - Defines the concise encoding format for on-chain commands
 */

import type { GrammarDefinition } from "@effectstream/concise";
import { Type } from "@sinclair/typebox";
import { builtinGrammars } from "@effectstream/sm/grammar";

const PlayerName = Type.String({ minLength: 1, maxLength: 20 });
const LobbyName = Type.String({ minLength: 1, maxLength: 30 });
const LobbyID = Type.String({ minLength: 1, maxLength: 100 });

export const effectstreamL2Grammar = {
  createdLobby: [
    ["playerName", PlayerName],
    ["lobbyName", LobbyName],
  ],
  joinedLobby: [
    ["playerName", PlayerName],
    ["lobbyID", LobbyID],
  ],
  closedLobby: [["lobbyID", LobbyID]],
  hostReady: [["lobbyID", LobbyID]],
  cleanupGame: [["gameId", LobbyID]],
} as const satisfies GrammarDefinition;

export const grammar = {
  ...effectstreamL2Grammar,
  "event_midnight": builtinGrammars.midnightGeneric,
} as const satisfies GrammarDefinition;

/** @deprecated Use effectstreamL2Grammar */
export const goFishL2Grammar = effectstreamL2Grammar;

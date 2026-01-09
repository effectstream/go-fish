/**
 * Grammar definitions for Paima Engine command parsing
 *
 * This defines the concise encoding format for on-chain commands.
 */

import type { GrammarDefinition } from "@paimaexample/concise";
import { Type } from "@sinclair/typebox";

export const werewolfL2Grammar = {
  setName: [["name", Type.String()]],

  createGame: [
    ["maxPlayers", Type.Integer()],
  ],

  joinGame: [
    ["gameId", Type.Integer()],
  ],

  vote: [
    ["gameId", Type.Integer()],
    ["targetId", Type.Integer()],
  ],

  nightAction: [
    ["gameId", Type.Integer()],
    ["actionType", Type.String()],
    ["targetId", Type.Integer()],
  ],
} as const satisfies GrammarDefinition;

export const grammar = {
  ...werewolfL2Grammar,
} as const satisfies GrammarDefinition;

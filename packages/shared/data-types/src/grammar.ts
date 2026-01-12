/**
 * Grammar definitions for Paima Engine command parsing
 * Go Fish Game - Defines the concise encoding format for on-chain commands
 */

import type { GrammarDefinition } from "@paimaexample/concise";
import { Type } from "@sinclair/typebox";

// Custom types for Go Fish
const PlayerName = Type.String({ minLength: 1, maxLength: 20 });
const LobbyID = Type.String({ minLength: 12, maxLength: 12 });
const PlayerID = Type.String({ minLength: 1, maxLength: 100 });
const Rank = Type.Union([
  Type.Literal('2'),
  Type.Literal('3'),
  Type.Literal('4'),
  Type.Literal('5'),
  Type.Literal('6'),
  Type.Literal('7'),
  Type.Literal('8'),
  Type.Literal('9'),
  Type.Literal('10'),
  Type.Literal('J'),
  Type.Literal('Q'),
  Type.Literal('K'),
  Type.Literal('A'),
]);

export const goFishL2Grammar = {
  /**
   * Create Lobby: c|playerName|maxPlayers
   * Example: c|Alice|4
   */
  createdLobby: [
    ['playerName', PlayerName],
    ['maxPlayers', Type.Number({ minimum: 2, maximum: 6 })],
  ],

  /**
   * Join Lobby: j|playerName|lobbyID
   * Example: j|Bob|abc123def456
   */
  joinedLobby: [
    ['playerName', PlayerName],
    ['lobbyID', LobbyID],
  ],

  /**
   * Leave Lobby: l|lobbyID
   * Example: l|abc123def456
   */
  leftLobby: [['lobbyID', LobbyID]],

  /**
   * Toggle Ready: r|lobbyID
   * Example: r|abc123def456
   */
  toggledReady: [['lobbyID', LobbyID]],

  /**
   * Start Game (Host only): start|lobbyID
   * Example: start|abc123def456
   */
  startedGame: [['lobbyID', LobbyID]],

  /**
   * Ask For Card: ask|lobbyID|targetPlayerID|rank
   * Example: ask|abc123def456|player_123|K
   */
  askedForCard: [
    ['lobbyID', LobbyID],
    ['targetPlayerID', PlayerID],
    ['rank', Rank],
  ],

  /**
   * Close Lobby (Host only): close|lobbyID
   * Example: close|abc123def456
   */
  closedLobby: [['lobbyID', LobbyID]],
} as const satisfies GrammarDefinition;

export const grammar = {
  ...goFishL2Grammar,
} as const satisfies GrammarDefinition;

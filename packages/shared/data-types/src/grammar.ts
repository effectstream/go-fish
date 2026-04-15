/**
 * Grammar definitions for Paima Engine command parsing
 * Go Fish Game - Defines the concise encoding format for on-chain commands
 */

import type { GrammarDefinition } from "@paimaexample/concise";
import { Type } from "@sinclair/typebox";

const PlayerName = Type.String({ minLength: 1, maxLength: 20 });
const LobbyName = Type.String({ minLength: 1, maxLength: 30 });
const LobbyID = Type.String({ minLength: 1, maxLength: 100 });

export const goFishL2Grammar = {
  /**
   * Create Lobby: c|playerName|lobbyName
   * Example: c|Alice|Alice's Game
   *
   * Max players is a constant (2) and is not transmitted.
   */
  createdLobby: [
    ['playerName', PlayerName],
    ['lobbyName', LobbyName],
  ],

  /**
   * Join Lobby: j|playerName|lobbyID
   * Example: j|Bob|abc123def456
   *
   * Auto-starts the game — the second joiner always fills the 2-player lobby,
   * so the state machine flips status to 'in_progress' in the same transition.
   */
  joinedLobby: [
    ['playerName', PlayerName],
    ['lobbyID', LobbyID],
  ],

  /**
   * Close Lobby (host only, while alone): close|lobbyID
   * Example: close|abc123def456
   *
   * Host cancels an open lobby before a second player has joined.
   * The state machine deletes the lobby row and its lobby_players row.
   */
  closedLobby: [['lobbyID', LobbyID]],
} as const satisfies GrammarDefinition;

export const grammar = {
  ...goFishL2Grammar,
} as const satisfies GrammarDefinition;

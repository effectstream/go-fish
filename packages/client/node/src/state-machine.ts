/**
 * State Machine - Defines how game state transitions based on blockchain events
 */

import { PaimaSTM } from "@paimaexample/sm";
import { grammar } from "@go-fish/data-types/grammar";
import type { StartConfigGameStateTransitions } from "@paimaexample/runtime";
import { World } from "@paimaexample/coroutine";
import {
  getAddressByAddress,
  newAddressWithId,
  newAccount
} from "@paimaexample/db";
import type { Pool } from "pg";

const stm = new PaimaSTM<typeof grammar, any>(grammar);

/**
 * Simple prepared query interface that mimics pgtyped
 */
interface SimplePreparedQuery<P, R> {
  run(params: P, client: Pool): Promise<R[]>;
}

/**
 * Helper to create raw SQL prepared query
 */
function createRawQuery<P, R>(sql: string): SimplePreparedQuery<P, R> {
  return {
    run: async (params: P, client: Pool): Promise<R[]> => {
      const paramValues = Object.values(params);
      const result = await client.query(sql, paramValues);
      return result.rows as R[];
    }
  };
}

/**
 * Handle createdLobby command - create a new game lobby
 */
stm.addStateTransition("createdLobby", function* (data) {
  const { playerName, maxPlayers } = data.parsedInput;
  const walletAddress = data.signerAddress;

  console.log(`🎮 [createdLobby] Creating lobby - Player: ${playerName}, Max Players: ${maxPlayers}, Wallet: ${walletAddress}`);

  // Generate unique lobby ID based on block height and timestamp
  const lobbyId = `lobby_${data.blockHeight}_${Date.now()}`;

  // Get or create account ID for this wallet address
  const addressResult = yield* World.resolve(
    getAddressByAddress,
    { address: walletAddress! }
  );

  let accountId: number;
  if (addressResult && addressResult.length > 0) {
    accountId = addressResult[0].account_id;
  } else {
    // Create new account
    const newAccountResult = yield* World.resolve(
      newAccount,
      { primary_address: walletAddress! }
    );

    if (!newAccountResult || newAccountResult.length === 0) {
      console.error('[createdLobby] Failed to create account');
      return;
    }

    accountId = newAccountResult[0].id;

    // Link address to account
    yield* World.resolve(
      newAddressWithId,
      {
        address: walletAddress!,
        address_type: 0,
        account_id: accountId
      }
    );
  }

  // Create raw SQL query for inserting lobby
  const insertLobbyQuery = createRawQuery<{
    lobby_id: string;
    lobby_name: string;
    host_account_id: number;
    max_players: number;
    status: string;
  }, void>(`
    INSERT INTO lobbies (lobby_id, lobby_name, host_account_id, max_players, status)
    VALUES ($1, $2, $3, $4, $5)
  `);

  yield* World.resolve(
    insertLobbyQuery,
    {
      lobby_id: lobbyId,
      lobby_name: `${playerName}'s Lobby`,
      host_account_id: accountId,
      max_players: maxPlayers,
      status: 'open'
    }
  );

  // Create raw SQL query for inserting lobby player
  const insertLobbyPlayerQuery = createRawQuery<{
    lobby_id: string;
    account_id: number;
    player_name: string;
    is_ready: boolean;
  }, void>(`
    INSERT INTO lobby_players (lobby_id, account_id, player_name, is_ready)
    VALUES ($1, $2, $3, $4)
  `);

  yield* World.resolve(
    insertLobbyPlayerQuery,
    {
      lobby_id: lobbyId,
      account_id: accountId,
      player_name: playerName,
      is_ready: false
    }
  );

  console.log(`✅ [createdLobby] Lobby created in database: ${lobbyId}`);
});

/**
 * Handle createGame command - create a new game lobby
 */
stm.addStateTransition("createGame", function* (data) {
  const { maxPlayers } = data.parsedInput;
  console.log(`🎮 [createGame] Creating game with max players: ${maxPlayers}`);
  // TODO: Implement game creation logic
  // yield* World.resolve(createGame, { max_players: maxPlayers });
});

/**
 * Handle joinGame command - player joins a game lobby
 */
stm.addStateTransition("joinGame", function* (data) {
  const { gameId } = data.parsedInput;
  console.log(`🎮 [joinGame] Joining game: ${gameId}`);
  // TODO: Implement game joining logic
  // yield* World.resolve(joinGame, { game_id: gameId, account_id: accountId });
});

/**
 * Handle vote command - player votes during game
 */
stm.addStateTransition("vote", function* (data) {
  const { gameId, targetId } = data.parsedInput;
  console.log(`🎮 [vote] Vote in game ${gameId} for target ${targetId}`);
  // TODO: Implement voting logic
  // yield* World.resolve(recordVote, { game_id: gameId, target_id: targetId });
});

/**
 * Handle nightAction command - player performs night action
 */
stm.addStateTransition("nightAction", function* (data) {
  const { gameId, actionType, targetId } = data.parsedInput;
  console.log(`🎮 [nightAction] Action ${actionType} in game ${gameId} on target ${targetId}`);
  // TODO: Implement night action logic
  // yield* World.resolve(recordNightAction, { game_id: gameId, action_type: actionType, target_id: targetId });
});

/**
 * Export state machine as game state transitions
 * In v0.3.128+, we manually create the generator function instead of using toStartConfig()
 */
export const gameStateTransitions: StartConfigGameStateTransitions = function* (
  blockHeight,
  input,
) {
  if (blockHeight >= 0) {
    yield* stm.processInput(input);
  }
  return;
};

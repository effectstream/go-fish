/**
 * State Machine - Defines how game state transitions based on blockchain events
 */

import { PaimaSTM } from "@paimaexample/sm";
import { grammar } from "@go-fish/data-types/grammar";
import type { StartConfigGameStateTransitions } from "@paimaexample/runtime";
import { World } from "@paimaexample/coroutine";
import type { Pool } from "pg";

const stm = new PaimaSTM<typeof grammar, any>(grammar);

/**
 * Handle createdLobby command - create a new game lobby
 */
stm.addStateTransition("createdLobby", function* (data) {
  const { playerName, maxPlayers } = data.parsedInput;
  const walletAddress = data.input.userAddress;

  console.log(`🎮 [createdLobby] Creating lobby - Player: ${playerName}, Max Players: ${maxPlayers}, Wallet: ${walletAddress}`);

  // Generate unique lobby ID based on block height and timestamp
  const lobbyId = `lobby_${data.blockHeight}_${Date.now()}`;

  // Access database from data.dbConn (passed by Paima runtime)
  const db = data.dbConn as Pool;

  try {
    // Get or create account ID for this wallet address
    const accountResult = yield* World.resolve(async () => {
      return await db.query(
        `INSERT INTO effectstream.accounts (address)
         VALUES ($1)
         ON CONFLICT (address) DO UPDATE SET address = EXCLUDED.address
         RETURNING account_id`,
        [walletAddress]
      );
    });

    const accountId = accountResult.rows[0]?.account_id;
    if (!accountId) {
      console.error('[createdLobby] Failed to get account ID');
      return;
    }

    // Insert lobby into database
    yield* World.resolve(async () => {
      return await db.query(
        `INSERT INTO lobbies (lobby_id, lobby_name, host_account_id, max_players, status)
         VALUES ($1, $2, $3, $4, 'open')`,
        [lobbyId, `${playerName}'s Lobby`, accountId, maxPlayers]
      );
    });

    // Add host as first player in lobby
    yield* World.resolve(async () => {
      return await db.query(
        `INSERT INTO lobby_players (lobby_id, account_id, player_name, is_ready)
         VALUES ($1, $2, $3, false)`,
        [lobbyId, accountId, playerName]
      );
    });

    console.log(`✅ [createdLobby] Lobby created in database: ${lobbyId}`);
  } catch (error) {
    console.error('[createdLobby] Database error:', error);
  }
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

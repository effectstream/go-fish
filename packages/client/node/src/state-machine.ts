/**
 * State Machine - Defines how game state transitions based on blockchain events
 */

import { PaimaSTM } from "@paimaexample/sm";
import { grammar } from "@go-fish/data-types/grammar";
import type { StartConfigGameStateTransitions } from "@paimaexample/runtime";
import { World } from "@paimaexample/coroutine";

const stm = new PaimaSTM<typeof grammar, any>(grammar);

/**
 * Handle setName command - allows players to set their display name
 */
stm.addStateTransition("setName", function* (data) {
  const { name } = data.parsedInput;
  if (!name || name.length < 3) {
    console.log(`[setName] No name provided or too short`);
    return;
  }
  if (name.length > 24) {
    console.log(`[setName] Name too long: ${name}`);
    return;
  }
  console.log(`🎮 [setName] Setting name to: ${name}`);
  // TODO: Implement database update
  // yield* World.resolve(setUserName, { account_id: accountId, name });
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

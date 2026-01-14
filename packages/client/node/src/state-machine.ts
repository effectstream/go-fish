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
  newAccount,
  updateAddressAccount
} from "@paimaexample/db";
import { createLobby, joinLobby, togglePlayerReady, startGame, leaveLobby } from "@go-fish/database";

const stm = new PaimaSTM<typeof grammar, any>(grammar);

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

  console.log('[createdLobby] addressResult:', addressResult);

  let accountId: number | undefined;

  // Check if address exists AND has a valid account_id
  if (addressResult && addressResult.length > 0 && addressResult[0].account_id !== null) {
    accountId = addressResult[0].account_id;
    console.log('[createdLobby] Found existing account:', accountId);
  } else {
    // Create new account (either address doesn't exist or account_id is null)
    console.log('[createdLobby] Creating new account for:', walletAddress);
    const newAccountResult = yield* World.resolve(
      newAccount,
      { primary_address: walletAddress! }
    );

    console.log('[createdLobby] newAccountResult:', newAccountResult);

    if (!newAccountResult || newAccountResult.length === 0) {
      console.error('[createdLobby] Failed to create account - empty result');
      return;
    }

    accountId = newAccountResult[0].id;
    console.log('[createdLobby] Created new account:', accountId);

    // If address already exists (but with null account_id), update it
    // Otherwise, create new address record
    if (addressResult && addressResult.length > 0) {
      console.log('[createdLobby] Updating existing address with new account_id');
      // Address exists but has null account_id - we need to update it
      yield* World.resolve(
        updateAddressAccount,
        {
          address: walletAddress!,
          account_id: accountId
        }
      );
    } else {
      console.log('[createdLobby] Creating new address record');
      // Link new address to account
      yield* World.resolve(
        newAddressWithId,
        {
          address: walletAddress!,
          address_type: 0,
          account_id: accountId
        }
      );
    }
  }

  if (!accountId) {
    console.error('[createdLobby] accountId is undefined after account resolution');
    return;
  }

  console.log('[createdLobby] Using accountId:', accountId);

  // Insert lobby using pgtyped query
  yield* World.resolve(
    createLobby,
    {
      lobbyId: lobbyId,
      lobbyName: `${playerName}'s Lobby`,
      hostAccountId: accountId,
      maxPlayers: maxPlayers
    }
  );

  // Add host as first player using pgtyped query
  yield* World.resolve(
    joinLobby,
    {
      lobbyId: lobbyId,
      accountId: accountId,
      playerName: playerName
    }
  );

  console.log(`✅ [createdLobby] Lobby created in database: ${lobbyId}`);
});

/**
 * Handle joinedLobby command - player joins an existing lobby
 */
stm.addStateTransition("joinedLobby", function* (data) {
  const { playerName, lobbyID } = data.parsedInput;
  const walletAddress = data.signerAddress;

  console.log(`🎮 [joinedLobby] Player ${playerName} joining lobby ${lobbyID} with wallet ${walletAddress}`);

  // Get or create account ID for this wallet address
  const addressResult = yield* World.resolve(
    getAddressByAddress,
    { address: walletAddress! }
  );

  console.log('[joinedLobby] addressResult:', addressResult);

  let accountId: number | undefined;

  // Check if address exists AND has a valid account_id
  if (addressResult && addressResult.length > 0 && addressResult[0].account_id !== null) {
    accountId = addressResult[0].account_id;
    console.log('[joinedLobby] Found existing account:', accountId);
  } else {
    // Create new account (either address doesn't exist or account_id is null)
    console.log('[joinedLobby] Creating new account for:', walletAddress);
    const newAccountResult = yield* World.resolve(
      newAccount,
      { primary_address: walletAddress! }
    );

    console.log('[joinedLobby] newAccountResult:', newAccountResult);

    if (!newAccountResult || newAccountResult.length === 0) {
      console.error('[joinedLobby] Failed to create account - empty result');
      return;
    }

    accountId = newAccountResult[0].id;
    console.log('[joinedLobby] Created new account:', accountId);

    // If address already exists (but with null account_id), update it
    // Otherwise, create new address record
    if (addressResult && addressResult.length > 0) {
      console.log('[joinedLobby] Updating existing address with new account_id');
      yield* World.resolve(
        updateAddressAccount,
        {
          address: walletAddress!,
          account_id: accountId
        }
      );
    } else {
      console.log('[joinedLobby] Creating new address record');
      yield* World.resolve(
        newAddressWithId,
        {
          address: walletAddress!,
          address_type: 0,
          account_id: accountId
        }
      );
    }
  }

  if (!accountId) {
    console.error('[joinedLobby] accountId is undefined after account resolution');
    return;
  }

  console.log('[joinedLobby] Using accountId:', accountId);

  // Add player to lobby using pgtyped query
  yield* World.resolve(
    joinLobby,
    {
      lobbyId: lobbyID,
      accountId: accountId,
      playerName: playerName
    }
  );

  console.log(`✅ [joinedLobby] Player ${playerName} joined lobby ${lobbyID}`);
});

/**
 * Handle toggledReady command - player toggles ready status
 */
stm.addStateTransition("toggledReady", function* (data) {
  const { lobbyID } = data.parsedInput;
  const walletAddress = data.signerAddress;

  console.log(`🎮 [toggledReady] Player toggling ready in lobby ${lobbyID} with wallet ${walletAddress}`);

  // Get account ID for this wallet address
  const addressResult = yield* World.resolve(
    getAddressByAddress,
    { address: walletAddress! }
  );

  if (!addressResult || addressResult.length === 0 || addressResult[0].account_id === null) {
    console.error('[toggledReady] No account found for address:', walletAddress);
    return;
  }

  const accountId = addressResult[0].account_id;

  // Toggle ready status
  yield* World.resolve(
    togglePlayerReady,
    {
      lobbyId: lobbyID,
      accountId: accountId
    }
  );

  console.log(`✅ [toggledReady] Player ready status toggled in lobby ${lobbyID}`);
});

/**
 * Handle startedGame command - host starts the game
 */
stm.addStateTransition("startedGame", function* (data) {
  const { lobbyID } = data.parsedInput;
  const walletAddress = data.signerAddress;

  console.log(`🎮 [startedGame] Starting game for lobby ${lobbyID} by host ${walletAddress}`);

  // Get account ID for this wallet address
  const addressResult = yield* World.resolve(
    getAddressByAddress,
    { address: walletAddress! }
  );

  if (!addressResult || addressResult.length === 0 || addressResult[0].account_id === null) {
    console.error('[startedGame] No account found for address:', walletAddress);
    return;
  }

  const accountId = addressResult[0].account_id;

  // Update lobby status to 'in_progress'
  yield* World.resolve(
    startGame,
    {
      lobbyId: lobbyID,
      hostAccountId: accountId
    }
  );

  console.log(`✅ [startedGame] Game started for lobby ${lobbyID}`);
});

/**
 * Handle leftLobby command - player leaves a lobby
 */
stm.addStateTransition("leftLobby", function* (data) {
  const { lobbyID } = data.parsedInput;
  const walletAddress = data.signerAddress;

  console.log(`🎮 [leftLobby] Player leaving lobby ${lobbyID} with wallet ${walletAddress}`);

  // Get account ID for this wallet address
  const addressResult = yield* World.resolve(
    getAddressByAddress,
    { address: walletAddress! }
  );

  if (!addressResult || addressResult.length === 0 || addressResult[0].account_id === null) {
    console.error('[leftLobby] No account found for address:', walletAddress);
    return;
  }

  const accountId = addressResult[0].account_id;

  // Remove player from lobby
  yield* World.resolve(
    leaveLobby,
    {
      lobbyId: lobbyID,
      accountId: accountId
    }
  );

  console.log(`✅ [leftLobby] Player left lobby ${lobbyID}`);
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

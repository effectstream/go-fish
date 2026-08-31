/**
 * State Machine - Defines how game state transitions based on blockchain events
 *
 * Grammar commands (see packages/shared/data-types/src/grammar.ts):
 *   createdLobby  — host creates a new lobby (host is added as first player)
 *   joinedLobby   — second player joins; auto-starts the game
 *   closedLobby   — host cancels an open lobby while still alone
 */

import { Stm } from "@effectstream/sm";
import { grammar } from "@go-fish/data-types/grammar";
import type { StartConfigGameStateTransitions } from "@effectstream/runtime";
import { World } from "@effectstream/coroutine";
import {
  getAddressByAddress,
  newAddressWithId,
  newAccount,
  updateAddressAccount,
  newScheduledTimestampData,
} from "@effectstream/db";
import { AddressType } from "@effectstream/utils";
import {
  createLobby,
  joinLobby,
  startGame,
  getLobbyState,
  countLobbyPlayers,
  deleteLobbyPlayers,
  deleteLobby,
  setHostMaskApplied,
  finishLobby,
} from "@go-fish/database";
import * as path from "node:path";
import { computeLedgerDiff, logLedgerDiff } from "./ledger-diff.ts";
import { projectMidnightGamesFromDiff } from "./midnight-games-sync.ts";

const stm = new Stm<typeof grammar, any>(grammar);

// Go Fish is always a 2-player game.
const MAX_PLAYERS = 2;

/**
 * Handle createdLobby - host creates a new lobby
 */
stm.addStateTransition("createdLobby", function* (data) {
  const { playerName, lobbyName } = data.parsedInput;
  // Normalize to lowercase — Paima auto-creates effectstream.addresses
  // entries in lowercase, but data.signerAddress can be checksummed
  // (mixed-case). The framework's getAddressByAddress is case-sensitive,
  // so a mismatch creates a duplicate account and breaks wallet resolution.
  const walletAddress = data.signerAddress?.toLowerCase();
  if (!walletAddress) {
    console.error('[createdLobby] No signer address');
    return;
  }

  console.log(`🎮 [createdLobby] "${lobbyName}" by ${playerName} @ ${walletAddress}`);

  // Deterministic lobby ID: block height + short address slice.
  const addrSlug = walletAddress.slice(2, 10).toLowerCase();
  const lobbyId = `lobby_${data.blockHeight}_${addrSlug}`;

  // Resolve (or create) the account for this wallet.
  const addressResult = yield* World.resolve(
    getAddressByAddress,
    { address: walletAddress }
  );

  let accountId: number | undefined;

  if (addressResult && addressResult.length > 0 && addressResult[0].account_id !== null) {
    accountId = addressResult[0].account_id;
  } else {
    const newAccountResult = yield* World.resolve(
      newAccount,
      { primary_address: walletAddress }
    );
    if (!newAccountResult || newAccountResult.length === 0) {
      console.error('[createdLobby] Failed to create account');
      return;
    }
    accountId = newAccountResult[0].id;

    if (addressResult && addressResult.length > 0) {
      yield* World.resolve(
        updateAddressAccount,
        { address: walletAddress, account_id: accountId }
      );
    } else {
      yield* World.resolve(
        newAddressWithId,
        { address: walletAddress, address_type: 0, account_id: accountId }
      );
    }
  }

  if (!accountId) {
    console.error('[createdLobby] accountId undefined after resolution');
    return;
  }

  yield* World.resolve(
    createLobby,
    {
      lobbyId,
      lobbyName,
      hostAccountId: accountId,
    }
  );

  yield* World.resolve(
    joinLobby,
    {
      lobbyId,
      accountId,
      playerName,
    }
  );

  console.log(`✅ [createdLobby] created ${lobbyId}`);
});

/**
 * Handle joinedLobby - second player joins; auto-starts the game when full.
 */
stm.addStateTransition("joinedLobby", function* (data) {
  const { playerName, lobbyID } = data.parsedInput;
  const walletAddress = data.signerAddress?.toLowerCase();
  if (!walletAddress) {
    console.error('[joinedLobby] No signer address');
    return;
  }

  console.log(`🎮 [joinedLobby] ${playerName} → ${lobbyID} @ ${walletAddress}`);

  // Lobby must exist and still be open.
  const lobbyState = yield* World.resolve(getLobbyState, { lobbyId: lobbyID });
  if (!lobbyState || lobbyState.length === 0) {
    console.warn('[joinedLobby] Lobby not found:', lobbyID);
    return;
  }
  if (lobbyState[0].status !== 'open') {
    console.warn('[joinedLobby] Lobby not open:', lobbyID, lobbyState[0].status);
    return;
  }

  // Guard against joining a full lobby.
  const countResult = yield* World.resolve(countLobbyPlayers, { lobbyId: lobbyID });
  const currentCount = Number(countResult?.[0]?.count ?? 0);
  if (currentCount >= MAX_PLAYERS) {
    console.warn('[joinedLobby] Lobby already full:', lobbyID, currentCount);
    return;
  }

  // Resolve (or create) the account for this wallet.
  const addressResult = yield* World.resolve(
    getAddressByAddress,
    { address: walletAddress }
  );

  let accountId: number | undefined;

  if (addressResult && addressResult.length > 0 && addressResult[0].account_id !== null) {
    accountId = addressResult[0].account_id;
  } else {
    const newAccountResult = yield* World.resolve(
      newAccount,
      { primary_address: walletAddress }
    );
    if (!newAccountResult || newAccountResult.length === 0) {
      console.error('[joinedLobby] Failed to create account');
      return;
    }
    accountId = newAccountResult[0].id;

    if (addressResult && addressResult.length > 0) {
      yield* World.resolve(
        updateAddressAccount,
        { address: walletAddress, account_id: accountId }
      );
    } else {
      yield* World.resolve(
        newAddressWithId,
        { address: walletAddress, address_type: 0, account_id: accountId }
      );
    }
  }

  if (!accountId) {
    console.error('[joinedLobby] accountId undefined after resolution');
    return;
  }

  // Insert the player. ON CONFLICT DO NOTHING → empty RETURNING means the
  // player was already in the lobby, which we treat as a no-op.
  const joinResult = yield* World.resolve(
    joinLobby,
    { lobbyId: lobbyID, accountId, playerName }
  );

  if (!joinResult || joinResult.length === 0) {
    console.warn('[joinedLobby] Player already in lobby — no auto-start');
    return;
  }

  // Auto-start the game once the lobby fills.
  const newCountResult = yield* World.resolve(countLobbyPlayers, { lobbyId: lobbyID });
  const newCount = Number(newCountResult?.[0]?.count ?? 0);
  if (newCount >= MAX_PLAYERS) {
    yield* World.resolve(startGame, { lobbyId: lobbyID });
    console.log(`✅ [joinedLobby] ${lobbyID} filled — auto-started`);
  } else {
    console.log(`✅ [joinedLobby] ${lobbyID} now has ${newCount} player(s)`);
  }
});

/**
 * Handle closedLobby - host cancels an open lobby while still alone.
 */
stm.addStateTransition("closedLobby", function* (data) {
  const { lobbyID } = data.parsedInput;
  const walletAddress = data.signerAddress?.toLowerCase();
  if (!walletAddress) {
    console.error('[closedLobby] No signer address');
    return;
  }

  console.log(`🎮 [closedLobby] ${lobbyID} by ${walletAddress}`);

  const lobbyState = yield* World.resolve(getLobbyState, { lobbyId: lobbyID });
  if (!lobbyState || lobbyState.length === 0) {
    console.warn('[closedLobby] Lobby not found:', lobbyID);
    return;
  }
  const lobby = lobbyState[0];
  if (lobby.status !== 'open') {
    console.warn('[closedLobby] Lobby not open:', lobbyID, lobby.status);
    return;
  }

  // Only the host may close.
  const signerResult = yield* World.resolve(
    getAddressByAddress,
    { address: walletAddress }
  );
  const signerAccountId = signerResult?.[0]?.account_id;
  if (signerAccountId == null) {
    console.warn('[closedLobby] No account for signer:', walletAddress);
    return;
  }
  if (signerAccountId !== lobby.host_account_id) {
    console.warn('[closedLobby] Non-host close attempt:', signerAccountId, '!=', lobby.host_account_id);
    return;
  }

  // Must be alone — cannot close once someone else has joined.
  const countResult = yield* World.resolve(countLobbyPlayers, { lobbyId: lobbyID });
  const count = Number(countResult?.[0]?.count ?? 0);
  if (count > 1) {
    console.warn('[closedLobby] Lobby has other players:', count);
    return;
  }

  yield* World.resolve(deleteLobbyPlayers, { lobbyId: lobbyID });
  yield* World.resolve(deleteLobby, { lobbyId: lobbyID });

  console.log(`✅ [closedLobby] ${lobbyID} deleted`);
});

/**
 * Handle hostReady - host's Midnight applyMask has been confirmed on-chain.
 * Flips lobbies.host_mask_applied so other clients stop showing "Preparing".
 */
stm.addStateTransition("hostReady", function* (data) {
  const { lobbyID } = data.parsedInput;
  const walletAddress = data.signerAddress?.toLowerCase();
  if (!walletAddress) {
    console.error('[hostReady] No signer address');
    return;
  }

  const lobbyState = yield* World.resolve(getLobbyState, { lobbyId: lobbyID });
  if (!lobbyState || lobbyState.length === 0) {
    console.warn('[hostReady] Lobby not found:', lobbyID);
    return;
  }
  const lobby = lobbyState[0];

  // Only the host may flip the flag.
  const signerResult = yield* World.resolve(
    getAddressByAddress,
    { address: walletAddress }
  );
  const signerAccountId = signerResult?.[0]?.account_id;
  if (signerAccountId == null || signerAccountId !== lobby.host_account_id) {
    console.warn('[hostReady] Non-host ready attempt:', signerAccountId, '!=', lobby.host_account_id);
    return;
  }

  yield* World.resolve(setHostMaskApplied, { lobbyId: lobbyID });
  console.log(`✅ [hostReady] ${lobbyID} marked ready`);
});

/**
 * Handle event_midnight - ledger-state events from the Midnight Go Fish contract.
 * Fired by the parallelMidnight sync protocol whenever the contract's ledger changes.
 * For now we just log the payload — a minimal observability hook.
 */
stm.addStateTransition("event_midnight", function* (data) {
  const { payload } = data.parsedInput as { payload: Record<string, unknown> };
  const { diffs, isInitial } = computeLedgerDiff(payload);
  logLedgerDiff(diffs, isInitial, data.blockHeight);
  yield* projectMidnightGamesFromDiff(diffs, data.blockHeight);

  // Schedule Midnight contract cleanup 2 hours after each new game is created.
  // Skip the initial snapshot (node restart) — those games already had cleanup
  // scheduled on their original creation, or have already been cleaned up.
  const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
  for (const d of diffs) {
    if (!isInitial && d.op === "add" && d.path.startsWith("go_fish_gameExists.") && d.new === true) {
      const evmId = d.path.slice("go_fish_gameExists.".length);
      yield* World.resolve(newScheduledTimestampData, {
        from_address: "0x0",
        from_address_type: AddressType.NONE,
        future_ms_timestamp: new Date(data.blockTimestamp + TWO_HOURS_MS),
        input_data: JSON.stringify(["cleanupGame", evmId]),
      });
      console.log(`⏰ [event_midnight] Scheduled cleanupGame for "${evmId}" at +2h`);
    }
  }
});

/**
 * Handle cleanupGame — scheduled system action that removes all on-chain
 * Midnight contract state for a finished (or stale) game.
 * Spawns an isolated Bun subprocess that proves the cleanupGame circuit
 * and delegates balancing/submission to the batcher (same pattern as pvp-v2).
 */
stm.addStateTransition("cleanupGame", function* (data) {
  const { gameId } = data.parsedInput;

  // Mark the EVM lobby as finished if still in_progress (catches stale games)
  yield* World.resolve(finishLobby, { lobbyId: gameId });

  setTimeout(async () => {
    try {
      console.log(`🧹 [cleanupGame] Scheduled cleanup fired for gameId: ${gameId}`);

      const scriptPath = path.resolve(
        import.meta.dirname!,
        "..", "..", "..", "shared", "contracts", "midnight",
        "contract-gofish-cleanup.ts",
      );
      const child = Bun.spawn(["bun", "run", scriptPath, gameId], {
        env: {
          ...process.env,
          MIDNIGHT_ADMIN_SECRET: process.env.MIDNIGHT_ADMIN_SECRET || "",
          MIDNIGHT_CLEAN_SEED: process.env.MIDNIGHT_CLEAN_SEED || "",
          MIDNIGHT_NETWORK_ID: process.env.MIDNIGHT_NETWORK_ID || "",
          MIDNIGHT_STORAGE_PASSWORD: process.env.MIDNIGHT_STORAGE_PASSWORD || "",
          BATCHER_URL: process.env.BATCHER_URL || "",
        },
        stdout: "inherit",
        stderr: "inherit",
      });
      child.exited.then((code) => {
        if (code === 0) {
          console.log(`✅ [cleanupGame] cleanup script succeeded for gameId=${gameId}`);
        } else {
          console.error(`❌ [cleanupGame] cleanup script exited with code ${code} for gameId=${gameId}`);
        }
      }).catch((err) => {
        console.error(`❌ [cleanupGame] cleanup script status error for gameId=${gameId}:`, err);
      });
    } catch (err) {
      console.error(`❌ [cleanupGame] failed to spawn cleanup script for gameId=${gameId}:`, err);
    }
  }, 0);
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

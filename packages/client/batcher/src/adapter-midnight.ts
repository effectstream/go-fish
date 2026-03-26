/**
 * Midnight Adapter for Go Fish Batcher
 *
 * This adapter handles Midnight blockchain transactions for the Go Fish game.
 * It uses the MidnightAdapter from @paimaexample/batcher to connect to the
 * Midnight network and submit transactions.
 *
 * IMPORTANT: This adapter supports client-side secrets for proper mental poker.
 * When a circuit call includes playerSecret and shuffleSeed fields, these are
 * extracted and set as dynamic secrets before proof generation. This allows
 * the batcher to generate proofs using the client's actual secrets without
 * permanently storing them.
 */

import { type BatchBuildingOptions, type BatchBuildingResult, type DefaultBatcherInput, MidnightAdapter, type MidnightBatchPayload } from "@paimaexample/batcher";
import { readMidnightContract } from "@paimaexample/midnight-contracts/read-contract";
import * as goFishContractInfo from "@go-fish/midnight-contract";
import * as goFishContract from "@go-fish/midnight-contract/contract";
import { setPlayerSecrets, clearPlayerSecrets } from "@go-fish/midnight-contract/witnesses";
import { CryptoManager } from "@paimaexample/crypto";
import { storage } from "./config.ts";
import { createUnprovenCallTxFromInitialStates, getPublicStates } from "@midnight-ntwrk/midnight-js-contracts";
import { NodeZkConfigProvider } from "@midnight-ntwrk/midnight-js-node-zk-config-provider";
import { parseCoinPublicKeyToHex } from "@midnight-ntwrk/midnight-js-utils";
import { getNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { CompiledContract } from "@midnight-ntwrk/compact-js";

// Network configuration - use environment variables or defaults
const isTestnet = Deno.env.get("EFFECTSTREAM_ENV") === "testnet";

// Read contract info from the deployed contract file
const {
  contractInfo: contractInfo0,
  contractAddress: contractAddress0,
  zkConfigPath: zkConfigPath0,
} = readMidnightContract("go-fish-contract", "go-fish-contract.undeployed.json");

// Genesis mint wallet seed for the batcher
const GENESIS_MINT_WALLET_SEED =
  "0000000000000000000000000000000000000000000000000000000000000001";

// Midnight infrastructure URLs
const indexer = Deno.env.get("INDEXER_HTTP_URL") || "http://localhost:8088/api/v3/graphql";
const indexerWS = Deno.env.get("INDEXER_WS_URL") || "ws://localhost:8088/api/v3/graphql/ws";
const node = Deno.env.get("NODE_URL") || "http://localhost:9944";
const proofServer = Deno.env.get("PROOF_SERVER_URL") || "http://localhost:6300";
const networkID = isTestnet ? "testnet" : "undeployed";
const syncProtocolName = "parallelMidnight";

// Midnight adapter configuration
// IMPORTANT: privateStateId and privateStateStoreName MUST match what was used during deployment
// See packages/shared/contracts/midnight/deploy.ts for the deployment config
const midnightAdapterConfig0 = {
  indexer,
  indexerWS,
  node,
  proofServer,
  zkConfigPath: zkConfigPath0,
  privateStateStoreName: "private-state",  // Must match deploy.ts
  privateStateId: "privateState",           // Must match deploy.ts
  walletNetworkId: networkID,
  contractJoinTimeoutSeconds: 300,
  walletFundingTimeoutSeconds: 300,
};

// Skip signature verification in development mode
const SKIP_SIGNATURE_VERIFICATION = Deno.env.get("SKIP_SIGNATURE_VERIFICATION") === "true" ||
  Deno.env.get("NODE_ENV") !== "production";

/**
 * Circuit call with optional client-side secrets
 */
interface CircuitCallWithSecrets {
  circuit: string;
  args: unknown[];
  playerSecret?: string;        // Hex-encoded bigint
  shuffleSeed?: string;         // Hex-encoded 32 bytes
  opponentSecret?: string;      // Hex-encoded bigint (needed for goFish)
  opponentShuffleSeed?: string; // Hex-encoded 32 bytes (needed for goFish)
}

/**
 * Convert hex string to Uint8Array
 */
function hexToBytes(hex: string): Uint8Array {
  const cleanHex = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(cleanHex.substr(i * 2, 2), 16);
  }
  return bytes;
}

/**
 * Extended MidnightAdapter with EVM signature verification and client-side secrets
 *
 * This allows transactions to be signed by EVM wallets and verified
 * before being submitted to the Midnight network.
 *
 * Additionally, it supports client-side secrets for mental poker:
 * - Frontend includes playerSecret and shuffleSeed in the circuit call
 * - Adapter extracts these and sets them as dynamic witnesses
 * - Proofs are generated using the client's actual secrets
 * - Secrets are cleared after proof generation
 *
 * In development mode (SKIP_SIGNATURE_VERIFICATION=true or NODE_ENV != production),
 * signature verification is skipped for easier testing.
 */
export class GoFishMidnightAdapter extends MidnightAdapter {
  /**
   * Stash the raw batcher input from the most recent buildBatchData call so
   * submitBatch can read playerSecret/shuffleSeed/opponentSecret from it.
   * MidnightBatchBuilderLogic strips these custom fields from the payload — they
   * only survive in the original DefaultBatcherInput.input JSON string.
   */
  private _pendingRawInput: CircuitCallWithSecrets | null = null;

  /**
   * Fetch a stored player secret from the backend node.
   * Called when the circuit payload doesn't include the opponent's secret
   * (which happens for game-phase circuits like askForCard when the asking player's
   * browser doesn't have the opponent's secret).
   *
   * Returns null if the backend doesn't have the secret (e.g. node just restarted).
   */
  private async fetchSecretFromBackend(
    lobbyId: string,
    playerId: 1 | 2,
  ): Promise<{ secret: string; shuffleSeed: string | null } | null> {
    const backendUrl = Deno.env.get("BACKEND_URL") || "http://localhost:9996";
    const url = `${backendUrl}/api/midnight/player_secret?lobby_id=${encodeURIComponent(lobbyId)}&player_id=${playerId}`;

    // Retry up to 3 times with a short delay: the backend may still be processing
    // notify_setup (which persists secrets) at the time this is called.
    const MAX_FETCH_ATTEMPTS = 3;
    const FETCH_RETRY_MS = 2000;

    for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
      try {
        const response = await fetch(url);
        if (response.ok) {
          const data = await response.json() as { secret: string; shuffleSeed: string | null };
          console.log(`[GoFishMidnightAdapter] Fetched opponent secret from backend for ${lobbyId} player ${playerId}${attempt > 1 ? ` (attempt ${attempt})` : ""}`);
          return data;
        }
        console.warn(`[GoFishMidnightAdapter] Backend returned ${response.status} for player_secret lookup (lobby=${lobbyId} player=${playerId}, attempt ${attempt}/${MAX_FETCH_ATTEMPTS})`);
        if (response.status !== 404) {
          // Non-404 error (e.g. 500) — don't retry
          return null;
        }
        if (attempt < MAX_FETCH_ATTEMPTS) {
          console.log(`[GoFishMidnightAdapter] Retrying player_secret lookup in ${FETCH_RETRY_MS}ms...`);
          await new Promise(resolve => setTimeout(resolve, FETCH_RETRY_MS));
        }
      } catch (err) {
        console.warn(`[GoFishMidnightAdapter] Could not fetch opponent secret from backend (attempt ${attempt}/${MAX_FETCH_ATTEMPTS}):`, err);
        if (attempt < MAX_FETCH_ATTEMPTS) {
          await new Promise(resolve => setTimeout(resolve, FETCH_RETRY_MS));
        }
      }
    }
    console.error(`[GoFishMidnightAdapter] Failed to fetch player ${playerId} secret for lobby ${lobbyId} after ${MAX_FETCH_ATTEMPTS} attempts — circuit will use fallback key and likely fail`);
    return null;
  }

  /**
   * Override submitBatch to extract and set client-side secrets before circuit execution.
   * The Midnight SDK executes the circuit locally (in WASM) to build the unproven transaction.
   * Circuits like applyMask and dealCards require the player's secret key and shuffle seed
   * as witness values. Without setting these before execution, the WASM runtime crashes
   * with "RuntimeError: unreachable" because the default random keys don't match
   * the keys used during mask application.
   */
  override async submitBatch(
    data: MidnightBatchPayload | null,
    fee?: string | bigint,
  ): Promise<string> {
    const circuit = data?.payloads?.[0]?.circuit ?? "unknown";
    let secretInfo: { gameId: string; playerId: number } | null = null;

    // Extract and set client-side secrets before circuit execution.
    // IMPORTANT: MidnightBatchBuilderLogic strips custom fields (playerSecret,
    // shuffleSeed, etc.) from MidnightBatchPayload.payloads — read them from
    // _pendingRawInput which was stashed in buildBatchData from the raw input JSON.
    const rawInput = this._pendingRawInput;
    this._pendingRawInput = null; // consume it
    if (rawInput?.playerSecret && rawInput?.shuffleSeed) {
      const args = data?.payloads?.[0]?.args;
      if (Array.isArray(args) && args.length >= 2) {
        const gameId = args[0] as string;
        const playerId = Number(args[1]) as 1 | 2;
        const secret = BigInt("0x" + rawInput.playerSecret);
        const shuffleSeed = hexToBytes(rawInput.shuffleSeed);

        setPlayerSecrets(gameId, playerId, secret, shuffleSeed);
        secretInfo = { gameId, playerId };
        console.log(`[GoFishMidnightAdapter] Set client secrets for ${circuit}: gameIdHex=${gameId} player=${playerId} secret=${secret}`);

        const opponentId = (playerId === 1 ? 2 : 1) as 1 | 2;

        if (rawInput.opponentSecret && rawInput.opponentShuffleSeed) {
          // Opponent secret provided directly in the payload — use it.
          const opponentSecret = BigInt("0x" + rawInput.opponentSecret);
          const opponentShuffleSeed = hexToBytes(rawInput.opponentShuffleSeed);
          setPlayerSecrets(gameId, opponentId, opponentSecret, opponentShuffleSeed);
          console.log(`[GoFishMidnightAdapter] Set opponent secrets for ${circuit}: game ${gameId}, player ${opponentId}`);
        } else {
          // Opponent secret not in payload (frontend doesn't have it — it's theirs to keep).
          // Fall back to the backend node which stores both players' secrets after setup replay.
          // This is needed for game-phase circuits (askForCard, respondToAsk, goFish,
          // afterGoFish) that call player_secret_key for BOTH players unconditionally.
          const lobbyId = this.hexToLobbyId(gameId);
          console.log(`[GoFishMidnightAdapter] ${circuit}: no opponent secret in payload, fetching from backend for player ${opponentId} (lobby=${lobbyId})`);
          const backendOpponent = await this.fetchSecretFromBackend(lobbyId, opponentId);
          if (backendOpponent) {
            const opponentSecret = BigInt("0x" + backendOpponent.secret);
            setPlayerSecrets(gameId, opponentId, opponentSecret,
              backendOpponent.shuffleSeed ? hexToBytes(backendOpponent.shuffleSeed) : new Uint8Array(32));
            console.log(`[GoFishMidnightAdapter] Set backend-fetched opponent secret for ${circuit}: game ${gameId}, player ${opponentId}`);
            // Cache on rawInput so retries re-use it without another backend round-trip
            rawInput.opponentSecret = backendOpponent.secret;
            if (backendOpponent.shuffleSeed) rawInput.opponentShuffleSeed = backendOpponent.shuffleSeed;
          } else {
            console.warn(`[GoFishMidnightAdapter] No opponent secret available for ${circuit} — proof may fail`);
          }
        }
      }
    }

    // Circuits that carry a `now` timestamp arg and their arg position.
    // blockTimeLt(now + 6) requires now to be within 6s of the block time.
    // The batcher stores the original payload, so `now` can be stale by the
    // time we execute — refresh it before every attempt (including retries).
    //   askForCard:   args[3]  → [gameId, playerId, rank, now]
    //   respondToAsk: args[2]  → [gameId, playerId, now]
    //   goFish:       args[2]  → [gameId, playerId, now]
    //   afterGoFish:  args[3]  → [gameId, playerId, drewRequestedCard, now]
    const NOW_ARG_INDEX: Record<string, number> = {
      askForCard: 3,
      respondToAsk: 2,
      goFish: 2,
      afterGoFish: 3,
    };

    const refreshNowArg = () => {
      const nowArgIdx = NOW_ARG_INDEX[circuit];
      if (nowArgIdx !== undefined && data?.payloads?.[0] && Array.isArray(data.payloads[0].args)) {
        const freshNow = Math.floor(Date.now() / 1000);
        data.payloads[0].args[nowArgIdx] = freshNow;
        console.log(`[GoFishMidnightAdapter] Refreshed now=${freshNow} at args[${nowArgIdx}] for ${circuit}`);
      }
    };

    refreshNowArg();

    // Fix for MalformedFeeCalculation (Midnight node Custom error 168):
    //
    // Root cause: after the previous circuit (e.g. respondToAsk) spends the dust UTXO,
    // the wallet's RxJS BehaviorSubject caches the pre-spend balance. waitForDustFunds()
    // and syncAndWaitForFunds() both return the stale non-zero value immediately because
    // the observable's isCompleteWithin(0n) filter stays true — the wallet doesn't flip
    // itself to "syncing" just because a coin was spent. balanceFinalizedTransaction()
    // then tries to use the already-spent UTXO → node rejects with error 168.
    //
    // Fix: wait for the indexer to advance by at least one block from the block that
    // contained the previous circuit's transaction. Once the block is indexed, the
    // wallet re-syncs and the spend is reflected in the observable state. Then force
    // ensureFunds() to run the full cold path so it stores the fresh dust balance.
    try {
      const blockBefore = await this.getBlockNumber();
      console.log(`[GoFishMidnightAdapter] ${circuit}: pre-dust-fix block=${blockBefore}, waiting for indexer to advance...`);
      // Poll until block advances or 90s timeout
      const dustFixStart = Date.now();
      let advanced = false;
      while (Date.now() - dustFixStart < 90_000) {
        await new Promise(resolve => setTimeout(resolve, 3_000));
        try {
          const blockNow = await this.getBlockNumber();
          if (blockNow > blockBefore) {
            console.log(`[GoFishMidnightAdapter] ${circuit}: indexer advanced to block ${blockNow}, proceeding`);
            advanced = true;
            break;
          }
        } catch { /* ignore polling errors */ }
      }
      if (!advanced) {
        console.warn(`[GoFishMidnightAdapter] ${circuit}: block did not advance within 90s — proceeding anyway`);
      }
    } catch (err) {
      // getBlockNumber not available or failed — fall back to a fixed delay of one block (~6s)
      console.warn(`[GoFishMidnightAdapter] ${circuit}: block polling unavailable, sleeping 8s for dust UTXO refresh`);
      await new Promise(resolve => setTimeout(resolve, 8_000));
    }
    // Force ensureFunds() inside super.submitBatch() to run the full cold path
    // (syncAndWaitForFunds) so it reads the now-fresh dust balance from the wallet.
    (this as any).hasFunds = false;

    // Retry logic for WASM "unreachable" errors, which typically mean the
    // Midnight indexer hasn't synced the latest state yet (e.g., the circuit
    // asserts both masks are applied but the indexer is a few blocks behind).
    // The batcher's callTx fetches state from the indexer, so stale state
    // causes Compact asserts to fail as WASM unreachable traps.
    const MAX_RETRIES = 5;
    const RETRY_DELAY_MS = 15000; // 15 seconds between retries

    const startTime = Date.now();
    try {
      // Log indexer block at start for diagnostics
      try {
        const startBlock = await this.getBlockNumber();
        console.log(`[GoFishMidnightAdapter] ${circuit} starting, indexer at block ${startBlock}`);
      } catch { /* ignore */ }

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          if (secretInfo) {
            console.log(`[GoFishMidnightAdapter] ${circuit} attempt ${attempt}: calling super.submitBatch with secretInfo game=${secretInfo.gameId} player=${secretInfo.playerId}`);
          }
          const result = await super.submitBatch(data, fee);
          if (attempt > 1) {
            const elapsed = Math.round((Date.now() - startTime) / 1000);
            try {
              const endBlock = await this.getBlockNumber();
              console.log(`[GoFishMidnightAdapter] ${circuit} succeeded on attempt ${attempt}/${MAX_RETRIES} (${elapsed}s total, indexer at block ${endBlock})`);
            } catch {
              console.log(`[GoFishMidnightAdapter] ${circuit} succeeded on attempt ${attempt}/${MAX_RETRIES} (${elapsed}s total)`);
            }
          }

          // Notify the backend about successful setup circuit calls.
          // This is more reliable than relying solely on the frontend notification,
          // since the batcher is the one that actually confirmed the transaction.
          await this.notifyBackendSetup(circuit, data, rawInput);

          return result;
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);

          // FailFallible = transaction was submitted, proved, and mined on-chain, but the
          // contract's runtime assertion failed (e.g. wrong phase, card not in hand).
          // This is a PERMANENT failure — retrying with the same payload will always fail.
          // Purge the entire pending queue so the stale input doesn't re-fire on future polls,
          // which would advance the game phase unexpectedly and break subsequent moves.
          const isFailFallible = (error as any)?.name === "CallTxFailedError" ||
            (error as any)?.finalizedTxData?.status === "FailFallible" ||
            errMsg.includes("FailFallible");
          if (isFailFallible) {
            console.error(`[GoFishMidnightAdapter] ${circuit} FailFallible — purging batcher queue to prevent stale replay`);
            try {
              await storage.clearAllInputs();
              console.warn(`[GoFishMidnightAdapter] Batcher queue cleared after FailFallible`);
            } catch (clearErr) {
              console.error(`[GoFishMidnightAdapter] Failed to clear queue:`, clearErr);
            }
            throw error; // Don't retry
          }

          const isUnreachable = error instanceof Error &&
            (errMsg.includes("unreachable") || errMsg.includes("RuntimeError"));
          // Proof server 500 means the circuit's on-chain assertions failed during /check,
          // which happens when the indexer hasn't yet confirmed the preceding transaction
          // (e.g. both applyMask transactions must be on-chain before dealCards /check passes).
          const isProofServer500 = errMsg.includes("code=\"500\"") || errMsg.includes("code=500");
          // Custom error 168 = transaction TTL expired on the Midnight Substrate node.
          // The `now` timestamp in the circuit args (blockTimeLt(now + 6)) was stale by the
          // time the signed tx reached the node. refreshNowArg() already updates `now` before
          // each retry, so re-submitting with a fresh timestamp will succeed.
          const isTtlExpired = errMsg.includes("Custom error: 168") ||
            errMsg.includes("SubmissionError") ||
            errMsg.includes("Transaction submission error") ||
            errMsg.includes("Transaction submission failed");
          // "failed assert" from createUnprovenCallTxFromInitialStates means the local WASM simulation
          // read stale indexer state. For setup-dependent circuits (dealCards, askForCard), the
          // preceding transaction (e.g. opponent's dealCards) may not yet be indexed.
          //
          // HOWEVER: some assertions are permanent — the circuit has already been run on-chain
          // for this player/game, so retrying will always fail. These must be treated like
          // FailFallible: purge the queue immediately so the duplicate doesn't block subsequent
          // circuits (e.g. a stale second applyMask blocking dealCards for 75+ seconds).
          const isPermanentAssert = errMsg.includes("already applied") ||
            errMsg.includes("already dealt") ||
            errMsg.includes("already initialized") ||
            errMsg.includes("already started") ||
            // Duplicate game-phase circuit: a previous transaction already advanced the phase.
            // Retrying will never succeed — purge the queue immediately.
            errMsg.includes("Not waiting for a response") ||
            errMsg.includes("Not your turn") ||
            errMsg.includes("Can only ask for cards at turn start") ||
            errMsg.includes("Cannot ask for a rank you don't have");
          const isStaleAssert = errMsg.includes("failed assert") && !isPermanentAssert;
          const isRetryable = isUnreachable || isProofServer500 || isStaleAssert || isTtlExpired;

          if (isPermanentAssert) {
            console.error(`[GoFishMidnightAdapter] ${circuit} permanent assert ("${errMsg.slice(0, 120)}") — purging batcher queue to prevent stale replay`);
            try {
              await storage.clearAllInputs();
              console.warn(`[GoFishMidnightAdapter] Batcher queue cleared after permanent assert`);
            } catch (clearErr) {
              console.error(`[GoFishMidnightAdapter] Failed to clear queue:`, clearErr);
            }
            throw error; // Don't retry
          }

          if (isRetryable && attempt < MAX_RETRIES) {
            const elapsed = Math.round((Date.now() - startTime) / 1000);
            const reason = isTtlExpired ? "TTL expired (Custom error 168 — now timestamp stale, refreshing)" :
              isProofServer500 ? "proof server 500 (on-chain state not yet confirmed)" :
              isStaleAssert ? "failed assert (indexer state likely stale — opponent tx not yet indexed)" :
              "WASM unreachable";
            try {
              const blockNum = await this.getBlockNumber();
              console.warn(
                `[GoFishMidnightAdapter] ${circuit} failed with ${reason} (attempt ${attempt}/${MAX_RETRIES}, ${elapsed}s elapsed, indexer at block ${blockNum}), ` +
                `retrying in ${RETRY_DELAY_MS / 1000}s...`
              );
            } catch {
              console.warn(
                `[GoFishMidnightAdapter] ${circuit} failed with ${reason} (attempt ${attempt}/${MAX_RETRIES}, ${elapsed}s elapsed), ` +
                `retrying in ${RETRY_DELAY_MS / 1000}s (indexer may be behind)...`
              );
            }
            // Re-set secrets before retry since they were consumed by the failed attempt.
            // Read from rawInput (stashed in buildBatchData) — payload fields were stripped.
            if (secretInfo && rawInput?.playerSecret && rawInput?.shuffleSeed) {
              const secret = BigInt("0x" + rawInput.playerSecret);
              const shuffleSeed = hexToBytes(rawInput.shuffleSeed);
              setPlayerSecrets(secretInfo.gameId, secretInfo.playerId as 1 | 2, secret, shuffleSeed);
              // Re-set opponent secrets too
              if (rawInput.opponentSecret && rawInput.opponentShuffleSeed) {
                const opponentId = (secretInfo.playerId === 1 ? 2 : 1) as 1 | 2;
                const opponentSecret = BigInt("0x" + rawInput.opponentSecret);
                const opponentShuffleSeed = hexToBytes(rawInput.opponentShuffleSeed);
                setPlayerSecrets(secretInfo.gameId, opponentId, opponentSecret, opponentShuffleSeed);
              }
            }
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
            // After the 15s sleep, the block containing the previous attempt has been indexed.
            // Force ensureFunds() to run the full cold path so it reads fresh dust balance.
            (this as any).hasFunds = false;
            // Refresh `now` after the sleep so it's fresh for the next attempt
            refreshNowArg();
            continue;
          }

          throw error;
        }
      }
      // Should not reach here
      throw new Error("Unexpected: retry loop exited without returning or throwing");
    } finally {
      // Always clear secrets after all attempts
      if (secretInfo) {
        this.clearSecrets(secretInfo.gameId, secretInfo.playerId);
        // Also clear opponent secrets if they were set (read from rawInput, not stripped payload)
        if (rawInput?.opponentSecret) {
          const opponentId = (secretInfo.playerId === 1 ? 2 : 1) as 1 | 2;
          this.clearSecrets(secretInfo.gameId, opponentId);
        }
      }
    }
  }

  /**
   * Override buildBatchData to always select exactly ONE input per batch,
   * and stash the raw parsed input so submitBatch can read custom fields
   * (playerSecret, shuffleSeed, opponentSecret, opponentShuffleSeed) that
   * MidnightBatchBuilderLogic strips from MidnightBatchPayload.payloads.
   */
  override buildBatchData(
    inputs: DefaultBatcherInput[],
    options?: BatchBuildingOptions,
  ): BatchBuildingResult<MidnightBatchPayload | null> | null {
    if (inputs.length === 0) return null;
    // Stash the raw parsed CircuitCall from the first input so submitBatch
    // can read playerSecret/shuffleSeed even after the builder strips them.
    try {
      this._pendingRawInput = JSON.parse(inputs[0].input) as CircuitCallWithSecrets;
    } catch {
      this._pendingRawInput = null;
    }
    // Delegate to base implementation with only the first input
    return super.buildBatchData([inputs[0]], options);
  }

  override async verifySignature(input: DefaultBatcherInput): Promise<boolean> {
    // Skip signature verification in development mode
    if (SKIP_SIGNATURE_VERIFICATION) {
      console.log("[GoFishMidnightAdapter] Skipping signature verification (dev mode)");
      return true;
    }

    const { target, address, addressType, timestamp, signature } = input;
    const cryptoManager = CryptoManager.getCryptoManager(addressType);
    const signerAddress = input.address;
    const message = `${target}:${address}:${addressType}:${timestamp}`;
    const isValid = await cryptoManager.verifySignature(
      signerAddress,
      message,
      signature!
    );
    return isValid && super.verifySignature(input);
  }

  /**
   * Notify the backend about successful setup circuit calls (applyMask, dealCards).
   * This updates the backend's in-memory setup state map so both players can
   * coordinate. More reliable than frontend-only notifications since the batcher
   * is the one that actually confirmed the transaction on-chain.
   */
  private async notifyBackendSetup(
    circuit: string,
    data: MidnightBatchPayload | null,
    rawInput: CircuitCallWithSecrets | null,
  ): Promise<void> {
    const actionMap: Record<string, string> = {
      "applyMask": "mask_applied",
      "dealCards": "dealt_complete",
    };
    const action = actionMap[circuit];
    if (!action || !data?.payloads?.[0]) return;

    const payload = data.payloads[0];
    const args = payload.args;
    if (!Array.isArray(args) || args.length < 2) return;

    // Convert hex gameId back to lobbyId string
    const gameIdHex = args[0] as string;
    const playerId = Number(args[1]);
    const lobbyId = this.hexToLobbyId(gameIdHex);

    // Include player secrets so the node can replay the circuit locally on its own
    // in-memory contract instance, keeping the local actionContext in sync with
    // what was just written to the real Midnight chain.
    // Also forward opponent secrets — dealCards needs both players' secrets to reproduce
    // the same cardOwnership ledger as the real on-chain transaction.
    // Read from rawInput — payload fields were stripped by MidnightBatchBuilderLogic.
    const body: Record<string, unknown> = { lobby_id: lobbyId, player_id: playerId, action };
    if (rawInput?.playerSecret) body.player_secret = rawInput.playerSecret;
    if (rawInput?.shuffleSeed) body.shuffle_seed = rawInput.shuffleSeed;
    if (rawInput?.opponentSecret) body.opponent_secret = rawInput.opponentSecret;
    if (rawInput?.opponentShuffleSeed) body.opponent_shuffle_seed = rawInput.opponentShuffleSeed;

    const backendUrl = Deno.env.get("BACKEND_URL") || "http://localhost:9996";
    try {
      const response = await fetch(`${backendUrl}/api/midnight/notify_setup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (response.ok) {
        const secretSnippet = rawInput?.playerSecret ? `secret=0x${rawInput.playerSecret.slice(0,16)}...` : 'no secret';
        console.log(`[GoFishMidnightAdapter] Backend notified: ${action} for ${lobbyId} player ${playerId} (${secretSnippet})`);
      } else {
        console.warn(`[GoFishMidnightAdapter] Failed to notify backend: ${response.status}`);
      }
    } catch (error) {
      console.warn(`[GoFishMidnightAdapter] Could not notify backend:`, error);
    }
  }

  /**
   * Convert hex-encoded gameId back to lobby ID string
   */
  private hexToLobbyId(hexStr: string): string {
    const clean = hexStr.startsWith("0x") ? hexStr.slice(2) : hexStr;
    const bytes = new Uint8Array(clean.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
    }
    // Remove null padding bytes
    let end = bytes.length;
    while (end > 0 && bytes[end - 1] === 0) end--;
    return new TextDecoder().decode(bytes.slice(0, end));
  }

  /**
   * Query public game state from the real Midnight indexer.
   *
   * Runs the public impure circuits (getGamePhase, getCurrentTurn, getScores, etc.)
   * against the indexer's current ledger state using createUnprovenCallTxFromInitialStates.
   * No secrets or proofs are needed — these are all public reads.
   *
   * This is the authoritative source of truth for game phase. The backend must call this
   * instead of maintaining an optimistic local simulation.
   *
   * @param lobbyId  The game lobby ID (UTF-8 string, padded to 32 bytes internally)
   * @returns        Full game state from the real chain, or null if the game doesn't exist yet
   */
  async queryGameState(lobbyId: string): Promise<{
    phase: number;
    currentTurn: number;
    scores: [number, number];
    handSizes: [number, number];
    deckCount: number;
    isGameOver: boolean;
    lastAskedRank: number | null;
    lastAskingPlayer: number | null;
  } | null> {
    // Ensure the adapter is initialized (wallet, indexer connection)
    if ((this as any).initializationPromise) {
      await (this as any).initializationPromise;
    }
    if (!(this as any).isInitialized) {
      throw new Error("[GoFishMidnightAdapter.queryGameState] Adapter not initialized");
    }

    const publicDataProvider = (this as any).publicDataProvider;
    const walletProvider = (this as any).walletProvider;
    const config = (this as any).config as typeof midnightAdapterConfig0;

    if (!publicDataProvider || !walletProvider) {
      throw new Error("[GoFishMidnightAdapter.queryGameState] Required providers not initialized");
    }

    // Use dummy witnesses — no secrets needed for public circuit reads.
    // The only witnesses that could be invoked are player_secret_key and shuffle_seed
    // (for circuits that branch on private state), but all circuits called here are
    // pure public reads that never invoke those witnesses.
    const dummyWitnesses = {
      getFieldInverse: () => { throw new Error("getFieldInverse should not be called in queryGameState"); },
      player_secret_key: () => { throw new Error("player_secret_key should not be called in queryGameState"); },
      shuffle_seed: () => { throw new Error("shuffle_seed should not be called in queryGameState"); },
      get_sorted_deck_witness: () => { throw new Error("get_sorted_deck_witness should not be called in queryGameState"); },
    };

    const compiledContract = CompiledContract.make(
      "go-fish-contract",
      (this as any).contractClass,
    ).pipe(
      CompiledContract.withWitnesses(dummyWitnesses as never),
      CompiledContract.withCompiledFileAssets(config.zkConfigPath),
    );

    // Build gameId as Uint8Array (32 bytes, UTF-8 lobby string zero-padded)
    const encoder = new TextEncoder();
    const lobbyBytes = encoder.encode(lobbyId);
    const gameIdBytes = new Uint8Array(32);
    gameIdBytes.set(lobbyBytes.slice(0, 32));

    const zkConfigProvider = new NodeZkConfigProvider(config.zkConfigPath);

    // Fetch contract public state once, then reuse for all circuit calls.
    const { contractState, zswapChainState } = await (getPublicStates as any)(
      publicDataProvider,
      contractAddress0,
    );

    const coinPublicKey = parseCoinPublicKeyToHex(walletProvider.getCoinPublicKey(), getNetworkId());
    const walletEncKey = walletProvider.getEncryptionPublicKey();

    /**
     * Run a single public impure circuit against the cached indexer state.
     * Returns the raw circuit result, or null on error.
     */
    const runCircuit = async (circuitId: string, extraArgs: unknown[] = []): Promise<unknown> => {
      try {
        const callTxData = await (createUnprovenCallTxFromInitialStates as any)(
          zkConfigProvider,
          {
            compiledContract,
            circuitId,
            contractAddress: contractAddress0,
            coinPublicKey,
            initialContractState: contractState,
            initialZswapChainState: zswapChainState,
            args: [gameIdBytes, ...extraArgs],
          },
          walletEncKey,
        );
        return callTxData?.private?.result ?? null;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // "Game does not exist" / null cell are expected before the game is set up
        if (msg.includes("Game does not exist") || msg.includes("expected a cell, received null")) {
          return null;
        }
        console.warn(`[GoFishMidnightAdapter.queryGameState] ${circuitId} error: ${msg}`);
        return null;
      }
    };

    // Run all public query circuits in parallel against the same indexer snapshot
    const [
      phase,
      currentTurn,
      scores,
      handSizes,
      deckSize,
      topCardIndex,
      isGameOver,
      lastAskedRankRaw,
      lastAskingPlayerRaw,
      maskP1Raw,
      maskP2Raw,
      dealtP1Raw,
      dealtP2Raw,
    ] = await Promise.all([
      runCircuit("getGamePhase"),
      runCircuit("getCurrentTurn"),
      runCircuit("getScores"),
      runCircuit("getHandSizes"),
      runCircuit("get_deck_size"),
      runCircuit("get_top_card_index"),
      runCircuit("isGameOver"),
      runCircuit("getLastAskedRank"),
      runCircuit("getLastAskingPlayer"),
      runCircuit("hasMaskApplied", [1n]),
      runCircuit("hasMaskApplied", [2n]),
      runCircuit("hasDealt", [1n]),
      runCircuit("hasDealt", [2n]),
    ]);

    // If phase is null the game doesn't exist on-chain yet
    if (phase === null) return null;

    const [score1, score2] = (scores as [bigint, bigint] | null) ?? [0n, 0n];
    const [hand1, hand2] = (handSizes as [bigint, bigint] | null) ?? [7n, 7n];
    const deckRemaining = Number(deckSize as bigint ?? 38n) - Number(topCardIndex as bigint ?? 0n);

    // lastAskedRank = 255 means "none pending"
    const lastAskedRankNum = Number(lastAskedRankRaw as bigint ?? 255n);
    const lastAskingPlayerNum = Number(lastAskingPlayerRaw as bigint ?? 0n);

    console.log(`[GoFishMidnightAdapter.queryGameState] lobby=${lobbyId} maskP1Raw=${JSON.stringify(maskP1Raw)} maskP2Raw=${JSON.stringify(maskP2Raw)} dealtP1Raw=${JSON.stringify(dealtP1Raw)} dealtP2Raw=${JSON.stringify(dealtP2Raw)}`);

    return {
      phase: Number(phase as number),
      currentTurn: Number(currentTurn as bigint ?? 1n),
      scores: [Number(score1), Number(score2)],
      handSizes: [Number(hand1), Number(hand2)],
      deckCount: Math.max(0, deckRemaining),
      isGameOver: Boolean(isGameOver),
      lastAskedRank: lastAskedRankNum < 255 ? lastAskedRankNum : null,
      lastAskingPlayer: lastAskingPlayerNum > 0 ? lastAskingPlayerNum : null,
      maskApplied: [Boolean(maskP1Raw), Boolean(maskP2Raw)] as [boolean, boolean],
      hasDealt: [Boolean(dealtP1Raw), Boolean(dealtP2Raw)] as [boolean, boolean],
    };
  }

  /**
   * Clear secrets after circuit execution
   */
  clearSecrets(gameId: string, playerId: number): void {
    clearPlayerSecrets(gameId, playerId as 1 | 2);
    console.log(`[GoFishMidnightAdapter] Cleared client secrets for game ${gameId}, player ${playerId}`);
  }

  /**
   * Query the player's current hand from the on-chain indexer state.
   *
   * Uses createUnprovenCallTx to run doesPlayerHaveSpecificCard locally against
   * the indexer's current ledger state (no proof generated, no tx submitted).
   * This reflects the REAL on-chain hand — including cards received/lost via
   * respondToAsk/goFish — unlike the backend's local simulation which only
   * knows the post-deal state.
   *
   * @param lobbyId  The game lobby ID (UTF-8 string, padded to 32 bytes)
   * @param playerId 1 or 2
   * @param playerSecretHex Hex-encoded player secret (no "0x" prefix)
   * @param shuffleSeedHex  Hex-encoded 32-byte shuffle seed (no "0x" prefix)
   * @param opponentSecretHex   Optional opponent secret hex (no "0x" prefix)
   * @param opponentShuffleSeedHex Optional opponent shuffle seed hex
   * @returns Array of {rank, suit} for cards the player currently holds
   */
  async queryPlayerHand(
    lobbyId: string,
    playerId: 1 | 2,
    playerSecretHex: string,
    shuffleSeedHex: string,
    opponentSecretHex?: string,
    opponentShuffleSeedHex?: string,
  ): Promise<Array<{ rank: number; suit: number }>> {
    // Ensure the adapter is initialized (wallet, indexer connection)
    if ((this as any).initializationPromise) {
      await (this as any).initializationPromise;
    }
    if (!(this as any).isInitialized) {
      throw new Error("[GoFishMidnightAdapter.queryPlayerHand] Adapter not initialized");
    }

    // Access private fields from the base class at runtime (TS private is compile-time only).
    // The JSR adapter stores compiledContract locally inside initialize() and doesn't expose it
    // as a field — build a fresh one from the stored contractClass/witnesses/zkConfigPath.
    const publicDataProvider = (this as any).publicDataProvider;
    const walletProvider = (this as any).walletProvider;
    const config = (this as any).config as typeof midnightAdapterConfig0;

    if (!publicDataProvider || !walletProvider) {
      throw new Error("[GoFishMidnightAdapter.queryPlayerHand] Required providers not initialized");
    }

    const compiledContract = CompiledContract.make(
      "go-fish-contract",
      (this as any).contractClass,
    ).pipe(
      CompiledContract.withWitnesses((this as any).witnesses as never),
      CompiledContract.withCompiledFileAssets(config.zkConfigPath),
    );

    // Build gameId as Uint8Array (32 bytes, UTF-8 lobby string zero-padded)
    // AND as "0x"-prefixed hex (needed for setPlayerSecrets witness key format)
    const encoder = new TextEncoder();
    const lobbyBytes = encoder.encode(lobbyId);
    const gameIdBytes = new Uint8Array(32);
    gameIdBytes.set(lobbyBytes.slice(0, 32));
    const gameIdHex = "0x" + Array.from(gameIdBytes).map(b => b.toString(16).padStart(2, "0")).join("");

    // Set player secrets so the witness function resolves correctly during simulation
    const secret = BigInt("0x" + playerSecretHex);
    const shuffleSeed = hexToBytes(shuffleSeedHex);
    setPlayerSecrets(gameIdHex, playerId, secret, shuffleSeed);

    const opponentId = (playerId === 1 ? 2 : 1) as 1 | 2;
    let opponentSet = false;
    if (opponentSecretHex && opponentShuffleSeedHex) {
      setPlayerSecrets(gameIdHex, opponentId, BigInt("0x" + opponentSecretHex), hexToBytes(opponentShuffleSeedHex));
      opponentSet = true;
    } else {
      // doesPlayerHaveSpecificCard calls deck_getSecretFromPlayerId for both players
      // unconditionally. Fetch the opponent's secret from the backend so the witness
      // resolves correctly instead of falling back to the static random key.
      const backendOpponent = await this.fetchSecretFromBackend(lobbyId, opponentId);
      if (backendOpponent) {
        setPlayerSecrets(
          gameIdHex, opponentId,
          BigInt("0x" + backendOpponent.secret),
          backendOpponent.shuffleSeed ? hexToBytes(backendOpponent.shuffleSeed) : new Uint8Array(32),
        );
        opponentSet = true;
      }
    }

    const zkConfigProvider = new NodeZkConfigProvider(config.zkConfigPath);

    // Fetch contract public state ONCE — reused for all 21 card checks to avoid
    // 21 separate indexer round-trips. createUnprovenCallTxFromInitialStates
    // takes the state directly instead of fetching it on each call.
    const { contractState, zswapChainState } = await (getPublicStates as any)(
      publicDataProvider,
      contractAddress0,
    );
    // parseCoinPublicKeyToHex converts the wallet's CoinPublicKey to the hex string
    // format that createUnprovenCallTxFromInitialStates expects.
    const coinPublicKey = parseCoinPublicKeyToHex(walletProvider.getCoinPublicKey(), getNetworkId());
    const walletEncKey = walletProvider.getEncryptionPublicKey();

    const hand: Array<{ rank: number; suit: number }> = [];

    try {
      // Check all 21 card indices (7 ranks × 3 suits, index = rank + suit*7)
      // Args to doesPlayerHaveSpecificCard: (gameId: Uint8Array, playerId: bigint, cardIndex: bigint)
      for (let cardIndex = 0; cardIndex < 21; cardIndex++) {
        try {
          const callTxData = await (createUnprovenCallTxFromInitialStates as any)(
            zkConfigProvider,
            {
              compiledContract,
              circuitId: "doesPlayerHaveSpecificCard",
              contractAddress: contractAddress0,
              coinPublicKey,
              initialContractState: contractState,
              initialZswapChainState: zswapChainState,
              args: [gameIdBytes, BigInt(playerId), BigInt(cardIndex)],
            },
            walletEncKey,
          );
          const hasCard = callTxData?.private?.result as boolean | undefined;
          if (hasCard === true) {
            const rank = cardIndex % 7;
            const suit = Math.floor(cardIndex / 7);
            hand.push({ rank, suit });
          }
        } catch (err) {
          // Log individual card check errors but continue — a WASM assert for one
          // card index (e.g. because of a stale assert) shouldn't abort the whole query
          console.warn(`[GoFishMidnightAdapter.queryPlayerHand] cardIndex=${cardIndex} error:`, err instanceof Error ? err.message : String(err));
        }
      }
    } finally {
      clearPlayerSecrets(gameIdHex, playerId);
      if (opponentSet) {
        clearPlayerSecrets(gameIdHex, opponentId);
      }
    }

    console.log(`[GoFishMidnightAdapter.queryPlayerHand] player=${playerId} hand=${JSON.stringify(hand)}`);
    return hand;
  }
}

// Create the Go Fish Midnight adapter instance
// NOTE: We pass the Contract CLASS (not an instance) so the vendor adapter can build a
// CompiledContract using its own compact-js module (avoids Symbol mismatch across module instances).
export const midnightAdapter_go_fish = new GoFishMidnightAdapter(
  contractAddress0,
  GENESIS_MINT_WALLET_SEED,
  { ...midnightAdapterConfig0, contractTag: "go-fish-contract" },
  goFishContract.Contract,   // Pass the CLASS, not an instance
  goFishContractInfo.witnesses,
  contractInfo0,
  syncProtocolName,        // syncProtocolName
  // maxBatchSize in bytes — must be large enough for any single circuit call payload.
  // The actual "one circuit per batch" limit is enforced by maxInputs: 1 in buildBatchData().
  // applyMask/dealCards payloads with secrets can be ~500-1000 bytes.
  10000,
);

// Export all Midnight adapters for the batcher
export const midnightAdapters: Record<string, MidnightAdapter> = {
  "go-fish": midnightAdapter_go_fish,
};

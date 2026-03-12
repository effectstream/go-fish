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

import { type DefaultBatcherInput, MidnightAdapter, type MidnightBatchPayload } from "@paimaexample/batcher";
import { readMidnightContract } from "@paimaexample/midnight-contracts/read-contract";
import * as goFishContractInfo from "@go-fish/midnight-contract";
import * as goFishContract from "@go-fish/midnight-contract/contract";
import { setPlayerSecrets, clearPlayerSecrets } from "@go-fish/midnight-contract/witnesses";
import { CryptoManager } from "@paimaexample/crypto";
import { storage } from "./config.ts";

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
class GoFishMidnightAdapter extends MidnightAdapter {
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
    try {
      const response = await fetch(
        `${backendUrl}/api/midnight/player_secret?lobby_id=${encodeURIComponent(lobbyId)}&player_id=${playerId}`,
      );
      if (response.ok) {
        const data = await response.json() as { secret: string; shuffleSeed: string | null };
        console.log(`[GoFishMidnightAdapter] Fetched opponent secret from backend for ${lobbyId} player ${playerId}`);
        return data;
      }
      console.warn(`[GoFishMidnightAdapter] Backend returned ${response.status} for player_secret lookup`);
      return null;
    } catch (err) {
      console.warn(`[GoFishMidnightAdapter] Could not fetch opponent secret from backend:`, err);
      return null;
    }
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

    // Extract and set client-side secrets from the payload before circuit execution
    if (data?.payloads?.[0]) {
      const payload = data.payloads[0];
      if (payload.playerSecret && payload.shuffleSeed) {
        // Extract gameId and playerId from args
        const args = payload.args;
        if (Array.isArray(args) && args.length >= 2) {
          const gameId = args[0] as string;
          const playerId = Number(args[1]) as 1 | 2;
          const secret = BigInt("0x" + payload.playerSecret);
          const shuffleSeed = hexToBytes(payload.shuffleSeed);

          setPlayerSecrets(gameId, playerId, secret, shuffleSeed);
          secretInfo = { gameId, playerId };
          console.log(`[GoFishMidnightAdapter] Set client secrets for ${circuit}: game ${gameId}, player ${playerId}`);

          const opponentId = (playerId === 1 ? 2 : 1) as 1 | 2;

          if (payload.opponentSecret && payload.opponentShuffleSeed) {
            // Opponent secret provided directly in the payload — use it.
            const opponentSecret = BigInt("0x" + payload.opponentSecret);
            const opponentShuffleSeed = hexToBytes(payload.opponentShuffleSeed);
            setPlayerSecrets(gameId, opponentId, opponentSecret, opponentShuffleSeed);
            console.log(`[GoFishMidnightAdapter] Set opponent secrets for ${circuit}: game ${gameId}, player ${opponentId}`);
          } else {
            // Opponent secret not in payload (frontend doesn't have it — it's theirs to keep).
            // Fall back to the backend node which stores both players' secrets after setup replay.
            // This is needed for game-phase circuits (askForCard, respondToAsk, goFish,
            // afterGoFish) that call player_secret_key for BOTH players unconditionally.
            const lobbyId = this.hexToLobbyId(gameId);
            const backendOpponent = await this.fetchSecretFromBackend(lobbyId, opponentId);
            if (backendOpponent) {
              const opponentSecret = BigInt("0x" + backendOpponent.secret);
              setPlayerSecrets(gameId, opponentId, opponentSecret,
                backendOpponent.shuffleSeed ? hexToBytes(backendOpponent.shuffleSeed) : new Uint8Array(32));
              console.log(`[GoFishMidnightAdapter] Set backend-fetched opponent secret for ${circuit}: game ${gameId}, player ${opponentId}`);
              // Store on payload so retries re-use it without another backend round-trip
              payload.opponentSecret = backendOpponent.secret;
              if (backendOpponent.shuffleSeed) payload.opponentShuffleSeed = backendOpponent.shuffleSeed;
            } else {
              console.warn(`[GoFishMidnightAdapter] No opponent secret available for ${circuit} — proof may fail`);
            }
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
          await this.notifyBackendSetup(circuit, data);

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
            errMsg.includes("already started");
          const isStaleAssert = errMsg.includes("failed assert") && !isPermanentAssert;
          const isRetryable = isUnreachable || isProofServer500 || isStaleAssert;

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
            const reason = isProofServer500 ? "proof server 500 (on-chain state not yet confirmed)" :
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
            // Re-set secrets before retry since they were consumed by the failed attempt
            if (secretInfo) {
              const payload = data!.payloads[0];
              const secret = BigInt("0x" + payload.playerSecret);
              const shuffleSeed = hexToBytes(payload.shuffleSeed!);
              setPlayerSecrets(secretInfo.gameId, secretInfo.playerId as 1 | 2, secret, shuffleSeed);
              // Re-set opponent secrets too
              if (payload.opponentSecret && payload.opponentShuffleSeed) {
                const opponentId = (secretInfo.playerId === 1 ? 2 : 1) as 1 | 2;
                const opponentSecret = BigInt("0x" + payload.opponentSecret);
                const opponentShuffleSeed = hexToBytes(payload.opponentShuffleSeed);
                setPlayerSecrets(secretInfo.gameId, opponentId, opponentSecret, opponentShuffleSeed);
              }
            }
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
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
        // Also clear opponent secrets if they were set
        const payload = data?.payloads?.[0];
        if (payload?.opponentSecret) {
          const opponentId = (secretInfo.playerId === 1 ? 2 : 1) as 1 | 2;
          this.clearSecrets(secretInfo.gameId, opponentId);
        }
      }
    }
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
   * Pre-process input to extract and set client-side secrets
   * Called before the base adapter processes the circuit call
   */
  extractAndSetSecrets(inputJson: string): { gameId: string; playerId: number } | null {
    try {
      const circuitCall = JSON.parse(inputJson) as CircuitCallWithSecrets;

      // Check if secrets are included
      if (!circuitCall.playerSecret || !circuitCall.shuffleSeed) {
        console.log("[GoFishMidnightAdapter] No client secrets in circuit call, using defaults");
        return null;
      }

      // Extract gameId and playerId from circuit args
      // Most circuits have format: [gameId, playerId, ...]
      const args = circuitCall.args;
      if (!Array.isArray(args) || args.length < 2) {
        console.log("[GoFishMidnightAdapter] Cannot extract gameId/playerId from args");
        return null;
      }

      const gameId = args[0] as string; // Already hex-encoded
      const playerId = Number(args[1]) as 1 | 2;

      // Convert secrets from hex
      const secret = BigInt("0x" + circuitCall.playerSecret);
      const shuffleSeed = hexToBytes(circuitCall.shuffleSeed);

      // Set dynamic secrets for this circuit execution
      setPlayerSecrets(gameId, playerId, secret, shuffleSeed);
      console.log(`[GoFishMidnightAdapter] Set client secrets for game ${gameId}, player ${playerId}`);

      // Also set opponent secrets when provided
      if (circuitCall.opponentSecret && circuitCall.opponentShuffleSeed) {
        const opponentId = (playerId === 1 ? 2 : 1) as 1 | 2;
        const opponentSecret = BigInt("0x" + circuitCall.opponentSecret);
        const opponentShuffleSeed = hexToBytes(circuitCall.opponentShuffleSeed);
        setPlayerSecrets(gameId, opponentId, opponentSecret, opponentShuffleSeed);
        console.log(`[GoFishMidnightAdapter] Set opponent secrets for game ${gameId}, player ${opponentId}`);
      }

      return { gameId, playerId };
    } catch (error) {
      console.error("[GoFishMidnightAdapter] Error extracting secrets:", error);
      return null;
    }
  }

  /**
   * Notify the backend about successful setup circuit calls (applyMask, dealCards).
   * This updates the backend's in-memory setup state map so both players can
   * coordinate. More reliable than frontend-only notifications since the batcher
   * is the one that actually confirmed the transaction on-chain.
   */
  private async notifyBackendSetup(circuit: string, data: MidnightBatchPayload | null): Promise<void> {
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
    const body: Record<string, unknown> = { lobby_id: lobbyId, player_id: playerId, action };
    if (payload.playerSecret) body.player_secret = payload.playerSecret;
    if (payload.shuffleSeed) body.shuffle_seed = payload.shuffleSeed;
    if (payload.opponentSecret) body.opponent_secret = payload.opponentSecret;
    if (payload.opponentShuffleSeed) body.opponent_shuffle_seed = payload.opponentShuffleSeed;

    const backendUrl = Deno.env.get("BACKEND_URL") || "http://localhost:9996";
    try {
      const response = await fetch(`${backendUrl}/api/midnight/notify_setup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (response.ok) {
        console.log(`[GoFishMidnightAdapter] Backend notified: ${action} for ${lobbyId} player ${playerId}`);
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
   * Clear secrets after circuit execution
   */
  clearSecrets(gameId: string, playerId: number): void {
    clearPlayerSecrets(gameId, playerId as 1 | 2);
    console.log(`[GoFishMidnightAdapter] Cleared client secrets for game ${gameId}, player ${playerId}`);
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

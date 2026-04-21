import { MidnightService } from '../../services/MidnightService';
import * as GoFishContractService from '../../services/GoFishContractService';
import { queryHandFromBatcher, registerMidnightAddress } from '../../services/BatcherMidnightService';
import { PlayerKeyManager } from '../../services/PlayerKeyManager';
import { getLaceAddress } from '../../laceWalletBridge';
import type { Card } from '../../../../packages/shared/data-types/src/go-fish-types';
import { INDEX_TO_RANK, INDEX_TO_SUIT } from '../../../../packages/shared/data-types/src/go-fish-types';
import {
  appendEntry as appendLogEntry,
  loadEntries as loadLogEntries,
  replaceLastIfSource as replaceLastLogEntryIfSource,
  type GameLogEntry,
  type GameLogSource,
} from '../../services/GameLogStore';

export interface GameSceneState {
  phase: string;
  playerId: number;
  currentTurn: number;
  scores: [number, number];
  handSizes: [number, number];
  deckCount: number;
  isGameOver: boolean;
  myHand: Card[];
  myBooks: string[];
  opponentBooks: string[];
  opponentName: string;
  playerName: string;
  gameLog: GameLogEntry[];
  /** Last rank asked on-chain (numeric index 0–6). null when no ask in progress. */
  lastAskedRank: number | null;
  /** Unix seconds — contract timestamp of the most recent game-progressing
   *  move (set on ask / respond / draw / etc.). Drives the turn-timeout
   *  countdown. 0 = never moved or read failed. */
  lastMoveAt: number;
}

export type GameStateChangeHandler = (
  current: GameSceneState,
  previous: GameSceneState | null,
  changes: StateChanges,
) => void;

export interface StateChanges {
  phaseChanged: boolean;
  turnChanged: boolean;
  handChanged: boolean;
  scoresChanged: boolean;
  handSizesChanged: boolean;
  deckCountChanged: boolean;
  gameLogChanged: boolean;
  gameOver: boolean;
}

/**
 * Polls MidnightService for game state and dispatches changes to the Three.js scene.
 */
export class GameStateAdapter {
  private lobbyId: string;
  private walletAddress: string;
  private pollIntervalId: number | null = null;
  private pollIntervalMs = 5000;
  private previousState: GameSceneState | null = null;
  /** Signature (stringified sorted index list) of the last hand logged —
   *  used to dedupe the "contract hand:" poll log. */
  private lastHandLog: string | null = null;
  private onChange: GameStateChangeHandler;
  private polling = false;
  private midnightAddressRegistered = false;

  /** Frontend-driven action log — persisted per lobby in localStorage so a
   *  fresh tab on the same lobby restores the existing history. Trimmed to
   *  the last {@link GAME_LOG_CAP} entries to keep storage bounded; the HUD
   *  only shows the last 20 anyway. */
  private static readonly GAME_LOG_CAP = 200;

  /** Push a structured entry to the persistent log. The next state emission
   *  includes it so the HUD renders it immediately. */
  addLog(message: string, source: GameLogSource = 'action'): void {
    appendLogEntry(
      this.lobbyId,
      { time: Date.now(), message, source },
      GameStateAdapter.GAME_LOG_CAP,
    );
  }

  /** Append, or — if the previous entry shares `source` — overwrite it.
   *  Used by the "⏳ Waiting for…" status line so phase polls don't spam
   *  duplicate rows. */
  setLog(message: string, source: GameLogSource): void {
    replaceLastLogEntryIfSource(
      this.lobbyId,
      source,
      { time: Date.now(), message, source },
      GameStateAdapter.GAME_LOG_CAP,
    );
  }

  /** Read the persisted log for this lobby. */
  get gameLog(): GameLogEntry[] {
    return loadLogEntries(this.lobbyId);
  }

  constructor(
    lobbyId: string,
    walletAddress: string,
    onChange: GameStateChangeHandler,
  ) {
    this.lobbyId = lobbyId;
    this.walletAddress = walletAddress;
    this.onChange = onChange;
  }

  /** Unsubscribe from the WS contract state changes. */
  private unsubscribeWs: (() => void) | null = null;
  /** When true, the current poll was triggered by a WS notification. */
  private wsTriggered = false;

  start(): void {
    if (this.pollIntervalId !== null) return;
    this.midnightAddressRegistered = false;

    // Start the WS subscription — notification-only. When the contract
    // state changes on-chain, the WS fires and we re-query via HTTP to
    // get the fresh state. No cached state, no staleness bugs.
    GoFishContractService.startContractSubscription().catch(err => {
      console.warn('[GameStateAdapter] WS subscription setup failed, falling back to polling:', err);
    });
    this.unsubscribeWs = GoFishContractService.onContractStateChange(() => {
      // WS says "something changed" → fresh HTTP query.
      // Mark as WS-triggered so poll() always fires onChange even if
      // no game-state fields visibly changed. This is critical during
      // setup: masks/deals land on-chain (changing contract bytes) but
      // the game state fields (phase, scores, hands) stay identical.
      // Without this flag, the other browser never re-runs setup.
      this.wsTriggered = true;
      this.poll();
    });

    // Immediate first poll
    this.poll();
    // Safety fallback in case WS drops
    this.pollIntervalId = window.setInterval(() => this.poll(), 30000);
  }

  stop(): void {
    if (this.pollIntervalId !== null) {
      clearInterval(this.pollIntervalId);
      this.pollIntervalId = null;
    }
    this.unsubscribeWs?.();
    this.unsubscribeWs = null;
  }

  /** Force an immediate poll (e.g., after an action). */
  async forcePoll(): Promise<void> {
    await this.poll();
  }

  /**
   * Poll repeatedly until the on-chain phase matches one of the target phases
   * (or is no longer `currentPhase`), then return the updated state.
   *
   * This is used by action handlers that submit batcher transactions and need
   * to wait for the chain to confirm before proceeding to the next step.
   *
   * @param currentPhase  The phase we expect to be leaving (e.g. 'wait_draw')
   * @param targetPhases  Phases we consider "done" (e.g. ['wait_draw_check'])
   * @param timeoutMs     Give up after this many ms (default: 120 s)
   * @param intervalMs    How often to poll (default: 2 s)
   */
  async pollUntilPhase(
    currentPhase: string,
    targetPhases: string[],
    timeoutMs = 120_000,
    intervalMs = 2_000,
  ): Promise<GameSceneState | null> {
    const deadline = Date.now() + timeoutMs;
    // Two-stage polling: first wait for the chain to ENTER `currentPhase`
    // (the tx we just submitted is landing), then wait for it to LEAVE
    // (the other player's response / next action lands).
    //
    // `targetPhases` is a hint — we don't actually require a specific next
    // phase, just that we've moved past `currentPhase`. This is robust
    // across contract phase-flow changes (e.g., V3.1+ transfer goes
    // wait_response → turn_start directly instead of via wait_transfer).
    // Seed from the current adapter state. If previousState already shows
    // `currentPhase` (common: the handler that triggered this call just
    // observed the transition *into* currentPhase), we only need to wait
    // for the exit. Without this seed, a concurrent adapter poll firing
    // between tx submit and our first `forcePoll` can race past
    // currentPhase entirely — everSawCurrent stays false, we time out.
    let everSawCurrent = this.previousState?.phase === currentPhase;
    while (Date.now() < deadline) {
      await this.forcePoll();
      const state = this.previousState;
      if (state) {
        if (state.phase === currentPhase) {
          everSawCurrent = true;
        } else if (everSawCurrent) {
          // We entered and then left currentPhase — this is a real
          // transition. Return regardless of whether state.phase matches
          // any entry in `targetPhases`.
          return state;
        }
        // else: haven't observed currentPhase yet; keep polling.
      }
      await new Promise<void>(resolve => setTimeout(resolve, intervalMs));
    }
    console.warn(`[GameStateAdapter] pollUntilPhase: timed out waiting to leave '${currentPhase}' (everSawCurrent=${everSawCurrent})`);
    return this.previousState;
  }

  /**
   * Poll until EITHER player's score diverges from `baselineScores`. Used
   * after a book-scoring tx: the Midnight batcher can take up to ~30s to
   * land the tx, and we want to drive the cache/menu refresh as soon as
   * the contract confirms — not wait for the next 30s safety poll.
   *
   * Callers MUST pass a baseline captured BEFORE submitting the tx.
   * Relying on `this.previousState` at entry is unsafe: a concurrent
   * adapter poll (30s interval or WS-driven) can update previousState to
   * the post-change value between the tx submit and this call, making
   * "score changed" trivially false and causing a 30s wait-then-timeout.
   *
   * Returns the post-change state (null on timeout).
   */
  async pollUntilScoreChanged(
    baselineScores: [number, number],
    timeoutMs = 30_000,
    intervalMs = 2_000,
  ): Promise<GameSceneState | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await this.forcePoll();
      const state = this.previousState;
      if (state && (
        state.scores[0] !== baselineScores[0] ||
        state.scores[1] !== baselineScores[1]
      )) {
        return state;
      }
      await new Promise<void>(resolve => setTimeout(resolve, intervalMs));
    }
    console.warn('[GameStateAdapter] pollUntilScoreChanged: timed out');
    return null;
  }

  private async poll(): Promise<void> {
    if (this.polling) {
      // A poll is already in progress. If this was WS-triggered, schedule
      // a retry so the notification isn't silently lost.
      if (this.wsTriggered) {
        setTimeout(() => this.poll(), 500);
      }
      return;
    }
    this.polling = true;

    try {
      const rawState = await MidnightService.getGameState(this.lobbyId, this.walletAddress);
      if (!rawState) return;

      // When the wallet isn't in the players list yet, MidnightService
      // returns playerId=0 — typically a 1–5s indexer lag after a fresh
      // joinedLobby tx. The 30s safety poll is way too slow here, and WS
      // doesn't fire for this transition (the Midnight contract state
      // hasn't changed; only the EVM lobby_players row was inserted).
      // Schedule a fast re-poll until the wallet shows up.
      if (rawState.playerId === 0) {
        setTimeout(() => this.poll(), 2000);
      }

      // Decrypt player hand using the real player secret stored in PlayerKeyManager.
      // Only query once cards have been dealt — during setup/dealing phase the ledger
      // has no cards yet, so the query would correctly return 0 cards but mislead the UI.
      let myHand: Card[] = [];
      const phase = rawState.phase ?? 'dealing';

      const handIsReady = phase !== 'dealing' && phase !== 'waiting';
      if (handIsReady) {
        const pid = rawState.playerId as 1 | 2;

        // Read hand directly from the contract ledger by enumerating all 21
        // cards via doesPlayerHaveSpecificCard. The circuit applies the reverse
        // ec_mul using our secret (set in the witness module) to determine
        // ownership. Matches the e2e reference (readHand in _helpers.ts).
        try {
          const cardIndices = await GoFishContractService.queryHandFromContract(this.lobbyId, pid);
          // Sort by rank (idx % 7), then by suit (floor(idx / 7)) for a
          // stable, readable layout. Cosmetic only — the on-chain state is
          // unchanged.
          const sorted = [...cardIndices].sort((a, b) => (a % 7) - (b % 7) || Math.floor(a / 7) - Math.floor(b / 7));
          myHand = sorted.map(idx => ({
            rank: INDEX_TO_RANK[idx % 7] ?? 'A',
            suit: INDEX_TO_SUIT[Math.floor(idx / 7)] ?? 'hearts',
          }));
          // Dedupe: polling fires every 5-30s and the hand usually doesn't
          // change between polls. Only log when the sorted index list
          // actually differs from the last emission.
          const sig = JSON.stringify(sorted);
          if (this.lastHandLog !== sig) {
            this.lastHandLog = sig;
            console.log(`[GameStateAdapter] contract hand: ${sorted.length} cards idx=${sig} mapped=${JSON.stringify(myHand)}`);
          }
        } catch (err) {
          console.warn('[GameStateAdapter] Contract hand query failed:', err instanceof Error ? err.message : String(err));
        }
      }

      // Register Midnight shielded address once per session so leaderboard can track scores.
      if (!this.midnightAddressRegistered && rawState.playerId) {
        this.midnightAddressRegistered = true;
        const midnightAddr = getLaceAddress();
        if (midnightAddr) {
          registerMidnightAddress(this.lobbyId, rawState.playerId as 1 | 2, midnightAddr)
            .catch(err => console.warn('[GameStateAdapter] registerMidnightAddress failed:', err));
        }
      }

      // players is ordered by join order: index 0 = player 1, index 1 = player 2.
      // rawState.playerId is the positional ID (1 or 2), not the DB account ID.
      const players = rawState.players || [];
      const myPlayer = players[rawState.playerId - 1];
      const opponentPlayer = players[rawState.playerId === 1 ? 1 : 0];

      // Pull lastMoveAt from the contract in parallel with the rest of the
      // poll. Swallow errors — 0 just disables the countdown for this tick.
      let lastMoveAt = 0;
      try {
        lastMoveAt = await MidnightService.getLastMoveAt(this.lobbyId);
      } catch (err) {
        console.warn('[GameStateAdapter] getLastMoveAt failed:', err instanceof Error ? err.message : String(err));
      }

      const current: GameSceneState = {
        phase: rawState.phase ?? 'dealing',
        playerId: rawState.playerId,
        currentTurn: rawState.currentTurn,
        scores: rawState.scores as [number, number],
        handSizes: rawState.handSizes as [number, number],
        deckCount: rawState.deckCount,
        isGameOver: rawState.isGameOver,
        myHand,
        myBooks: rawState.myBooks ?? [],
        opponentBooks: rawState.opponentBooks ?? [],
        playerName: myPlayer?.name ?? `Player ${rawState.playerId}`,
        opponentName: opponentPlayer?.name ?? 'Opponent',
        gameLog: this.gameLog,
        lastAskedRank: (rawState.lastAskedRank as number | null | undefined) ?? null,
        lastMoveAt,
      };

      const changes = this.detectChanges(current, this.previousState);
      const hasAnyChange = Object.values(changes).some(Boolean);

      // Always fire onChange when:
      // - Any game state field changed (normal case)
      // - First poll (previousState is null)
      // - WS-triggered: contract bytes changed on-chain even though the
      //   visible game state fields look identical. Critical during setup
      //   where mask/deal landing doesn't change phase/scores/hands but
      //   the other browser MUST re-run runAutomaticSetup.
      const forceNotify = this.wsTriggered;
      this.wsTriggered = false;

      if (hasAnyChange || this.previousState === null || forceNotify) {
        this.onChange(current, this.previousState, changes);
      }

      this.previousState = current;
    } catch (err) {
      console.warn('[GameStateAdapter] Poll error:', err);
    } finally {
      this.polling = false;
    }
  }

  private detectChanges(current: GameSceneState, previous: GameSceneState | null): StateChanges {
    if (!previous) {
      return {
        phaseChanged: true,
        turnChanged: true,
        handChanged: true,
        scoresChanged: true,
        handSizesChanged: true,
        deckCountChanged: true,
        gameLogChanged: true,
        gameOver: current.isGameOver,
      };
    }

    const handChanged =
      current.myHand.length !== previous.myHand.length ||
      current.myHand.some(
        (c, i) =>
          !previous.myHand[i] ||
          c.rank !== previous.myHand[i].rank ||
          c.suit !== previous.myHand[i].suit,
      );

    return {
      phaseChanged: current.phase !== previous.phase,
      turnChanged: current.currentTurn !== previous.currentTurn,
      handChanged,
      scoresChanged:
        current.scores[0] !== previous.scores[0] ||
        current.scores[1] !== previous.scores[1],
      handSizesChanged:
        current.handSizes[0] !== previous.handSizes[0] ||
        current.handSizes[1] !== previous.handSizes[1],
      deckCountChanged: current.deckCount !== previous.deckCount,
      gameLogChanged:
        current.gameLog.length !== previous.gameLog.length ||
        (current.gameLog.length > 0 &&
          current.gameLog[current.gameLog.length - 1].time !==
            previous.gameLog[previous.gameLog.length - 1]?.time),
      gameOver: current.isGameOver && !previous.isGameOver,
    };
  }

  get currentState(): GameSceneState | null {
    return this.previousState;
  }
}

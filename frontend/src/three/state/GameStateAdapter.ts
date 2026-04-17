import { MidnightService } from '../../services/MidnightService';
import * as GoFishContractService from '../../services/GoFishContractService';
import { queryHandFromBatcher, registerMidnightAddress } from '../../services/BatcherMidnightService';
import { PlayerKeyManager } from '../../services/PlayerKeyManager';
import { getLaceAddress } from '../../laceWalletBridge';
import type { Card } from '../../../../packages/shared/data-types/src/go-fish-types';
import { INDEX_TO_RANK, INDEX_TO_SUIT } from '../../../../packages/shared/data-types/src/go-fish-types';

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
  opponentName: string;
  playerName: string;
  gameLog: string[];
  /** Last rank asked on-chain (numeric index 0–6). null when no ask in progress. */
  lastAskedRank: number | null;
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
  private onChange: GameStateChangeHandler;
  private polling = false;
  private midnightAddressRegistered = false;

  /** Frontend-driven action log — entries added by GameScene action handlers. */
  private localGameLog: string[] = [];

  /** Push a timestamped entry to the game log. The next state emission
   *  includes it so the HUD renders it immediately. */
  addLog(msg: string): void {
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    this.localGameLog.push(`[${time}] ${msg}`);
  }

  /** Get the current local log (used when building state). */
  get gameLog(): string[] {
    return this.localGameLog;
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
    while (Date.now() < deadline) {
      await this.forcePoll();
      const state = this.previousState;
      if (state && (targetPhases.includes(state.phase) || state.phase !== currentPhase)) {
        return state;
      }
      // Wait before next poll
      await new Promise<void>(resolve => setTimeout(resolve, intervalMs));
    }
    console.warn(`[GameStateAdapter] pollUntilPhase: timed out waiting to leave '${currentPhase}'`);
    return this.previousState;
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
          console.log(`[GameStateAdapter] contract hand: ${sorted.length} cards idx=${JSON.stringify(sorted)} mapped=${JSON.stringify(myHand)}`);
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
        playerName: myPlayer?.name ?? `Player ${rawState.playerId}`,
        opponentName: opponentPlayer?.name ?? 'Opponent',
        gameLog: this.localGameLog,
        lastAskedRank: (rawState.lastAskedRank as number | null | undefined) ?? null,
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
      gameLogChanged: current.gameLog.length !== previous.gameLog.length,
      gameOver: current.isGameOver && !previous.isGameOver,
    };
  }

  get currentState(): GameSceneState | null {
    return this.previousState;
  }
}

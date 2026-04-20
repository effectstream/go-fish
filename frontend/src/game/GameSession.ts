import { GameStateAdapter, type GameSceneState, type StateChanges } from '../three/state/GameStateAdapter';
import { MidnightService } from '../services/MidnightService';
import * as GoFishContractService from '../services/GoFishContractService';
import { PlayerKeyManager } from '../services/PlayerKeyManager';
import { registerSecret as batcherRegisterSecret } from '../services/BatcherMidnightService';
import { setCachedGame } from '../services/HandCache';
import { isBatcherModeEnabled } from '../proving/batcher-providers';
import type {
  SessionSnapshot,
  SetupPhase,
  InFlightState,
  GameSessionEventMap,
} from './types';

const RANK_NAMES = ['A', '2', '3', '4', '5', '6', '7'] as const;

/** Phase string → numeric code expected by the sidebar cache. Mirrors
 *  the reverse of `MidnightService.PHASE_NAMES`. */
const PHASE_STRING_TO_NUMBER: Record<string, number> = {
  dealing:         0,
  turn_start:      1,
  wait_response:   2,
  wait_transfer:   3,
  wait_draw:       4,
  wait_draw_check: 5,
  game_over:       6,
};

/**
 * One logical Go Fish game instance. Owns:
 *   • the state adapter (polling + WS)
 *   • the setup state machine (mask → deal → scoreInitialBooks)
 *   • all contract action dispatchers (ask / respond / afterGoFish / skipDraw)
 *   • all in-flight flags
 *   • auto-triggered reactions (auto-respond, auto-afterGoFish, setup resume)
 *
 * Does NOT own any DOM or Three.js state. The view (GameScene) subscribes
 * to session events and reflects them into the HUD / 3D scene.
 *
 * Sessions survive navigating away from the game screen: detaching the view
 * does not stop the session. `stop()` is the explicit teardown.
 */
export class GameSession extends EventTarget {
  readonly lobbyId: string;
  readonly walletAddress: string;

  private adapter: GameStateAdapter | null = null;
  private setupPhase: SetupPhase = 'idle';

  // Action-in-flight flags — drive the inFlight summary + loader states.
  private askInProgress = false;
  private respondInProgress = false;
  private drawInProgress = false;
  /** True while the post-deal scoreInitialBooks tx is in flight (V3.3: only
   *  submitted when the initial hand actually has a book; sentinel path is
   *  skipped entirely). */
  private initialBooksInProgress = false;
  /** Tracks whether we've already submitted scoreInitialBooks this session
   *  so reloads / WS re-fires don't double-submit. */
  private initialBookSubmitted = false;

  // V3.3 empty-hand flow flags
  private requestDrawInProgress = false;
  /** True while we're running drawCard as the opponent (non-asking player). */
  private opponentDrawInProgress = false;
  private skipTurnInProgress = false;

  // V3.1 asker-side book scoring (after a transfer)
  private scoringBookInProgress = false;

  // V4.2 end-game detector — fired at most once per terminal condition.
  private endGameFired = false;

  /**
   * When the asking player receives cards from the opponent, the on-chain
   * indexer may lag — the phase flips to turn_start before the transferred
   * cards appear in the hand. This tracks the minimum hand size we expect
   * before re-enabling card selection. Set in askForCard when cardCount > 0.
   */
  private expectedMinHandSize = 0;

  /** Direct WS subscription for setup coordination. */
  private unsubscribeSetupWs: (() => void) | null = null;

  /** Cached inFlight so we can diff transitions and emit events. */
  private lastInFlight: InFlightState = null;

  /** Resolved from the first successful poll. */
  private _playerId: 0 | 1 | 2 = 0;

  private started = false;

  constructor(lobbyId: string, walletAddress: string) {
    super();
    this.lobbyId = lobbyId;
    this.walletAddress = walletAddress;
  }

  get playerId(): 0 | 1 | 2 {
    return this._playerId;
  }

  /** Begin polling + setup. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.setupPhase = 'idle';
    this.askInProgress = false;
    this.respondInProgress = false;
    this.drawInProgress = false;
    this.initialBooksInProgress = false;
    this.initialBookSubmitted = false;
    this.requestDrawInProgress = false;
    this.opponentDrawInProgress = false;
    this.skipTurnInProgress = false;
    this.scoringBookInProgress = false;
    this.endGameFired = false;
    this.expectedMinHandSize = 0;
    this.lastInFlight = null;

    this.adapter = new GameStateAdapter(
      this.lobbyId,
      this.walletAddress,
      (current, previous, changes) => this.handleAdapterChange(current, previous, changes),
    );
    this.adapter.start();

    // Direct WS listener for setup coordination. When the opponent's
    // mask or deal lands on-chain, the contract state changes but the
    // game state fields (phase, scores, hands) look identical. This
    // listener ensures runAutomaticSetup fires immediately.
    this.unsubscribeSetupWs = GoFishContractService.onContractStateChange(() => {
      if (this.setupPhase === 'waiting_for_opponent') {
        console.log('[GameSession] WS: contract state changed while waiting_for_opponent → re-running setup');
        this.runAutomaticSetup();
      }
    });
  }

  /** Stop polling, tear down listeners, and emit `destroyed`. */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.adapter?.stop();
    this.adapter = null;
    this.unsubscribeSetupWs?.();
    this.unsubscribeSetupWs = null;
    this.emit('destroyed', {});
  }

  // ─────────────────────────────────────────────────────────────────────
  //  Snapshot + adapter passthroughs
  // ─────────────────────────────────────────────────────────────────────

  getState(): GameSceneState | null {
    return this.adapter?.currentState ?? null;
  }

  getSnapshot(): SessionSnapshot {
    return {
      lobbyId: this.lobbyId,
      playerId: this._playerId,
      state: this.getState(),
      inFlight: this.computeInFlight(),
      setupPhase: this.setupPhase,
      askInProgress: this.askInProgress,
      respondInProgress: this.respondInProgress,
      drawInProgress: this.drawInProgress,
      initialBooksInProgress: this.initialBooksInProgress,
      expectedMinHandSize: this.expectedMinHandSize,
    };
  }

  /** Push a timestamped line to the game log. The next state emission will
   *  include it (adapter's log is the source of truth for the view). */
  addLog(msg: string): void {
    this.adapter?.addLog(msg);
  }

  async forcePoll(): Promise<void> {
    await this.adapter?.forcePoll();
  }

  // ─────────────────────────────────────────────────────────────────────
  //  Event dispatch helpers
  // ─────────────────────────────────────────────────────────────────────

  private emit<K extends keyof GameSessionEventMap>(
    name: K,
    detail: GameSessionEventMap[K],
  ): void {
    this.dispatchEvent(new CustomEvent(name, { detail }));
  }

  private notify(title: string, message: string, durationMs: number): void {
    this.emit('notification', { title, message, durationMs });
  }

  private showBanner(message: string | null): void {
    this.emit('waitingBanner', { message });
  }

  /**
   * Recompute inFlight from the current flag mix and, if it changed, emit
   * `inFlightChange`. Call this at every edge that flips one of the flags.
   *
   * Priority: proving > sending > waiting > null. For Phase 1 we only
   * distinguish "something is in flight" from idle — callDelegated drives
   * the fine-grained proving/sending state directly on the global loader.
   */
  private recomputeInFlight(): void {
    const next = this.computeInFlight();
    if (next !== this.lastInFlight) {
      const from = this.lastInFlight;
      this.lastInFlight = next;
      this.emit('inFlightChange', { from, to: next });
    }
  }

  private computeInFlight(): InFlightState {
    if (
      this.askInProgress ||
      this.respondInProgress ||
      this.drawInProgress ||
      this.initialBooksInProgress ||
      this.requestDrawInProgress ||
      this.opponentDrawInProgress ||
      this.skipTurnInProgress ||
      this.scoringBookInProgress
    ) {
      return 'proving';
    }
    return null;
  }

  // ─────────────────────────────────────────────────────────────────────
  //  Adapter state-change handler — routes to setup / actions / events
  // ─────────────────────────────────────────────────────────────────────

  private handleAdapterChange(
    current: GameSceneState,
    previous: GameSceneState | null,
    changes: StateChanges,
  ): void {
    if (this._playerId === 0 && current.playerId) {
      this._playerId = current.playerId as 1 | 2;
    }

    // On first state update: push this player's secret to the backend so
    // fetchSecretFromBackend always has a valid secret for the opponent's
    // proof, even after a node restart.
    if (previous === null) {
      if (isBatcherModeEnabled() && current.playerId) {
        batcherRegisterSecret(this.lobbyId, current.playerId as 1 | 2).catch(() => {
          console.warn('[GameSession] registerSecret fire-and-forget failed — non-critical');
        });
      }
    }

    // Persist the full sidebar snapshot to localStorage so the Active
    // Games cards can render every field (hand, scores, names, turn,
    // phase, inFlight) without per-game contract queries. Write on every
    // change that would affect the sidebar — basically any stateChange
    // that flipped a relevant field.
    const sidebarChanged =
      previous === null ||
      changes.phaseChanged ||
      changes.turnChanged ||
      changes.handChanged ||
      changes.scoresChanged ||
      (previous && previous.opponentName !== current.opponentName);
    if (current.playerId && sidebarChanged) {
      const myIdx = current.playerId - 1;
      const oppIdx = current.playerId === 1 ? 1 : 0;
      setCachedGame({
        lobbyId: this.lobbyId,
        playerId: current.playerId as 1 | 2,
        lobbyName: this.lobbyId, // sidebar prefers findResumableGames' name; this is a fallback
        opponentName: current.opponentName,
        cards: current.myHand,
        myScore: current.scores[myIdx] ?? 0,
        opponentScore: current.scores[oppIdx] ?? 0,
        isMyTurn: current.currentTurn === current.playerId,
        phase: PHASE_STRING_TO_NUMBER[current.phase] ?? 0,
        inFlight: this.computeInFlight(),
        updatedAt: Date.now(),
      });
    }

    // Update the "⏳ Your turn…" / "Waiting for X…" status line in the log.
    // This mutates adapter.gameLog in place; the view will render it via the
    // next stateChange emission.
    if (changes.phaseChanged || changes.turnChanged) {
      this.updateStatusLogLine(current);
    }

    const isMyTurn = current.currentTurn === current.playerId;

    // Auto-respond: opponent just asked — we respond without a button click.
    // Fires on the phase transition and on rejoin (previous === null).
    if (changes.phaseChanged && current.phase === 'wait_response' && !isMyTurn) {
      if (!this.respondInProgress) {
        this.runRespondToAsk();
      }
    }
    if (previous === null && current.phase === 'wait_response' && !isMyTurn && !this.respondInProgress) {
      this.runRespondToAsk();
    }

    // Auto-afterGoFish: the asker must call afterGoFish after respondToAsk
    // drew a card (no goFish circuit exists). Fires on phase transition OR
    // on rejoin.
    const shouldAutoDraw =
      current.phase === 'wait_draw_check' &&
      isMyTurn &&
      !this.drawInProgress;
    if (shouldAutoDraw && (changes.phaseChanged || previous === null)) {
      this.runAfterGoFish();
    }

    // V3.3 empty-hand dispatchers. askForCard now rejects handSize==0, so the
    // empty-handed player takes their turn via requestToDrawCard (deck has
    // cards) or skipTurn (deck empty). Mirror of the auto-respond pattern —
    // fires on phase transition AND on rejoin.
    const myHandSize = current.handSizes[current.playerId - 1] ?? 0;
    const localTurnActionRunning =
      this.askInProgress ||
      this.requestDrawInProgress ||
      this.skipTurnInProgress ||
      this.scoringBookInProgress;
    const atMyTurnStart =
      current.phase === 'turn_start' && isMyTurn && !localTurnActionRunning;
    if (atMyTurnStart && myHandSize === 0 && (changes.phaseChanged || previous === null)) {
      if (current.deckCount > 0) {
        this.runRequestToDrawCard();
      } else {
        this.runSkipTurn();
      }
    }

    // V3.3: opponent resolves an empty-hand draw request. When phase is
    // WaitForDraw and I'm the NON-asking player, call drawCard to strip my
    // mask off the top deck card and hand it to the asker.
    const shouldAutoDrawForOpponent =
      current.phase === 'wait_draw' &&
      !isMyTurn &&
      !this.opponentDrawInProgress;
    if (shouldAutoDrawForOpponent && (changes.phaseChanged || previous === null)) {
      this.runDrawCard();
    }

    // V4.2: frontend must call `checkAndEndGame` after each turn to flip
    // the exhaustion terminal state (deck empty + either hand empty).
    // Early-win at 4 books is automatic inside addScore; only this path
    // needs a manual trigger. Fire once per terminal condition.
    if (changes.phaseChanged && current.phase === 'turn_start' && !current.isGameOver) {
      const deckEmpty = current.deckCount === 0;
      const anyHandEmpty = current.handSizes[0] === 0 || current.handSizes[1] === 0;
      if (deckEmpty && anyHandEmpty && !this.endGameFired) {
        this.endGameFired = true;
        void this.runCheckAndEndGame();
      }
    }

    // Detect "it just became my turn" and emit `needsAttention` so the
    // BackgroundNotifier can surface a toast when this session is not the
    // foreground one. Foreground sessions don't need the toast — the 3D
    // turn indicator already signals the same thing.
    const becameMyTurn =
      current.phase === 'turn_start' &&
      isMyTurn &&
      (previous === null ||
        previous.phase !== 'turn_start' ||
        previous.currentTurn !== current.currentTurn);
    if (becameMyTurn) {
      this.emit('needsAttention', {
        reason: 'your_turn',
        snapshot: this.getSnapshot(),
      });
    }

    // Bubble the raw state change to view subscribers. View handles: hand/
    // opponent/deck rendering, notifications, camera shake, celebrations,
    // loader/turn indicator drive, HUD update.
    this.emit('stateChange', {
      current,
      previous,
      changes,
      snapshot: this.getSnapshot(),
    });

    // Handle setup phase automation. With the WS subscription, state
    // changes trigger this callback instantly — no need for 2s polling.
    // Re-run setup when idle (first entry) OR when waiting for opponent
    // (the WS just delivered the opponent's mask/deal landing on-chain).
    if ((this.setupPhase === 'idle' || this.setupPhase === 'waiting_for_opponent') &&
        (current.phase === 'dealing' || current.phase === 'turn_start')) {
      this.runAutomaticSetup();
    }

    if (changes.gameOver) {
      const myIdx = current.playerId - 1;
      const oppIdx = current.playerId === 1 ? 1 : 0;
      const my = current.scores[myIdx];
      const theirs = current.scores[oppIdx];
      const winner: 1 | 2 | null =
        my > theirs ? (current.playerId as 1 | 2) :
        theirs > my ? (current.playerId === 1 ? 2 : 1) :
        null;
      this.emit('ended', { winner, snapshot: this.getSnapshot() });
    }
  }

  /**
   * Replace (or append) a single "⏳ …" status line in the game log based
   * on the current phase + turn. Preserves historic log entries.
   */
  private updateStatusLogLine(state: GameSceneState): void {
    if (!this.adapter) return;
    const opName = state.opponentName || 'Opponent';
    const statusPrefix = '⏳';
    const log = this.adapter.gameLog;
    const lastIsStatus = log.length > 0 && log[log.length - 1].includes(statusPrefix);
    const isMyTurn = state.currentTurn === state.playerId;

    let statusMsg = '';
    if (state.phase === 'turn_start' && isMyTurn) {
      statusMsg = `${statusPrefix} Your turn — pick a card to ask for`;
    } else if (state.phase === 'turn_start' && !isMyTurn) {
      statusMsg = `${statusPrefix} Waiting for ${opName} to ask...`;
    } else if (state.phase === 'wait_response' && !isMyTurn) {
      statusMsg = `${statusPrefix} ${opName} asked — check your hand and respond`;
    } else if (state.phase === 'wait_response' && isMyTurn) {
      statusMsg = `${statusPrefix} Waiting for ${opName} to respond...`;
    } else if (state.phase === 'wait_draw_check' || state.phase === 'wait_draw') {
      statusMsg = `${statusPrefix} Go Fish — resolve the draw`;
    } else if (state.phase === 'game_over') {
      statusMsg = '🏁 Game Over!';
    }

    if (!statusMsg) return;
    if (lastIsStatus) {
      log[log.length - 1] = statusMsg;
    } else {
      this.adapter.addLog(statusMsg.replace(/^\[.*?\] /, ''));
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  //  Setup phase machine
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Poll for setup status until a condition is met or timeout.
   */
  private async pollForSetupStatus(
    field: 'hasMaskApplied' | 'hasDealt',
    timeoutMs: number,
  ): Promise<boolean> {
    const startTime = Date.now();
    const pollIntervalMs = 2000;

    while (Date.now() - startTime < timeoutMs) {
      const status = await MidnightService.getSetupStatus(
        this.lobbyId,
        this._playerId as 1 | 2,
      );
      if (status[field]) return true;
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }
    return false;
  }

  /**
   * Schedule a setup retry after a delay. Directly re-runs setup rather
   * than relying on poll → onChange (which won't fire if game state
   * hasn't changed between polls).
   */
  private scheduleSetupRetry(delayMs: number): void {
    this.setupPhase = 'failed';
    setTimeout(() => {
      if (this.setupPhase !== 'failed') return; // Already progressed
      this.setupPhase = 'idle';
      this.runAutomaticSetup();
    }, delayMs);
  }

  /**
   * Automatically run the setup sequence (applyMask + dealCards + scoreInitialBooks).
   * Orchestrates three focused steps.
   */
  private async runAutomaticSetup(): Promise<void> {
    // Allow re-entry from 'idle' (first run) and 'waiting_for_opponent'
    // (WS delivered opponent's state change). Block re-entry from
    // 'applying_mask' / 'dealing' / 'syncing' (already in progress).
    if (this.setupPhase !== 'idle' && this.setupPhase !== 'waiting_for_opponent') return;
    this.setupPhase = 'applying_mask';

    try {
      console.log(`[GameSession] Starting automatic setup... lobbyId=${this.lobbyId}, myPlayerId=${this._playerId}`);

      const status = await MidnightService.getSetupStatus(this.lobbyId, this._playerId as 1 | 2);
      console.log('[GameSession] Setup status:', status);

      if (!await this.setupMask(status)) return;
      if (!await this.setupDealCards()) return;
      // V3.3 (2026-04-17): scoreInitialBooks no longer gates askForCard.
      // Only submit when the hand has a 3-of-rank book; skip entirely
      // otherwise. Always returns true — never blocks setup.
      if (!await this.claimInitialBookIfAny()) return;

      console.log('[GameSession] Automatic setup complete!');
      this.setupPhase = 'done';
      // Setup WS listener no longer needed — unsubscribe to avoid noise
      this.unsubscribeSetupWs?.();
      this.unsubscribeSetupWs = null;
      this.notify('Setup Complete', 'Waiting for game to start...', 5000);
      this.adapter?.forcePoll();
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('[GameSession] Automatic setup failed:', msg);
      this.notify('Error', 'Setup failed. Retrying...', 10000);
      this.scheduleSetupRetry(10000);
    } finally {
      // Global loader hide is driven by inFlightChange on the view side;
      // nothing to do here directly.
      this.recomputeInFlight();
    }
  }

  /** Step 1: Apply mask. Returns false if setup should be aborted/retried.
   *  ORDERING: P1 (lobby creator) applies first, P2 (joiner) waits for P1.
   *  Preserves EVM player order into the Midnight contract. */
  private async setupMask(status: { hasMaskApplied: boolean; opponentHasMaskApplied?: boolean }): Promise<boolean> {
    if (status.hasMaskApplied) {
      console.log('[GameSession] Mask already applied, skipping');
      this.setupPhase = 'waiting_for_opponent';
      return true;
    }

    // P2 must wait for P1's mask before applying their own.
    // No scheduleSetupRetry — the WS subscription will trigger
    // onGameStateChange when P1's mask lands, re-entering setup.
    if (this._playerId === 2 && !status.opponentHasMaskApplied) {
      console.log('[GameSession] Player 2 waiting for Player 1 to apply mask (WS will trigger next attempt)');
      this.notify('Setting Up', 'Waiting for opponent to shuffle the deck...', 30000);
      this.setupPhase = 'waiting_for_opponent';
      return false;
    }

    this.notify('Setting Up', 'Applying cryptographic mask — proving...', 60000);
    const pid = this._playerId as 1 | 2;
    const secretHex = PlayerKeyManager.getPlayerSecret(this.lobbyId, pid).toString(16).padStart(64, '0');
    const maskResult = await MidnightService.applyMask(this.lobbyId, pid, secretHex);

    if (maskResult.success) {
      console.log('[GameSession] Mask submitted to batcher, waiting for on-chain confirmation...');
      this.notify('Setting Up', 'Mask submitted — waiting for blockchain confirmation...', 120000);
      // Poll until the indexer confirms the mask is on-chain.
      // Without this wait, the setup loop retries immediately and
      // double-submits because hasMaskApplied is still false.
      const confirmed = await this.pollForSetupStatus('hasMaskApplied', 120000);
      if (confirmed) {
        console.log('[GameSession] Mask confirmed on-chain — forcing adapter poll so both browsers sync');
        this.adapter?.forcePoll(); // Trigger state refresh for WS listeners
        this.setupPhase = 'waiting_for_opponent';
        return true;
      }
      console.warn('[GameSession] Mask submitted but not confirmed within timeout');
      this.notify('Warning', 'Mask may not have landed — retrying...', 10000);
      this.scheduleSetupRetry(5000);
      return false;
    }

    const err = maskResult.errorMessage ?? '';
    if (err.includes('already applied') || err.includes('Player has already applied')) {
      console.log('[GameSession] Mask already applied (detected via error) - continuing');
      this.setupPhase = 'waiting_for_opponent';
      return true;
    }
    if (err.includes('timed out') || err.includes('NetworkError') || err.includes('fetch') ||
        err.includes('EffectStream processing validation failed') || err.includes('Timeout')) {
      console.log('[GameSession] Mask timed out, polling for on-chain confirmation...');
      const confirmed = await this.pollForSetupStatus('hasMaskApplied', 30000);
      if (confirmed) {
        this.setupPhase = 'waiting_for_opponent';
        return true;
      }
      this.notify('Setting Up', 'Retrying mask...', 10000);
      this.scheduleSetupRetry(10000);
      return false;
    }

    console.log(`[GameSession] Mask failed: ${err}, will retry in 5s`);
    this.notify('Error', err || 'Mask failed', 5000);
    this.scheduleSetupRetry(5000);
    return false;
  }

  /** Step 2: Deal cards. Returns false if setup should be aborted/retried. */
  private async setupDealCards(): Promise<boolean> {
    const updatedStatus = await MidnightService.getSetupStatus(this.lobbyId, this._playerId as 1 | 2);
    console.log('[GameSession] Updated setup status:', updatedStatus);

    if (updatedStatus.hasDealt) {
      console.log('[GameSession] Cards already dealt, skipping');
      return true;
    }

    // Wait for opponent to apply their mask
    if (!updatedStatus.opponentHasMaskApplied) {
      console.log('[GameSession] Waiting for opponent to apply mask (WS will trigger next attempt)');
      this.notify('Setting Up', 'Waiting for opponent...', 30000);
      this.setupPhase = 'waiting_for_opponent';
      return false;
    }

    // Brief pause for indexer to sync after opponent's mask lands.
    if (this.setupPhase === 'waiting_for_opponent') {
      console.log('[GameSession] Opponent mask applied, brief sync pause...');
      this.notify('Setting Up', 'Syncing blockchain state...', 10000);
      await new Promise(resolve => setTimeout(resolve, 2000));
      this.setupPhase = 'dealing';
    }

    const postSyncStatus = await MidnightService.getSetupStatus(this.lobbyId, this._playerId as 1 | 2);
    console.log('[GameSession] Post-sync setup status:', postSyncStatus);

    // V4.2 (2026-04-18): the contract no longer requires P1-deals-first.
    // Either player can submit dealCards once both masks are on-chain.
    // The deck-top counter serializes the two calls naturally, and
    // `hasDealt` already dedups — no explicit ordering wait needed.

    // Attempt dealCards with inline retry for "mask not yet on-chain" failures.
    // The batcher can take 30-60s to finalize applyMask transactions; we poll
    // until the on-chain state accepts the deal or we give up after 10 minutes.
    const pid = this._playerId as 1 | 2;
    const secretHex = PlayerKeyManager.getPlayerSecret(this.lobbyId, pid).toString(16).padStart(64, '0');
    const seedBytes = PlayerKeyManager.getShuffleSeed(this.lobbyId, pid);
    const seedHex = Array.from(seedBytes).map((b: number) => b.toString(16).padStart(2, '0')).join('');

    const dealDeadlineMs = Date.now() + 10 * 60 * 1000; // 10 minute deadline (batcher retry can take 90s+)
    let lastErr = '';
    while (Date.now() < dealDeadlineMs) {
      this.notify('Setting Up', 'Dealing cards...', 30000);
      const dealResult = await MidnightService.dealCards(this.lobbyId, pid, secretHex, seedHex);

      if (dealResult.success) {
        console.log('[GameSession] Cards submitted to batcher, waiting for on-chain confirmation...');
        this.notify('Setting Up', 'Cards submitted — waiting for blockchain confirmation...', 120000);
        const confirmed = await this.pollForSetupStatus('hasDealt', 120000);
        if (confirmed) {
          console.log('[GameSession] Cards dealt and confirmed on-chain — forcing adapter poll so both browsers sync');
          this.adapter?.forcePoll(); // Trigger state refresh for WS listeners
          return true;
        }
        console.warn('[GameSession] dealCards submitted but not confirmed within timeout');
        continue; // retry the while loop
      }

      lastErr = dealResult.errorMessage ?? '';
      console.log(`[GameSession] dealCards attempt failed: ${lastErr}`);

      if (lastErr.includes('already dealt') || lastErr.includes('has already dealt') ||
          lastErr.includes('Both players have already dealt')) {
        console.log('[GameSession] Cards already dealt (detected via error) - continuing');
        return true;
      }
      if (lastErr.includes('timed out') || lastErr.includes('NetworkError') || lastErr.includes('fetch') ||
          lastErr.includes('EffectStream processing validation failed') || lastErr.includes('Timeout')) {
        const confirmed = await this.pollForSetupStatus('hasDealt', 30000);
        if (confirmed) {
          console.log('[GameSession] Cards were dealt despite timeout');
          return true;
        }
        // Network issue — retry in 10s (stays in while loop)
        this.notify('Setting Up', 'Retrying deal...', 10000);
        await new Promise(resolve => setTimeout(resolve, 10000));
        continue;
      }
      if (lastErr.includes('must apply mask') || lastErr.includes('apply mask before dealing')) {
        // Masks not yet visible on-chain — wait and retry without resetting phase
        console.log('[GameSession] Masks not yet on-chain, waiting 5s before retry...');
        this.notify('Setting Up', 'Waiting for blockchain confirmation...', 10000);
        await new Promise(resolve => setTimeout(resolve, 5000));
        continue;
      }
      if (lastErr.includes('unreachable')) {
        this.notify('Setting Up', 'Waiting for blockchain sync...', 10000);
        await new Promise(resolve => setTimeout(resolve, 10000));
        continue;
      }

      // Unknown error — fall back to full retry
      break;
    }

    console.log(`[GameSession] Deal failed: ${lastErr}, will retry full setup in 5s`);
    this.notify('Error', lastErr || 'Deal failed', 5000);
    this.scheduleSetupRetry(5000);
    return false;
  }

  /**
   * V3.3 (2026-04-17): `scoreInitialBooks` is no longer a gate for
   * `askForCard`. We only submit the tx when the initial 4-card hand
   * actually contains a 3-of-a-kind book; otherwise we skip entirely and
   * return immediately so gameplay starts within seconds instead of
   * blocking on the ~60s batcher confirmation.
   *
   * The submit itself is fire-and-forget — we don't wait for either
   * player's flag to flip. Contract auto-books any transferred book via
   * checkAndScoreBook (asker-side) or the inline inspection in
   * `afterGoFish`, so a player who forfeits their initial book just holds
   * those cards for a little longer, no protocol damage.
   *
   * Always returns `true` (never blocks setup). Errors are reported via
   * `notify()` but don't fail the setup flow.
   */
  private async claimInitialBookIfAny(): Promise<boolean> {
    const pid = this._playerId as 1 | 2;

    if (this.initialBookSubmitted) return true;

    // Best-effort short-circuit: if my flag is already true on-chain (e.g.,
    // page reload mid-setup), don't submit again.
    const alreadyScored = await GoFishContractService
      .queryHasInitialBooksScored(this.lobbyId, pid)
      .catch(() => false);
    if (alreadyScored) {
      this.initialBookSubmitted = true;
      return true;
    }

    // Read the hand; abort if the ledger isn't ready yet (dealing lag).
    let hand21: boolean[];
    try {
      hand21 = await GoFishContractService.queryDiscoverHand(this.lobbyId, pid);
    } catch (err) {
      console.warn('[GameSession] claimInitialBookIfAny: discoverHand failed, skipping:', err);
      return true;
    }

    const bookIndices = this.computeInitialBookIndices(hand21);
    if (bookIndices[0] === 255n) {
      // Sentinel path — no book to claim. Skipped entirely under V3.3;
      // contract doesn't require us to flag this.
      console.log(`[GameSession] claimInitialBookIfAny: no initial book for pid=${pid}, skipping`);
      return true;
    }

    this.initialBooksInProgress = true;
    this.recomputeInFlight();
    try {
      this.notify('Claiming Book', 'You dealt an opening book — claiming it...', 30000);
      this.addLog(`📚 Claiming opening book of rank ${bookIndices[0] % 7n}s...`);
      await GoFishContractService.callScoreInitialBooks(this.lobbyId, pid, bookIndices);
      this.initialBookSubmitted = true;
      this.addLog('✅ Opening book claimed');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[GameSession] claimInitialBookIfAny failed (non-fatal):', msg);
      // Don't fail setup — the book just stays unclaimed in hand. Transfer
      // book scoring still works for it later if they end up trading the rank.
    } finally {
      this.initialBooksInProgress = false;
      this.recomputeInFlight();
    }
    return true;
  }

  /** Poll both players' `hasDealt` flags until both are true, or timeout.
   *  The contract asserts dealing-complete before scoreInitialBooks; this
   *  ensures we don't submit before the opponent's dealCards tx has landed. */
  private async waitForBothDealt(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const [p1, p2] = await Promise.all([
          MidnightService.getSetupStatus(this.lobbyId, 1),
          MidnightService.getSetupStatus(this.lobbyId, 2),
        ]);
        if (p1.hasDealt && p2.hasDealt) return true;
      } catch (err) {
        // Transient read failure — keep polling.
        console.warn('[GameSession] waitForBothDealt: status read failed, retrying', err);
      }
      await new Promise(r => setTimeout(r, 2000));
    }
    return false;
  }

  /** Given the 21-wide boolean vector from discoverHand, find any 3 cards
   *  sharing a rank (rank = idx % 7). Returns their indices as a sorted
   *  triple of bigints, or the sentinel [255n, 255n, 255n] for "no book". */
  private computeInitialBookIndices(hand21: boolean[]): [bigint, bigint, bigint] {
    const byRank = new Map<number, number[]>();
    for (let i = 0; i < hand21.length; i++) {
      if (!hand21[i]) continue;
      const r = i % 7;
      if (!byRank.has(r)) byRank.set(r, []);
      byRank.get(r)!.push(i);
    }
    for (const idxs of byRank.values()) {
      if (idxs.length >= 3) {
        const sorted = idxs.slice(0, 3).sort((a, b) => a - b);
        return [BigInt(sorted[0]), BigInt(sorted[1]), BigInt(sorted[2])];
      }
    }
    return [255n, 255n, 255n];
  }

  // ─────────────────────────────────────────────────────────────────────
  //  Player-driven actions
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Submit an askForCard transaction. The caller (view) is responsible for
   * validating phase/turn and UI-side opponent selection before invoking.
   *
   * Emits `waitingBanner` for the full duration and clears it when the
   * opponent responds. Sets `expectedMinHandSize` so the view can gate card
   * interactivity until the transferred cards arrive from the batcher.
   */
  async askForCard(rankIndex: number): Promise<void> {
    if (this.askInProgress) return;
    this.askInProgress = true;
    this.recomputeInFlight();

    const rankLabel = RANK_NAMES[rankIndex] ?? '';
    this.showBanner(`Asking for ${rankLabel}s — waiting for opponent's response...`);

    try {
      const handBefore = this.getState()?.myHand.length ?? 0;
      this.addLog(`🃏 Asking for ${rankLabel}s — proving...`);
      const result = await MidnightService.askForCard(this.lobbyId, this._playerId as 1 | 2, rankIndex);
      if (result.success) {
        this.addLog(`🃏 Asked for ${rankLabel}s — waiting for opponent`);
        // Wait for the opponent to respond — phase leaves wait_response into
        // one of three states:
        //   - turn_start         (V3.1+ transfer path — respondToAsk does
        //                         the transfer inline and sets TurnStart)
        //   - wait_draw_check    (go-fish path — afterGoFish auto-triggers)
        //   - wait_draw          (V3.3 empty-hand request — not applicable
        //                         here since askForCard requires non-empty)
        // Generous timeout: proof + batcher + indexer can total 90-180s
        // per player, and we wait for BOTH asker's ask AND opponent's
        // respond to settle. 240s covers realistic worst-case.
        await this.adapter?.pollUntilPhase(
          'wait_response',
          ['wait_draw_check', 'turn_start'],
          240_000,
        );

        // V3.1 (2026-04-17): detect transfer by phase + turn, not hand
        // growth. The contract goes wait_response → turn_start directly on
        // transfer (asker keeps the turn). Go-fish goes wait_response →
        // wait_draw_check (asker also keeps turn, different phase).
        // Refresh from chain because pollUntilPhase may have timed out
        // just before the transition landed in the indexer.
        await this.adapter?.forcePoll();
        const stateNow = this.getState();
        const isTransferPath =
          stateNow !== null &&
          stateNow.phase === 'turn_start' &&
          stateNow.currentTurn === stateNow.playerId;

        if (isTransferPath) {
          const handAfter = stateNow.myHand.length;
          this.expectedMinHandSize = handAfter;
          console.log(`[GameSession] askForCard: transfer detected (hand ${handBefore} → ${handAfter}, phase=turn_start)`);

          // V3.1 bug-fix path: `respondToAsk` cannot safely auto-book for
          // the asker (dummy-secret problem — see CONTRACT_V3.md V3.1).
          // So after the transfer settles, *we* (the asker) check if we
          // now hold 3 of the asked rank and claim via checkAndScoreBook.
          try {
            await this.maybeClaimBookAfterTransfer(rankIndex);
          } catch (err) {
            console.warn('[GameSession] maybeClaimBookAfterTransfer failed:', err);
          }
        }

        // Clear the waiting banner — opponent has responded
        this.showBanner(null);
        this.adapter?.forcePoll();
      } else {
        this.showBanner(null);
        this.notify('Error', result.errorMessage ?? 'Ask failed', 5000);
      }
    } catch (err) {
      console.error('[GameSession] askForCard error:', err);
      this.showBanner(null);
      this.notify('Error', 'Failed to ask for card', 5000);
    } finally {
      this.askInProgress = false;
      this.recomputeInFlight();
    }
  }

  /**
   * V3.1 bug-fix helper: after a successful respondToAsk transfer, wait for
   * phase to settle into `turn_start` (so the transferred cards are visible
   * in our hand on-chain), count the asked rank, and submit
   * `checkAndScoreBook` if we now hold 3 of that rank. Best-effort — any
   * failure is logged and swallowed (the caller's askForCard has already
   * succeeded; a failed book claim is not a game-breaking error).
   */
  private async maybeClaimBookAfterTransfer(rankIndex: number): Promise<void> {
    if (this.scoringBookInProgress) return;

    // V3.1+: after respondToAsk's transfer path, phase is already turn_start
    // and the hand has grown by the transferred cards. Unlike the older
    // wait_transfer phase, there's no additional transition to poll for —
    // caller already forcePoll'd right before calling us. We just need to
    // re-read the hand via a contract query (not adapter cache) to pick up
    // any indexer lag that might have missed the new cards on the last poll.
    let handIndices: number[] = [];
    try {
      handIndices = await GoFishContractService.queryHandFromContract(
        this.lobbyId,
        this._playerId as 1 | 2,
      );
    } catch (err) {
      console.warn('[GameSession] maybeClaimBookAfterTransfer: hand read failed, skipping:', err);
      return;
    }

    const rankCount = handIndices.filter(idx => (idx % 7) === rankIndex).length;
    if (rankCount < 3) return; // no book formed — nothing to claim

    this.scoringBookInProgress = true;
    this.recomputeInFlight();
    try {
      const rankLabel = RANK_NAMES[rankIndex] ?? String(rankIndex);
      this.addLog(`📚 Claiming book of ${rankLabel}s...`);
      const result = await MidnightService.checkAndScoreBook(
        this.lobbyId,
        this._playerId as 1 | 2,
        rankIndex,
      );
      if (result.success) {
        this.addLog(`✅ Book of ${rankLabel}s scored`);
        void this.adapter?.forcePoll();
      } else {
        console.warn('[GameSession] checkAndScoreBook returned non-success:', result.errorMessage);
      }
    } catch (err) {
      console.warn('[GameSession] checkAndScoreBook threw (non-fatal):', err);
    } finally {
      this.scoringBookInProgress = false;
      this.recomputeInFlight();
    }
  }

  /**
   * V3.3: empty-hand player at their turn, deck has cards. Submit
   * requestToDrawCard — contract flips phase to WaitForDraw and the
   * opponent resolves via drawCard.
   */
  private async runRequestToDrawCard(): Promise<void> {
    if (this.requestDrawInProgress) return;
    this.requestDrawInProgress = true;
    this.recomputeInFlight();
    try {
      this.notify('Drawing...', 'Your hand is empty — requesting a card from the deck...', 30000);
      this.addLog('🆘 Hand empty — requesting a draw');
      const result = await MidnightService.requestToDrawCard(
        this.lobbyId,
        this._playerId as 1 | 2,
      );
      if (result.success) {
        // Wait for the opponent to complete drawCard (phase flips back to
        // turn_start). No book check possible — hand went 0→1.
        await this.adapter?.pollUntilPhase('wait_draw', ['turn_start']);
        await this.adapter?.forcePoll();
      } else {
        this.notify('Error', result.errorMessage ?? 'Request draw failed', 5000);
      }
    } catch (err) {
      console.error('[GameSession] requestToDrawCard error:', err);
      this.notify('Error', 'Failed to request draw', 5000);
    } finally {
      this.requestDrawInProgress = false;
      this.recomputeInFlight();
    }
  }

  /**
   * V3.3: opponent resolves an empty-hand draw request. I'm the NON-asking
   * player; strip my mask from the top deck card and hand it to the asker.
   * Auto-triggered when phase becomes WaitForDraw and I'm not the active
   * turn player.
   */
  private async runDrawCard(): Promise<void> {
    if (this.opponentDrawInProgress) return;
    this.opponentDrawInProgress = true;
    this.recomputeInFlight();
    try {
      this.notify('Helping Opponent', 'Drawing a card for the opponent...', 30000);
      this.addLog('🃏 Drawing for empty-handed opponent');
      const result = await MidnightService.drawCard(
        this.lobbyId,
        this._playerId as 1 | 2,
      );
      if (result.success) {
        await this.adapter?.pollUntilPhase('wait_draw', ['turn_start']);
        await this.adapter?.forcePoll();
      } else {
        this.notify('Error', result.errorMessage ?? 'drawCard failed', 5000);
      }
    } catch (err) {
      console.error('[GameSession] drawCard error:', err);
      this.notify('Error', 'Failed to draw for opponent', 5000);
    } finally {
      this.opponentDrawInProgress = false;
      this.recomputeInFlight();
    }
  }

  /**
   * V3.3: empty-hand AND empty-deck skip. Just switches turn. Auto-triggered
   * when it's our turn at turn_start with no cards and no deck left.
   */
  private async runSkipTurn(): Promise<void> {
    if (this.skipTurnInProgress) return;
    this.skipTurnInProgress = true;
    this.recomputeInFlight();
    try {
      this.notify('Skipping Turn', 'Hand and deck are empty — passing turn...', 10000);
      this.addLog('⏭️  Hand and deck empty — skipping turn');
      const result = await MidnightService.skipTurn(
        this.lobbyId,
        this._playerId as 1 | 2,
      );
      if (result.success) {
        await this.adapter?.forcePoll();
      } else {
        this.notify('Error', result.errorMessage ?? 'skipTurn failed', 5000);
      }
    } catch (err) {
      console.error('[GameSession] skipTurn error:', err);
      this.notify('Error', 'Failed to skip turn', 5000);
    } finally {
      this.skipTurnInProgress = false;
      this.recomputeInFlight();
    }
  }

  /**
   * V4.2: fires the `checkAndEndGame` tx when the deck is empty and at least
   * one hand is empty. Fire-and-forget — idempotent on the contract side.
   * Gated by `endGameFired` so we don't spam proofs when the state is stuck
   * in a terminal-looking configuration.
   */
  private async runCheckAndEndGame(): Promise<void> {
    this.addLog('🏁 Checking for game-over (deck + hand exhaustion)');
    try {
      const result = await MidnightService.checkAndEndGame(
        this.lobbyId,
        this._playerId as 1 | 2,
      );
      if (result.success) {
        void this.adapter?.forcePoll();
      } else {
        console.warn('[GameSession] checkAndEndGame returned non-success:', result.errorMessage);
        // Don't reset endGameFired — if the contract rejects, no amount of
        // retries will help. The flag unsticks on next session start.
      }
    } catch (err) {
      console.warn('[GameSession] checkAndEndGame threw (non-fatal):', err);
    }
  }

  /** Submit the skipDraw tx when the deck is empty. */
  async skipDraw(): Promise<void> {
    try {
      const result = await MidnightService.skipDrawDeckEmpty(this.lobbyId, this._playerId as 1 | 2);
      if (result.success) {
        this.notify('Turn Ended', 'Deck is empty', 5000);
        this.adapter?.forcePoll();
      } else {
        this.notify('Error', result.errorMessage ?? 'Skip failed', 5000);
      }
    } catch (err) {
      console.error('[GameSession] skipDraw error:', err);
      this.notify('Error', 'Failed to skip draw', 5000);
    }
  }

  /**
   * Auto-triggered when opponent asks us a card. Runs respondToAsk which
   * either gives cards (wait_transfer) or signals Go Fish (wait_draw).
   */
  private async runRespondToAsk(): Promise<void> {
    if (this.respondInProgress) return;
    this.respondInProgress = true;
    this.recomputeInFlight();
    try {
      this.notify('Responding...', 'Checking hand...', 5000);
      this.addLog('🔍 Checking hand — proving...');
      const result = await MidnightService.respondToAsk(this.lobbyId, this._playerId as 1 | 2);
      if (result.success) {
        if (result.hasCards) {
          this.addLog(`📤 Gave ${result.cardCount} card(s) to opponent`);
          this.notify('Responding...', `Transferring ${result.cardCount} card(s) — waiting for chain...`, 30000);
        } else {
          this.addLog('🎣 Go Fish — opponent draws from deck');
          this.notify('Responding...', 'Go Fish! — waiting for chain...', 30000);
        }

        // Wait for the chain to leave wait_response before declaring success.
        // When the respondToAsk circuit executes:
        //   hasCards=true  → phase becomes wait_transfer
        //   hasCards=false → phase becomes wait_draw
        await this.adapter?.pollUntilPhase(
          'wait_response',
          ['wait_transfer', 'wait_draw'],
        );

        if (result.hasCards) {
          this.notify('Cards Given', `You gave ${result.cardCount} card(s)`, 5000);
        } else {
          this.notify('Go Fish!', 'You don\'t have that card', 5000);
        }
        await this.adapter?.forcePoll();
      } else {
        this.notify('Error', result.errorMessage ?? 'Response failed', 5000);
      }
    } catch (err) {
      console.error('[GameSession] respondToAsk error:', err);
      this.notify('Error', 'Failed to respond', 5000);
    } finally {
      this.respondInProgress = false;
      this.recomputeInFlight();
    }
  }

  /**
   * Auto-triggered when it's our turn and the phase is wait_draw_check.
   * respondToAsk has already drawn the card internally; we just call
   * afterGoFish to finalize the decrypted check.
   */
  private async runAfterGoFish(): Promise<void> {
    this.drawInProgress = true;
    this.recomputeInFlight();
    try {
      this.notify('Drawing...', 'Go Fish! Resolving draw...', 5000);
      this.emit('sound', { name: 'goFish' });

      this.addLog('🎣 Resolving draw — proving...');
      const result = await MidnightService.afterGoFish(
        this.lobbyId,
        this._playerId as 1 | 2,
      );
      if (!result.success) {
        this.notify('Error', result.errorMessage ?? 'afterGoFish failed', 5000);
        return;
      }
      this.addLog('🎣 Draw resolved — submitted');

      const handBefore = this.getState()?.myHand ?? [];

      // Wait for the chain to advance out of WaitForDrawCheck.
      this.notify('Drawing...', 'Waiting for chain confirmation...', 30000);
      const stateAfterDraw = await this.adapter?.pollUntilPhase(
        'wait_draw_check',
        ['turn_start'],
      );

      const handAfter = stateAfterDraw?.myHand ?? this.getState()?.myHand ?? [];

      // Detect the newly drawn card and emit so the view can notify + animate.
      const newCard = handAfter.find(
        c => !handBefore.some(b => b.rank === c.rank && b.suit === c.suit),
      );
      if (newCard) {
        this.emit('drewCard', { card: newCard });
      }

      // Final poll to sync UI with the post-afterGoFish chain state.
      await this.adapter?.forcePoll();
    } catch (err) {
      console.error('[GameSession] goFish error:', err);
      this.notify('Error', 'Failed to draw', 5000);
    } finally {
      this.drawInProgress = false;
      this.recomputeInFlight();
    }
  }
}

import { GameStateAdapter, type GameSceneState, type StateChanges } from '../three/state/GameStateAdapter';
import { MidnightService } from '../services/MidnightService';
import * as GoFishContractService from '../services/GoFishContractService';
import { PlayerKeyManager } from '../services/PlayerKeyManager';
import { registerSecret as batcherRegisterSecret } from '../services/BatcherMidnightService';
import { setCachedGame, getCachedGame } from '../services/HandCache';
import { isBatcherModeEnabled } from '../proving/batcher-providers';
import { applyMyMask as applyMyMaskFlow } from './SetupFlow';
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

  // V3.3 empty-hand flow flags
  private requestDrawInProgress = false;
  /** True while we're running drawCard as the opponent (non-asking player). */
  private opponentDrawInProgress = false;
  private skipTurnInProgress = false;

  // Single mutex for ALL book-scoring paths: auto-book on turn start,
  // asker-side book after transfer. The V3.3 scoreInitialBooks path is
  // gone — checkAndScoreBook is the universal book-scoring circuit now
  // (see runAutoScoreBook / maybeClaimBookAfterTransfer).
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

  /** Cached inFlight so we can diff transitions and emit events. */
  private lastInFlight: InFlightState = null;

  /** Resolved from the first successful poll. */
  private _playerId: 0 | 1 | 2 = 0;

  private started = false;

  /** Synchronous re-entry guard for runAutomaticSetup. The existing
   *  setupPhase check only flips to 'dealing' after two awaits (mask +
   *  status read), so adapter polls that fire during those awaits can all
   *  slip past `setupPhase === 'idle'` in parallel and issue duplicate
   *  applyMask / dealCards txs. This flag is set BEFORE any await and
   *  cleared in finally. */
  private setupInProgress = false;

  /** Dedup key for {@link logWaitingFor}. Same key in a row is a no-op;
   *  different key appends a new log line. Cleared when a non-waiting log
   *  fires so re-entering the same waiting state later re-logs once. */
  private lastWaitingForKey: string | null = null;

  /** Display name from /lobby_state, resolved once at start(). Used by
   *  cache writes so the Active Games card shows "Alice's Lobby" instead
   *  of the raw lobby_id. Falls back to the lobby_id if the fetch fails
   *  (e.g., backend not ready). */
  private displayName: string = '';

  constructor(lobbyId: string, walletAddress: string) {
    super();
    this.lobbyId = lobbyId;
    this.walletAddress = walletAddress;
    this.displayName = lobbyId; // fallback until resolveDisplayName completes
  }

  get playerId(): 0 | 1 | 2 {
    return this._playerId;
  }

  /** Display name from /lobby_state (resolved async on start). Falls back
   *  to the raw lobby_id until resolved. Read by LobbyListScreen so the
   *  Active Games card can render a proper name even before the session
   *  has any game state. */
  get name(): string {
    return this.displayName;
  }

  /** Begin polling + setup. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.setupPhase = 'idle';
    this.askInProgress = false;
    this.respondInProgress = false;
    this.drawInProgress = false;
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

    // Resolve the display name from /lobby_state once so cache writes
    // don't have to guess or fall back to the raw lobby_id. Fire-and-
    // forget — if it fails, the raw id stays as a reasonable fallback.
    void this.resolveDisplayName();
  }

  /** Fetch the lobby_name from /lobby_state. Used to populate HandCache
   *  with a proper display name for the Active Games sidebar card. */
  private async resolveDisplayName(): Promise<void> {
    try {
      const { API_BASE_URL } = await import('../apiConfig');
      const res = await fetch(`${API_BASE_URL}/lobby_state?lobby_id=${this.lobbyId}`);
      if (!res.ok) return;
      const data = await res.json();
      const name = typeof data?.lobby_name === 'string' ? data.lobby_name.trim() : '';
      if (name) {
        this.displayName = name;
        console.log(`[GameSession] resolved displayName for ${this.lobbyId}: "${name}"`);
      }
    } catch (err) {
      console.warn('[GameSession] resolveDisplayName failed:', err);
    }
  }

  /** Stop polling, tear down listeners, and emit `destroyed`. */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.adapter?.stop();
    this.adapter = null;
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
      expectedMinHandSize: this.expectedMinHandSize,
    };
  }

  /** Push a timestamped line to the game log. The next state emission will
   *  include it (adapter's log is the source of truth for the view). */
  addLog(msg: string, source: 'action' | 'response' | 'system' = 'action'): void {
    // Any non-waiting log resets the dedup key so a later waiting state with
    // the same key can re-log once (e.g., we moved past "waiting for opp mask"
    // and later re-enter "waiting for opp deal" — unrelated, both should log).
    this.lastWaitingForKey = null;
    this.adapter?.addLog(msg, source);
  }

  /**
   * Log a "waiting for opponent to X" canvas entry, deduplicated so a polling
   * loop that repeatedly hits the same waiting branch only writes one line.
   * `key` is the dedup identifier (e.g. 'opp-mask'); `message` is the log
   * text. Calling {@link addLog} clears the dedup key so unrelated waiting
   * states later will log again.
   */
  private logWaitingFor(key: string, message: string): void {
    if (this.lastWaitingForKey === key) return;
    this.lastWaitingForKey = key;
    this.adapter?.addLog(message, 'system');
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

  /**
   * Public wrapper around `emitSnapshotRefresh` — called by GameScene
   * after attaching to a session so the HUD / loader / turn indicator
   * render from the current snapshot without waiting for the next real
   * state change (which may not come if nothing on-chain has moved).
   */
  refreshSnapshot(): void {
    this.emitSnapshotRefresh();
  }

  /**
   * Fire a `stateChange` event with the current state and empty `changes`.
   * Used when a *session-local* field (e.g., setupPhase) flips but the
   * on-chain state is unchanged — the adapter's detectChanges would drop
   * such an update, but subscribers (GameScene) need to re-render so
   * their rendering logic sees the new snapshot. No-op if no state yet.
   */
  private emitSnapshotRefresh(): void {
    const state = this.getState();
    if (!state) return;
    this.emit('stateChange', {
      current: state,
      previous: state,
      changes: {
        phaseChanged: false,
        turnChanged: false,
        handChanged: false,
        scoresChanged: false,
        handSizesChanged: false,
        deckCountChanged: false,
        gameLogChanged: false,
        gameOver: false,
      },
      snapshot: this.getSnapshot(),
    });
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
    // current.playerId === 0 is the "wallet not yet in players list"
    // sentinel from MidnightService.getGameState. Common after a wallet
    // switch (collision-resolution) where the joinedLobby tx hasn't landed
    // yet — caching _playerId from a guess would lock us into the wrong
    // identity and submit txs as the wrong player. Skip ALL routing logic
    // (setup / auto-respond / auto-book / cache write) until the wallet
    // is identified.
    if (current.playerId !== 1 && current.playerId !== 2) {
      console.log(
        `[GameSession] handleAdapterChange skipping — playerId unresolved (current.playerId=${current.playerId}). ` +
        `Waiting for wallet to appear in players list.`,
      );
      return;
    }
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
      // Prefer session-resolved displayName (from /lobby_state at start).
      // Fall back to an existing non-raw cache entry, then to raw id.
      // Order matters: session's displayName is the canonical EVM
      // lobby_name, so it should win over whatever was in cache earlier.
      const existing = getCachedGame(this.lobbyId);
      const existingName =
        existing?.lobbyName && existing.lobbyName !== this.lobbyId
          ? existing.lobbyName
          : undefined;
      const sessionName =
        this.displayName && this.displayName !== this.lobbyId
          ? this.displayName
          : undefined;
      const cachedName = sessionName ?? existingName ?? this.lobbyId;
      setCachedGame({
        lobbyId: this.lobbyId,
        playerId: current.playerId as 1 | 2,
        lobbyName: cachedName,
        opponentName: current.opponentName,
        cards: current.myHand,
        myScore: current.scores[myIdx] ?? 0,
        opponentScore: current.scores[oppIdx] ?? 0,
        isMyTurn: current.currentTurn === current.playerId,
        phase: PHASE_STRING_TO_NUMBER[current.phase] ?? 0,
        inFlight: this.computeInFlight(),
        winner: current.winner ?? 0,
        updatedAt: Date.now(),
      });
    }

    // Update the "⏳ Your turn…" / "Waiting for X…" status line in the log.
    // setLog replaces the previous status entry in storage so phase polls
    // don't spam duplicate rows; the view re-renders on the next emission.
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

    // Auto-book: the V4+ contract keeps book-scoring OPTIONAL (fires only
    // when the frontend calls it) to keep gameplay snappy. If it's my turn
    // and I hold 3+ of any rank, submit checkAndScoreBook proactively.
    //
    // Gated on `setupPhase === 'done'` so the deterministic startup order
    // holds: setup (deal) → auto-book sweep → user-action UI. Running
    // during setup would race with dealCards confirmation.
    //
    // Gate on `myHand.length` (not handSizes), since we need a decrypted
    // hand to pick the rank. On rejoin the first poll sometimes emits
    // myHand=[] while the contract query is still in flight — using
    // handSizes here would pass the gate, findBookableRank would return
    // null, and the `previous===null` edge would be wasted. With this gate
    // we retrigger on the next handChanged instead.
    if (this.setupPhase === 'done'
        && atMyTurnStart
        && current.myHand.length >= 3
        && (changes.phaseChanged || changes.handChanged || changes.turnChanged || previous === null)) {
      const bookableRank = this.findBookableRank(current.myHand);
      if (bookableRank !== null) {
        console.log(`[GameSession] Auto-book triggered: rank=${RANK_NAMES[bookableRank]} (hand=${current.myHand.map(c => c.rank).join(',')})`);
        void this.runAutoScoreBook(bookableRank);
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

    // Handle setup phase automation. Only re-enter from 'idle'; mask is
    // already applied by the time GameSession starts, so there's no
    // waiting_for_opponent state to resume from anymore.
    if (this.setupPhase === 'idle' &&
        (current.phase === 'dealing' || current.phase === 'turn_start')) {
      this.runAutomaticSetup();
    }

    if (changes.gameOver) {
      const w = current.winner;
      const winner: 1 | 2 | null = (w === 1 || w === 2) ? w : null;
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
    const isMyTurn = state.currentTurn === state.playerId;

    let statusMsg = '';
    let source: 'status' | 'system' = 'status';
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
      source = 'system';
    }

    if (!statusMsg) return;
    this.adapter.setLog(statusMsg, source);
  }

  // ─────────────────────────────────────────────────────────────────────
  //  Setup phase machine
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Poll for setup status until a condition is met or timeout.
   *
   * For `hasDealt` we also accept `handSizes[me] > 0` as a positive signal.
   * The Midnight contract updates the handSize counter and the `hasDealt`
   * boolean in the same call, but the indexer can expose them on slightly
   * different schedules — without this fallback, a poll that sees the
   * hand but not the flag times out and triggers a redundant dealCards
   * retry (wasting a 30-60s proof cycle).
   */
  private async pollForSetupStatus(
    field: 'hasMaskApplied' | 'hasDealt',
    timeoutMs: number,
  ): Promise<boolean> {
    const startTime = Date.now();
    const pollIntervalMs = 2000;
    const pid = this._playerId as 1 | 2;

    while (Date.now() - startTime < timeoutMs) {
      const status = await MidnightService.getSetupStatus(this.lobbyId, pid);
      if (status[field]) return true;

      if (field === 'hasDealt') {
        // Fallback: if the contract shows my hand is populated, treat deal
        // as confirmed even if the hasDealt flag hasn't surfaced yet.
        try {
          const rawState = await MidnightService.getGameState(
            this.lobbyId,
            this.walletAddress,
          );
          const myHandSize = rawState?.handSizes?.[pid - 1] ?? 0;
          if (myHandSize > 0) {
            console.log(`[GameSession] pollForSetupStatus: hasDealt still false but handSize=${myHandSize} — accepting as confirmed`);
            return true;
          }
        } catch {
          // Transient — keep polling.
        }
      }

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
   * Automatically run the full setup sequence:
   *   1. Apply this player's mask (if not already on-chain).
   *   2. Wait for opponent's mask.
   *   3. Deal cards.
   *   4. startGame (phase: Setup → TurnStart).
   *
   * Owns the entire post-EVM-join setup so the guest can skip LobbyScreen
   * and run setup silently in the background while the user is on the
   * menu. The host's mask is still applied from LobbyScreen (because
   * hostReady needs to fire before the lobby is visibly joinable), but
   * this method tolerates that — `applyMyMaskIfNeeded` short-circuits when
   * the flag is already true on-chain.
   */
  private async runAutomaticSetup(): Promise<void> {
    // Synchronous re-entry guard — set BEFORE any awaits. The setupPhase
    // check is necessary too (covers the post-await transitions) but
    // can't catch concurrent invocations that race past the first await.
    if (this.setupInProgress) return;
    if (this.setupPhase !== 'idle') return;
    this.setupInProgress = true;
    try {
      await this.runAutomaticSetupBody();
    } finally {
      this.setupInProgress = false;
    }
  }

  private async runAutomaticSetupBody(): Promise<void> {
    // Step 1: ensure MY mask is applied. Idempotent via on-chain flag
    // check — for the host this is usually a no-op (LobbyScreen already
    // applied it). For the guest, this is where the mask gets applied
    // post-join.
    try {
      if (!await this.applyMyMaskIfNeeded()) {
        // Mask submit failed; stay idle, next tick retries.
        console.log('[GameSession] applyMyMaskIfNeeded did not complete — staying idle');
        return;
      }
    } catch (err) {
      console.warn('[GameSession] applyMyMaskIfNeeded threw — staying idle', err);
      return;
    }

    // Precondition check for the opponent's mask. Stay idle silently
    // until both masks are on-chain — WS will re-trigger
    // handleAdapterChange when opponent's mask lands.
    let status;
    try {
      status = await MidnightService.getSetupStatus(this.lobbyId, this._playerId as 1 | 2);
    } catch (err) {
      console.warn('[GameSession] Precondition status read failed — staying idle', err);
      return;
    }

    if (!status.hasMaskApplied || !status.opponentHasMaskApplied) {
      console.log(
        `[GameSession] Waiting for masks (mine=${status.hasMaskApplied}, opp=${status.opponentHasMaskApplied}) — staying idle`,
      );
      if (!status.opponentHasMaskApplied) {
        this.logWaitingFor('opp-mask', '⏳ Waiting for opponent to apply their mask…');
      }
      return;
    }

    // Both masks on-chain — proceed with dealing.
    this.setupPhase = 'dealing';
    this.addLog('🎴 Both masks applied — dealing cards', 'system');

    try {
      console.log(`[GameSession] Starting automatic setup... lobbyId=${this.lobbyId}, myPlayerId=${this._playerId}`);
      console.log('[GameSession] Setup status:', status);

      if (!await this.setupDealCards()) return;
      // V4.3: dealCards no longer transitions the phase (that write would
      // conflict with parallel dealers' pre-state reads). We now fire an
      // explicit startGame tx after both hasDealt flags are on-chain; this
      // is the Setup → TurnStart transition that used to live inside
      // dealCards itself.
      if (!await this.setupStartGame()) return;
      // Book scoring no longer runs inside setup. The auto-book path in
      // handleAdapterChange takes over once setupPhase === 'done', so the
      // ordering is deterministic: dealing settles → setup done → auto-book
      // sweeps the hand → UI unlocks for user action.

      console.log('[GameSession] Automatic setup complete!');
      this.setupPhase = 'done';
      // On rejoin of an already-set-up game, the follow-up forcePoll
      // returns a state identical to the initial poll — detectChanges
      // finds no diff, so the adapter silently drops the update. The
      // view then never re-renders with setupPhase='done' and stays
      // showing "Your turn — preparing…" despite the game being ready.
      // Fire an explicit snapshot event so subscribers refresh regardless
      // of whether on-chain state moved.
      this.emitSnapshotRefresh();
      this.adapter?.forcePoll();
      // On rejoin, the first handleAdapterChange already fired (with
      // previous===null) while setupPhase was still 'idle' — so the
      // auto-book block was gated off. Now that setup is done, kick one
      // immediate check against the current state; without this, the user
      // would have to wait for the next unrelated state change to trigger
      // the sweep.
      this.maybeKickAutoBook();
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

  /** Step 2: Deal cards. Returns false if setup should be aborted/retried. */
  /**
   * Step 1: apply my mask if it isn't on-chain yet. Delegates to the same
   * idempotent SetupFlow helper the LobbyScreen uses for the host.
   *
   * Returns true if the mask is confirmed on-chain (submitted now, or was
   * already applied). Returns false on any failure so the caller can retry
   * next tick without marking setup as failed.
   */
  private async applyMyMaskIfNeeded(): Promise<boolean> {
    const pid = this._playerId as 1 | 2;
    // Cheap short-circuit: if the flag is already up on-chain, skip the
    // SetupFlow call entirely (saves one getSetupStatus round-trip).
    try {
      const status = await MidnightService.getSetupStatus(this.lobbyId, pid);
      if (status.hasMaskApplied) {
        this.addLog('🔐 Your mask is already on-chain', 'system');
        return true;
      }
    } catch {
      // If we can't read status, try the apply path — it will re-query.
    }
    this.notify('Setting Up', 'Applying your mask…', 120000);
    this.addLog('🔐 Applying your mask — proving locally…');
    const result = await applyMyMaskFlow(this.lobbyId, pid);
    if (result.success) {
      this.addLog('🔐 Your mask applied');
      return true;
    }
    this.addLog(`⚠️ Mask apply failed: ${result.errorMessage ?? 'unknown error'} — retrying`, 'system');
    console.warn('[GameSession] applyMyMaskIfNeeded failed:', result.errorMessage);
    return false;
  }

  private async setupDealCards(): Promise<boolean> {
    const updatedStatus = await MidnightService.getSetupStatus(this.lobbyId, this._playerId as 1 | 2);
    console.log('[GameSession] Updated setup status:', updatedStatus);

    if (updatedStatus.hasDealt) {
      console.log('[GameSession] Cards already dealt, skipping');
      this.addLog('🎴 Your deal is already on-chain', 'system');
      return true;
    }

    // Defensive: both masks should already be on-chain by the time we reach
    // the game screen (enforced by the lobby-screen flow), but a stale
    // session could sneak through. If so, bail and let the retry loop poll.
    if (!updatedStatus.opponentHasMaskApplied) {
      console.warn('[GameSession] Opponent mask missing at deal step — retrying');
      this.notify('Setting Up', 'Waiting for opponent...', 30000);
      this.logWaitingFor('opp-mask-deal', '⏳ Waiting for opponent\'s mask before dealing…');
      this.scheduleSetupRetry(5000);
      return false;
    }

    // V4.3 (2026-04-20): both browsers can submit dealCards truly in parallel.
    // Previous V4.2 claim that "the deck-top counter serializes the two calls
    // naturally" was incorrect — the counter is a Map-typed ledger field, so
    // reads commit to exact values and the second tx was silently rejected
    // with a proof-check mismatch. The circuit was rewritten to consume fixed
    // disjoint indices (P1→0..3, P2→4..7) without touching the counter.
    // Phase transition is now a separate startGame call — see setupStartGame.
    //
    // Attempt dealCards with inline retry for "mask not yet on-chain" failures.
    // The batcher can take 30-60s to finalize applyMask transactions; we poll
    // until the on-chain state accepts the deal or we give up after 10 minutes.
    const pid = this._playerId as 1 | 2;
    const secretHex = PlayerKeyManager.getPlayerSecret(this.lobbyId, pid).toString(16).padStart(64, '0');
    const seedBytes = PlayerKeyManager.getShuffleSeed(this.lobbyId, pid);
    const seedHex = Array.from(seedBytes).map((b: number) => b.toString(16).padStart(2, '0')).join('');

    const dealDeadlineMs = Date.now() + 10 * 60 * 1000; // 10 minute deadline (batcher retry can take 90s+)
    let lastErr = '';
    let dealAttempted = false;
    while (Date.now() < dealDeadlineMs) {
      this.notify('Setting Up', 'Dealing cards...', 30000);
      if (!dealAttempted) {
        this.addLog('🎴 Dealing cards — this can take up to a minute…');
        dealAttempted = true;
      }
      const dealResult = await MidnightService.dealCards(this.lobbyId, pid, secretHex, seedHex);

      if (dealResult.success) {
        console.log('[GameSession] Cards submitted to batcher, waiting for on-chain confirmation...');
        this.notify('Setting Up', 'Cards submitted — waiting for blockchain confirmation...', 120000);
        this.addLog('🎴 Deal submitted — waiting for blockchain confirmation…', 'system');
        const confirmed = await this.pollForSetupStatus('hasDealt', 120000);
        if (confirmed) {
          console.log('[GameSession] Cards dealt and confirmed on-chain — forcing adapter poll so both browsers sync');
          this.addLog('🎴 Your deal confirmed on-chain');
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
   * V4.3: Step 3 — transition phase from Setup to TurnStart.
   *
   * Parallel-safe dealCards (introduced in V4.3) does NOT flip phase because
   * reading the opponent's hasDealt flag inside dealCards would commit the
   * proof to a stale pre-state and cause one of the two parallel txs to be
   * rejected. Instead we call the dedicated `startGame` circuit here, after
   * both hasDealt flags are visible on-chain. Either player may trigger it;
   * the contract self-dedups via `assert(phase == Setup)`, so both browsers
   * racing the call is fine — whichever lands first wins, the other's
   * "Game already started" response is mapped to success.
   *
   * Exit condition: contract phase is no longer 'dealing' (Setup). That
   * handles both "we submitted startGame" and "the opponent submitted it
   * faster" uniformly.
   */
  private async setupStartGame(): Promise<boolean> {
    const pid = this._playerId as 1 | 2;
    const deadlineMs = Date.now() + 10 * 60 * 1000;

    while (Date.now() < deadlineMs) {
      // Short-circuit if phase already advanced (opponent may have started).
      try {
        const gs = await MidnightService.getGameState(this.lobbyId, this.walletAddress);
        if (gs && gs.phase !== 'dealing') {
          console.log('[GameSession] Phase already advanced — startGame unnecessary');
          this.adapter?.forcePoll();
          return true;
        }
      } catch (err) {
        console.warn('[GameSession] setupStartGame getGameState probe failed', err);
      }

      // Require the opponent's deal to land before attempting startGame;
      // otherwise the "Player X has not dealt" assert is a guaranteed revert
      // that costs a full proof cycle to discover.
      let status;
      try {
        status = await MidnightService.getSetupStatus(this.lobbyId, pid);
      } catch (err) {
        console.warn('[GameSession] setupStartGame getSetupStatus failed', err);
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }

      if (!status.hasDealt || !status.opponentHasDealt) {
        console.log(
          `[GameSession] startGame waiting — my=${status.hasDealt} opp=${status.opponentHasDealt}`,
        );
        this.notify('Setting Up', 'Waiting for opponent to finish dealing...', 30000);
        if (!status.opponentHasDealt) {
          this.logWaitingFor('opp-deal', '⏳ Waiting for opponent to finish dealing…');
        }
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }

      this.notify('Setting Up', 'Starting game...', 30000);
      this.addLog('▶️ Both deals on-chain — starting game…');
      const res = await MidnightService.startGame(this.lobbyId, pid);
      if (!res.success) {
        console.log(`[GameSession] startGame attempt failed: ${res.errorMessage}`);
        this.addLog(`⚠️ Start attempt failed: ${res.errorMessage ?? 'unknown'} — retrying`, 'system');
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }

      console.log('[GameSession] startGame submitted — polling for phase advance');
      this.notify('Setting Up', 'Start submitted — awaiting blockchain confirmation...', 60000);
      this.addLog('▶️ Start submitted — waiting for blockchain confirmation…', 'system');
      if (await this.pollForPhaseAdvance(60000)) {
        console.log('[GameSession] Phase advanced out of Setup — start complete');
        this.addLog('✅ Game started!', 'system');
        this.adapter?.forcePoll();
        return true;
      }
      console.warn('[GameSession] startGame submitted but phase stayed in dealing — retrying');
    }

    console.warn('[GameSession] setupStartGame timed out');
    this.notify('Error', 'Setup stuck at start — retrying', 10000);
    this.scheduleSetupRetry(10000);
    return false;
  }

  /** Poll for the contract phase to advance out of Setup/'dealing'. */
  private async pollForPhaseAdvance(timeoutMs: number): Promise<boolean> {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try {
        const gs = await MidnightService.getGameState(this.lobbyId, this.walletAddress);
        if (gs && gs.phase !== 'dealing') return true;
      } catch { /* transient — keep polling */ }
      await new Promise(r => setTimeout(r, 2000));
    }
    return false;
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
   * Scan the current hand for a rank held 3 (or more) times. Returns the
   * numeric rank index (0–6, where 0=A, 1=2, …, 6=7) of the first bookable
   * rank, or null if none qualifies. The caller is responsible for turn
   * gating — this helper is stateless.
   */
  private findBookableRank(hand: GameSceneState['myHand']): number | null {
    const counts = new Map<string, number>();
    for (const card of hand) {
      counts.set(card.rank, (counts.get(card.rank) ?? 0) + 1);
    }
    for (const [rank, count] of counts) {
      if (count >= 3) {
        const idx = RANK_NAMES.indexOf(rank as typeof RANK_NAMES[number]);
        if (idx >= 0) return idx;
      }
    }
    return null;
  }

  /**
   * Auto-book helper: submit `checkAndScoreBook` for `rankIndex` when it's
   * this player's turn and they hold 3+ of that rank. Best-effort — any
   * failure is logged and swallowed; the next state change will retrigger
   * the same check if the book is still there.
   *
   * The V4+ contract treats book-scoring as optional (no longer auto-fires
   * on turn change), so the frontend drives it proactively whenever the
   * condition is met.
   */
  /**
   * Manually kick the auto-book check against the current adapter state.
   * Used after `runAutomaticSetup` sets `setupPhase='done'` on rejoin —
   * the first `handleAdapterChange` already fired (gated out because setup
   * hadn't finished yet), and the subsequent `forcePoll` sees no state
   * change so it won't refire. This closes the gap.
   */
  private maybeKickAutoBook(): void {
    if (this.scoringBookInProgress) return;
    const state = this.getState();
    if (!state) return;
    const isMyTurn = state.currentTurn === state.playerId;
    if (state.phase !== 'turn_start' || !isMyTurn) return;
    if (state.myHand.length < 3) return;
    const rank = this.findBookableRank(state.myHand);
    if (rank === null) return;
    console.log(`[GameSession] Post-setup auto-book kick: rank=${RANK_NAMES[rank]} (hand=${state.myHand.map(c => c.rank).join(',')})`);
    void this.runAutoScoreBook(rank);
  }

  private async runAutoScoreBook(rankIndex: number): Promise<void> {
    if (this.scoringBookInProgress) return;

    this.scoringBookInProgress = true;
    this.recomputeInFlight();
    // Capture the pre-tx score BEFORE the await. Concurrent adapter polls
    // can otherwise update previousState to the post-book score before
    // pollUntilScoreChanged snapshots its baseline.
    const baselineScores: [number, number] = this.getState()?.scores ?? [0, 0];
    try {
      const rankLabel = RANK_NAMES[rankIndex] ?? String(rankIndex);
      this.addLog(`📚 Auto-scoring book of ${rankLabel}s...`);
      const result = await MidnightService.checkAndScoreBook(
        this.lobbyId,
        this._playerId as 1 | 2,
        rankIndex,
      );
      if (result.success) {
        this.addLog(`✅ Book of ${rankLabel}s scored`);
        // Drive the cache/menu refresh as soon as the tx lands on-chain.
        // Without this, we'd rely on the 30s safety poll (or a WS nudge
        // that isn't guaranteed for score-only changes), and the sidebar
        // would show stale scores for up to half a minute.
        await this.adapter?.pollUntilScoreChanged(baselineScores);
      } else {
        console.warn('[GameSession] runAutoScoreBook: non-success', result.errorMessage);
      }
    } catch (err) {
      console.warn('[GameSession] runAutoScoreBook threw (non-fatal):', err);
    } finally {
      this.scoringBookInProgress = false;
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
    // Capture pre-tx score before the await — see runAutoScoreBook for
    // why: concurrent adapter polls can otherwise race past baseline.
    const baselineScores: [number, number] = this.getState()?.scores ?? [0, 0];
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
        // Same as runAutoScoreBook: drive the cache/menu refresh as soon
        // as the tx lands on-chain, rather than waiting for the 30s poll.
        await this.adapter?.pollUntilScoreChanged(baselineScores);
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
    this.addLog('🏁 Checking for game-over (deck + hand exhaustion)', 'system');
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
      this.addLog('🔍 Checking hand — proving...', 'response');
      const result = await MidnightService.respondToAsk(this.lobbyId, this._playerId as 1 | 2);
      if (result.success) {
        if (result.hasCards) {
          this.addLog(`📤 Gave ${result.cardCount} card(s) to opponent`, 'response');
          this.notify('Responding...', `Transferring ${result.cardCount} card(s) — waiting for chain...`, 30000);
        } else {
          this.addLog('🎣 Go Fish — opponent draws from deck', 'response');
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

      this.addLog('🎣 Resolving draw — proving...', 'response');
      const result = await MidnightService.afterGoFish(
        this.lobbyId,
        this._playerId as 1 | 2,
      );
      if (!result.success) {
        this.notify('Error', result.errorMessage ?? 'afterGoFish failed', 5000);
        return;
      }
      this.addLog('🎣 Draw resolved — submitted', 'response');

      const handBefore = this.getState()?.myHand ?? [];

      // Wait for the chain to advance out of WaitForDrawCheck.
      // If the adapter already shows turn_start (batcher was fast), skip
      // the polling loop — otherwise pollUntilPhase never sees
      // wait_draw_check, everSawCurrent stays false, and we time out.
      this.notify('Drawing...', 'Waiting for chain confirmation...', 30000);
      await this.adapter?.forcePoll();
      const alreadyAdvanced = this.getState()?.phase === 'turn_start';
      const stateAfterDraw = alreadyAdvanced
        ? this.getState()
        : await this.adapter?.pollUntilPhase(
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

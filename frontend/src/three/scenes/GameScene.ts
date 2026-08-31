import * as THREE from 'three';
import gsap from 'gsap';
import type { Card } from '../../../../packages/shared/data-types/src/go-fish-types';
import type { ThreeApp } from '../ThreeApp';
import type { GameSceneState } from '../state/GameStateAdapter';
import { AnimationQueue } from '../state/AnimationQueue';
import { GameHUD } from '../ui/GameHUD';
import { animateDealHand, animateDrawFromDeck } from '../animations/CardAnimations';
import { soundManager } from '../SoundManager';
import { globalLoader } from '../ui/GlobalLoader';
import { turnIndicator } from '../ui/TurnIndicator';
import { GameSession } from '../../game/GameSession';
import { GameSessionManager } from '../../game/GameSessionManager';
import type {
  StateChangeDetail,
  NotificationDetail,
  WaitingBannerDetail,
  SoundDetail,
  DrewCardDetail,
  EndedDetail,
} from '../../game/types';

const RANK_NAMES = ['A', '2', '3', '4', '5', '6', '7'] as const;

/**
 * View layer for a Go Fish game. Owns Three.js object updates, HUD overlay,
 * animations, input wiring, and the global loader + turn indicator drives.
 *
 * Logic (polling, setup, actions) lives in {@link GameSession}. For Phase 1
 * of the multi-game refactor, GameScene still constructs its own session in
 * `start()` — later phases will route the session through a manager so it
 * can outlive the scene's attach/detach lifecycle.
 */
export class GameScene {
  private app: ThreeApp;
  private animationQueue: AnimationQueue;
  private hud: GameHUD;

  private session: GameSession | null = null;
  private sessionUnsubs: Array<() => void> = [];

  /** True when the scene is mounted — HUD visible, input wired, idle
   *  animation stopped. Independent of whether a session is attached. */
  private mounted = false;

  // Ask-flow UI state — lives in the view because it's tied to the
  // opponent-select input mode, not the on-chain game state.
  private pendingAskRank: string | null = null;
  private pendingAskRankIndex: number = -1;

  // First-hand animation guard — prevents replaying the deal on rejoin.
  private initialDealPlayed = false;

  // Tracks the last-observed "phase === dealing" state so we start/stop the
  // deck shuffle animation on the transition edge only. null = not yet known.
  private lastWasSetup: boolean | null = null;

  /** Resolved winner from the contract (0 = draw, 1 = P1, 2 = P2). Set once
   *  isGameOver flips to true and MidnightService.getWinner resolves.
   *  Undefined while loading or not yet game-over. */
  private resolvedWinner: 0 | 1 | 2 | undefined = undefined;
  /** Guard so the winner read fires at most once per game-over transition. */

  constructor(app: ThreeApp) {
    this.app = app;
    this.animationQueue = new AnimationQueue();
    this.hud = new GameHUD();
  }

  /**
   * Public entry point used by SceneManager. Resolves the session via
   * {@link GameSessionManager}, then attaches. Idempotent — calling with
   * the same lobbyId is a no-op. Calling with a different lobbyId while
   * mounted swaps the session without tearing the scene down.
   */
  start(lobbyId: string, walletAddress: string): void {
    const session = GameSessionManager.instance.getOrCreate(lobbyId, walletAddress);
    this.attach(session);
  }

  /** Public exit point — detach from session and unmount the scene. The
   *  session itself keeps running in {@link GameSessionManager} until
   *  destroyed explicitly. */
  stop(): void {
    this.detach();
    this.unmount();
  }

  /**
   * Attach (or swap to) a session. Called from {@link start} and — once the
   * sidebar wiring lands in Phase 4 — directly when the user picks a
   * different game from the Active Games list.
   */
  attach(session: GameSession): void {
    if (this.session === session && this.mounted) return;
    if (this.session && this.session !== session) {
      // Swap case: clear listeners + visuals for the old session, but do
      // NOT stop it — it stays alive in the manager.
      this.unsubscribeFromSession();
      this.clearSceneVisuals();
      this.session = null;
    }
    this.mount();
    this.session = session;
    this.subscribeToSession(session);

    // Best-effort immediate hydrate from the session's current snapshot so
    // the 3D scene paints the right hand/deck before the next poll returns.
    this.hydrateFromSession(session);

    // Force a stateChange emission from the current snapshot so the HUD /
    // loader / turn indicator render immediately. Without this, if the
    // next poll returns an unchanged state (common when swapping to a
    // stable background session), `detectChanges` finds no diff and
    // silently drops the update — leaving the loader and turn indicator
    // blank. The invariant we want: while on a game, one of Proving /
    // Awaiting TX / Waiting for Player / Your Turn is ALWAYS showing.
    session.refreshSnapshot();

    // Force a poll so we get a fresh stateChange shortly. Background
    // sessions keep polling on their own timer, but the user expects snappy
    // feedback when they switch to one.
    void session.forcePoll();
  }

  /** Detach from the current session. The session keeps running; we just
   *  stop listening and clear the visuals. Call this before mounting a
   *  different session, or before full unmount. */
  detach(): void {
    if (!this.session) return;
    this.unsubscribeFromSession();
    this.clearSceneVisuals();
    this.session = null;
  }

  /** Mount the scene: HUD visible, idle animation off, input wired. Cheap
   *  to call repeatedly — guarded by `mounted`. */
  private mount(): void {
    if (this.mounted) return;
    this.mounted = true;

    this.app.stopIdleAnimation();

    this.pendingAskRank = null;
    this.pendingAskRankIndex = -1;
    this.initialDealPlayed = false;

    // Reset scene to a clean pre-setup state. The idle/demo animation leaves
    // random cards in the player hand and a drifting deck count; without
    // this reset, a freshly-created game shows a phantom hand until the
    // first real state arrives.
    this.app.setPlayerHand([]);
    this.app.setOpponentCardCount(0);
    this.app.setDeckCount(21);

    // Kick off the shuffle animation immediately. Setup can run for 30–90s
    // before any on-chain state arrives (host's applyMask → wait for P2 →
    // dealCards), so we cannot wait for `state.phase === 'dealing'` — the
    // contract state stays null for the host's entire pre-join window.
    // onStateChange / hydrateFromSession will stop the shuffle once setup
    // reports done.
    this.lastWasSetup = true;
    this.app.startDeckShuffle();

    this.hud.show();
    this.hud.hideWaitingBanner();

    this.wireInput();
    this.wireHudCallbacks();
  }

  /** Inverse of {@link mount}: hide HUD, restart idle animation, unwire
   *  input. Leaves no session references behind. */
  private unmount(): void {
    if (!this.mounted) return;
    this.mounted = false;

    this.app.startIdleAnimation();
    this.hud.hide();
    this.animationQueue.clear();
    this.app.inputManager.onCardClick = null;
    this.app.inputManager.onDeckClick = null;
    this.app.inputManager.onOpponentClick = null;
    this.app.inputManager.onOpponentHoverChange = null;
    this.app.inputManager.onEmptyClickInSelectMode = null;
    this.app.inputManager.setDeckHitTarget(null);
    this.app.inputManager.setOpponentHitTarget(null);
    this.app.inputManager.setOpponentSelectMode(false);
    this.app.setOpponentHighlighted(false);
    turnIndicator.hide();
    globalLoader.hide();
    globalLoader.setBackground(null);
  }

  /** Reset all visual state so the next attach hydrates cleanly. Called on
   *  detach (either via swap or full unmount) — keeps mount-level concerns
   *  (HUD visibility, idle animation) intact. */
  private clearSceneVisuals(): void {
    this.app.setPlayerHand([]);
    this.app.setOpponentCardCount(0);
    this.app.setDeckCount(0);
    this.app.setOpponentName('Opponent');
    this.app.setCardsInteractive(false);
    this.app.setDeckGlowing(false);
    this.app.setOpponentHighlighted(false);
    this.app.inputManager.setOpponentSelectMode(false);
    this.animationQueue.clear();
    this.pendingAskRank = null;
    this.hud.clearActionPanel();
    this.pendingAskRankIndex = -1;
    this.initialDealPlayed = false;
    this.lastWasSetup = null;
    this.resolvedWinner = undefined;
    void this.app.stopDeckShuffle();
    turnIndicator.hide();
    globalLoader.setBackground(null);
    this.hud.hideWaitingBanner();
  }

  /**
   * Push the session's current snapshot into the 3D scene synchronously,
   * without waiting for the next stateChange event. Called on attach so
   * re-entering (or swapping to) an in-progress game paints the correct
   * hand/deck/opponent immediately rather than after the next poll cycle.
   */
  private hydrateFromSession(session: GameSession): void {
    const state = session.getState();
    if (!state) return;

    // If we're attaching to an in-progress game (past the dealing phase
    // with cards in hand), skip the initial deal animation — we already
    // "saw" those cards in a prior attach cycle, or the session was
    // running in the background and the cards arrived there first.
    if (state.phase !== 'dealing' && state.myHand.length > 0) {
      this.initialDealPlayed = true;
    }

    this.app.setPlayerHand(state.myHand);
    const opponentIdx = state.playerId === 1 ? 1 : 0;
    this.app.setOpponentCardCount(state.handSizes[opponentIdx]);
    this.app.setDeckCount(state.deckCount);
    this.app.setOpponentName(state.opponentName);

    // Shuffle is started in mount(). If we're attaching to an already-in-
    // progress game (past Setup), stop it here so we don't flash the
    // shuffle animation before the deal animation fires.
    const setupDone = state.phase !== 'dealing' && state.myHand.length > 0;
    if (setupDone && this.lastWasSetup === true) {
      this.lastWasSetup = false;
      void this.app.stopDeckShuffle();
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  //  Input + HUD wiring
  // ─────────────────────────────────────────────────────────────────────

  private wireInput(): void {
    this.app.inputManager.onCardClick = (card3d) => {
      this.handleCardClick(card3d.card);
    };
    this.app.inputManager.setDeckHitTarget(this.app.getDeckGroup());
    this.app.inputManager.onDeckClick = () => {
      this.handleDeckClick();
    };
    this.app.inputManager.setOpponentHitTarget(this.app.getOpponentGroup());
    this.app.inputManager.onOpponentClick = () => {
      this.handleOpponentClick();
    };
    this.app.inputManager.onOpponentHoverChange = (hovered: boolean) => {
      this.app.setOpponentHighlighted(hovered);
    };
    this.app.inputManager.onEmptyClickInSelectMode = () => {
      this.cancelAskSelection();
    };
  }

  private wireHudCallbacks(): void {
    this.hud.onOpponentSelected = (opponentId: number) => {
      this.confirmAskForCard(opponentId);
    };
    this.hud.onCancelOpponentSelect = () => {
      this.cancelAskSelection();
    };
    this.hud.onRespondClick = () => {
      // Respond is fully automatic in the session — this callback is no
      // longer wired to any visible UI, but kept defined so legacy HUD paths
      // don't blow up.
    };
    this.hud.onGoFishClick = () => {
      // afterGoFish is auto-triggered by the session on wait_draw_check.
    };
    this.hud.onSkipDrawClick = () => this.session?.skipDraw();
    this.hud.onBackToLobby = () => this.navigateToLobbyList();
    this.hud.onConcedeClick = () => this.handleConcedeClick();
    this.hud.onClaimTimeoutClick = () => this.handleClaimTimeoutClick();
  }

  /** Fire the claimTimeoutWin tx. Only invoked after the HUD confirms the
   *  countdown has crossed `lastMoveAt + 605s` (5s buffer). Same guard
   *  pattern as handleConcedeClick. */
  private async handleClaimTimeoutClick(): Promise<void> {
    if (!this.session) return;
    const snap = this.session.getSnapshot();
    const pid = snap.playerId;
    if (pid !== 1 && pid !== 2) {
      console.warn('[GameScene] claimTimeoutWin blocked — playerId not resolved');
      return;
    }
    const { ensureNotBusy } = await import('../../utils/txGuard');
    if (!ensureNotBusy()) return;
    try {
      const { MidnightService } = await import('../../services/MidnightService');
      const result = await MidnightService.claimTimeoutWin(this.session.lobbyId, pid);
      if (!result.success) {
        console.warn('[GameScene] claimTimeoutWin failed:', result.errorMessage);
        this.hud.showNotification('Claim failed', result.errorMessage ?? 'Try again.', 5000);
        return;
      }
      await this.session.forcePoll();
    } catch (err) {
      console.error('[GameScene] claimTimeoutWin threw:', err);
      const msg = err instanceof Error ? err.message : String(err);
      this.hud.showNotification('Claim failed', msg, 5000);
    }
  }

  /**
   * Fire the concede tx for the current session's player. The session's own
   * inFlight flag + the global loader's 'proving' state ensure no double-
   * submit. Result is observed via the normal game-state poll (phase flips
   * to GameOver, winner field populates).
   */
  private async handleConcedeClick(): Promise<void> {
    if (!this.session) return;
    const snap = this.session.getSnapshot();
    const pid = snap.playerId;
    if (pid !== 1 && pid !== 2) {
      console.warn('[GameScene] concede blocked — playerId not resolved');
      return;
    }
    // Tx-in-flight guard (shared PR B7 pattern) — swallow the click with a
    // toast if another proof/send is already running on this session.
    const { ensureNotBusy } = await import('../../utils/txGuard');
    if (!ensureNotBusy()) return;
    try {
      const { MidnightService } = await import('../../services/MidnightService');
      const result = await MidnightService.concede(this.session.lobbyId, pid);
      if (!result.success) {
        console.warn('[GameScene] concede failed:', result.errorMessage);
        this.hud.showNotification('Concede failed', result.errorMessage ?? 'Try again.', 5000);
        return;
      }
      // Force a poll so the UI flips to the GameOver state without waiting
      // for the next tick.
      await this.session.forcePoll();
    } catch (err) {
      console.error('[GameScene] concede threw:', err);
      const msg = err instanceof Error ? err.message : String(err);
      this.hud.showNotification('Concede failed', msg, 5000);
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  //  Session subscription
  // ─────────────────────────────────────────────────────────────────────

  private subscribeToSession(session: GameSession): void {
    const on = <K extends keyof GameSessionEventListeners>(
      name: K,
      handler: GameSessionEventListeners[K],
    ): void => {
      const listener = (ev: Event) => handler((ev as CustomEvent).detail);
      session.addEventListener(name, listener);
      this.sessionUnsubs.push(() => session.removeEventListener(name, listener));
    };

    on('stateChange', (d) => this.onStateChange(d));
    on('notification', (d) => this.onNotification(d));
    on('waitingBanner', (d) => this.onWaitingBanner(d));
    on('sound', (d) => this.onSound(d));
    on('drewCard', (d) => this.onDrewCard(d));
    on('ended', (d) => this.onEnded(d));
  }

  private unsubscribeFromSession(): void {
    for (const fn of this.sessionUnsubs) fn();
    this.sessionUnsubs = [];
  }

  // ─────────────────────────────────────────────────────────────────────
  //  Session event handlers
  // ─────────────────────────────────────────────────────────────────────

  private onStateChange(detail: StateChangeDetail): void {
    const { current: state, previous, changes, snapshot } = detail;

    // Deck shuffle animation — started in mount(); stopped here once setup
    // reports done or we detect we're attaching to an already-in-progress
    // game. Using `setupPhase === 'done'` (session-local) rather than the
    // contract phase because the contract `phase` field only flips to
    // non-dealing AFTER startGame lands, while `setupPhase` covers the full
    // mask → deal → startGame arc.
    const setupDone =
      snapshot.setupPhase === 'done' ||
      (state.phase !== 'dealing' && state.myHand.length > 0) ||
      state.isGameOver;
    const shouldShuffle = !setupDone;
    if (shouldShuffle !== this.lastWasSetup) {
      this.lastWasSetup = shouldShuffle;
      if (shouldShuffle) {
        this.app.startDeckShuffle();
      } else {
        void this.app.stopDeckShuffle();
      }
    }

    // Update 3D objects
    if (changes.handChanged) {
      // Animate any cards that LEFT the hand (taken by opponent, or flown
      // to a book pile) before swapping in the new hand. Running this
      // before setPlayerHand lets the detached Card3D instances survive
      // the clear() via scene.attach, and setPlayerHand's re-layout still
      // fills the gap immediately so remaining cards don't freeze mid-fan.
      if (previous) {
        const lost = previous.myHand.filter(
          c => !state.myHand.some(n => n.rank === c.rank && n.suit === c.suit),
        );
        if (lost.length > 0) {
          this.app.animateCardLoss(lost);
        }
      }
      this.app.setPlayerHand(state.myHand);

      // Play deal animation on first hand load — but only when we actually
      // saw the game transition out of 'dealing'. If we joined with a
      // non-empty hand already past dealing (rejoin case), just show the
      // cards without replaying the animation.
      const isRejoin = previous === null && state.phase !== 'dealing';
      if (!this.initialDealPlayed && state.myHand.length > 0) {
        this.initialDealPlayed = true;
        if (isRejoin) {
          console.log('[GameScene] Rejoining in-progress game — skipping deal animation');
        } else {
          const deckWorldPos = new THREE.Vector3();
          this.app.getDeckGroup().getWorldPosition(deckWorldPos);
          // Convert to player hand group local space
          const handGroup = this.app.getPlayerHandGroup();
          const deckLocalPos = handGroup.worldToLocal(deckWorldPos.clone());

          this.animationQueue.enqueue(async () => {
            const cards = this.app.getPlayerCards();
            // Play deal sound for each card with stagger
            for (let i = 0; i < cards.length; i++) {
              setTimeout(() => soundManager.playCardDeal(), i * 120);
            }
            await animateDealHand(cards, deckLocalPos, 0.12);
          });
        }
      }
    }

    // V3 (2026-04-17): Book scoring is now on-chain. The contract books
    // automatically inside respondToAsk / afterGoFish (plus a one-time
    // scoreInitialBooks call after dealCards). The frontend no longer
    // submits per-rank book tx's from here.

    if (changes.handSizesChanged) {
      const opponentIdx = state.playerId === 1 ? 1 : 0;
      this.app.setOpponentCardCount(state.handSizes[opponentIdx]);
    }

    if (changes.deckCountChanged) {
      this.app.setDeckCount(state.deckCount);
    }

    // Keep the opponent's display name in sync on EVERY state update. The
    // host's first poll can fire before /lobby_state has the joiner's name,
    // so the initial value would be "Opponent" — locking it in forever if
    // we only updated on the first poll.
    if (previous === null || previous.opponentName !== state.opponentName) {
      this.app.setOpponentName(state.opponentName);
    }

    const isMyTurn = state.currentTurn === state.playerId;
    // `inFlight !== null` covers every in-flight flag (ask/respond/draw/
    // requestDraw/opponentDraw/skipTurn/scoringBook). Use the computed
    // summary rather than listing flags individually so new flags added
    // later stay in sync with the UI gate.
    const localActionRunning = snapshot.inFlight !== null;
    // Setup (dealing + initial book sweep) must be complete before we
    // unlock any card-selection UI — the new auto-book path runs AFTER
    // setupPhase flips to 'done', and the user should only see "Select a
    // Card" once that sweep settles.
    const setupComplete = snapshot.setupPhase === 'done';
    const inOpponentSelect = this.app.inputManager.opponentSelectMode;

    // "Your turn" indicator — bottom-center golden ♣. Only when it's my turn
    // in turn_start, setup is complete, and no local action is in flight.
    // While the user is mid-selection (opponentSelectMode), handleCardClick
    // owns the message, so we don't overwrite it here.
    if (setupComplete && state.phase === 'turn_start' && isMyTurn
        && !localActionRunning && !state.isGameOver) {
      if (!inOpponentSelect) turnIndicator.show('Select a Card');
    } else {
      turnIndicator.hide();
    }

    // ── Invariant: during an active game, either the golden Turn Indicator
    //    OR the GlobalLoader (proving / sending / waiting) is showing at ALL
    //    times. The only "nothing visible" state is game-over, which has its
    //    own end screen.
    //
    //    Foreground loader (proving/sending) is owned by callDelegated —
    //    wins over whatever we set here. Background "waiting" fills every
    //    other gap.
    const opName = state.opponentName || 'Opponent';

    if (state.isGameOver) {
      // End screen takes over — no loader or prompt.
      globalLoader.hide();
      globalLoader.setBackground(null);
    } else if (setupComplete && state.phase === 'turn_start' && isMyTurn && !localActionRunning && !inOpponentSelect) {
      // This is the ONE state where we don't want the loader — the turn
      // indicator is active and the player should focus on it.
      // Requires setup to be fully done; otherwise the setup-phase waiting
      // message below should stay visible.
      // hide() clears any stale FOREGROUND state left over from the setup
      // phase's callDelegated 'sending' message (which callDelegated itself
      // never clears — the caller is expected to hide it once the tx
      // confirms). Without this, the asker sees "Awaiting confirmation:
      // dealing cards…" on top of the Your Turn indicator after setup.
      globalLoader.hide();
      globalLoader.setBackground(null);
    } else if (localActionRunning) {
      // Local tx in flight. "Awaiting confirmation: X" should ONLY show
      // while the tx is actually pending on-chain — not for the entire
      // multi-step wait (e.g., askForCard's full flow includes the
      // opponent's respond, which is a SEPARATE tx we shouldn't take
      // credit for). As soon as the phase has moved past the action's
      // pre-submit phase, the action's tx has landed → hide foreground,
      // let the phase-based background text (below) describe the new
      // state.
      const myTxLanded =
        (snapshot.askInProgress    && state.phase !== 'turn_start') ||
        (snapshot.drawInProgress   && state.phase !== 'wait_draw_check') ||
        (snapshot.respondInProgress && state.phase !== 'wait_response');
      if (myTxLanded) {
        globalLoader.hide();
        let msg = `Waiting for ${opName}…`;
        switch (state.phase) {
          case 'wait_response':
            msg = isMyTurn
              ? `Waiting for ${opName} to respond…`
              : `${opName} is asking — we'll respond automatically…`;
            break;
          case 'turn_start':
            msg = isMyTurn ? `Your turn — preparing…` : `Waiting for ${opName} to ask…`;
            break;
          case 'wait_transfer':
            msg = isMyTurn
              ? `${opName} is transferring cards…`
              : `Transferring cards to ${opName}…`;
            break;
          case 'wait_draw':
            msg = isMyTurn ? `Drawing from the deck…` : `${opName} is drawing…`;
            break;
          case 'wait_draw_check':
            msg = isMyTurn ? `Resolving your draw…` : `${opName} is drawing…`;
            break;
        }
        globalLoader.setBackground('waiting', msg);
      } else {
        // Tx still pending — let callDelegated's foreground loader drive
        // the "Awaiting confirmation: X" message; clear stale background.
        globalLoader.setBackground(null);
      }
    } else {
      // Everything else is a waiting state. Pick the most descriptive
      // message for the current phase / turn; fall back to a generic
      // "Waiting for opponent" so something is always visible.
      let msg = `Waiting for ${opName}…`;
      switch (state.phase) {
        case 'dealing':
          msg = `Preparing table — waiting for ${opName}…`;
          break;
        case 'turn_start':
          msg = isMyTurn
            ? `Your turn — preparing…`
            : `Waiting for ${opName} to ask…`;
          break;
        case 'wait_response':
          msg = isMyTurn
            ? `Waiting for ${opName} to respond…`
            : `${opName} is asking — we'll respond automatically…`;
          break;
        case 'wait_transfer':
          msg = isMyTurn
            ? `${opName} is transferring cards…`
            : `Transferring cards to ${opName}…`;
          break;
        case 'wait_draw':
          msg = isMyTurn
            ? `Drawing from the deck…`
            : `${opName} is drawing…`;
          break;
        case 'wait_draw_check':
          msg = isMyTurn
            ? `Resolving your draw…`
            : `${opName} is drawing…`;
          break;
      }
      // Same story as the my-turn branch: clear any stale foreground from
      // the setup phase so the fresh 'waiting' background becomes visible.
      // If a local action IS in flight, we wouldn't be in this branch —
      // that case is handled above and preserves the foreground loader.
      globalLoader.hide();
      globalLoader.setBackground('waiting', msg);
    }

    // Set card interactivity: only allow hover animation when player can select a card.
    // Also wait until the hand has caught up with any cards transferred from the opponent
    // (the batcher indexer may lag behind the phase transition by several seconds).
    const handIsReady =
      snapshot.expectedMinHandSize === 0 || state.myHand.length >= snapshot.expectedMinHandSize;
    // Also require the hand to be non-empty: even in turn_start the indexer may not have
    // synced cards to this player yet (dealing phase lag). Don't let the player interact
    // before their cards appear.
    const canSelectCard =
      setupComplete
      && !localActionRunning
      && state.phase === 'turn_start'
      && isMyTurn
      && handIsReady
      && state.myHand.length > 0;
    this.app.setCardsInteractive(canSelectCard);

    // Pulse the deck glow during draw phase when it's our turn and deck has cards
    const shouldGlowDeck = state.phase === 'wait_draw' && isMyTurn && state.deckCount > 0;
    this.app.setDeckGlowing(shouldGlowDeck);

    // Detect book completion (scores changed)
    if (previous && changes.scoresChanged) {
      const myScoreIdx = state.playerId - 1;
      const prevMyScore = previous.scores[myScoreIdx];
      const curMyScore = state.scores[myScoreIdx];
      if (curMyScore > prevMyScore) {
        this.showBookCompletionEffect(state);
      }

      const oppScoreIdx = state.playerId === 1 ? 1 : 0;
      const prevOppScore = previous.scores[oppScoreIdx];
      const curOppScore = state.scores[oppScoreIdx];
      if (curOppScore > prevOppScore) {
        this.hud.showNotification('Opponent Book!', `${state.opponentName} completed a book!`, 5000);
      }
    }

    // Detect losing cards (hand shrank when opponent asked us) — shake camera
    if (previous && changes.handChanged && !isMyTurn &&
        previous.phase === 'wait_response' &&
        state.myHand.length < previous.myHand.length) {
      this.showLostCardsEffect(state, previous);
    }

    // Detect opponent asking for a card (phase changed to wait_response and it's not our turn)
    if (changes.phaseChanged && state.phase === 'wait_response' && !isMyTurn) {
      this.showOpponentAskNotification(state);
    }

    // Clear the waiting banner once we're no longer in wait_response (opponent responded)
    if (changes.phaseChanged && previous?.phase === 'wait_response' && isMyTurn) {
      this.hud.hideWaitingBanner();
    }

    // Detect gaining cards from opponent (hand grew while we were asking)
    if (previous && changes.handChanged && isMyTurn &&
        previous.phase === 'wait_response' &&
        state.myHand.length > previous.myHand.length) {
      this.showGainedCardsNotification(state, previous);
    }

    if (state.isGameOver) {
      this.resolvedWinner = state.winner;
    } else {
      this.resolvedWinner = undefined;
    }

    // Update HUD
    this.hud.update({
      phase: state.phase,
      isMyTurn,
      playerName: state.playerName,
      opponentName: state.opponentName,
      // Resolved lobby name (e.g. "Alice's Lobby") — rendered in the turn
      // bar's left slot so users with multiple active games can tell at a
      // glance which game is on screen. Falls back to undefined while the
      // session's displayName is still resolving.
      lobbyName: this.session?.name,
      playerId: state.playerId === 1 || state.playerId === 2 ? state.playerId : undefined,
      myScore: state.scores[state.playerId - 1],
      opponentScore: state.scores[state.playerId === 1 ? 1 : 0],
      myHandSize: state.handSizes[state.playerId - 1],
      opponentHandSize: state.handSizes[state.playerId === 1 ? 1 : 0],
      deckCount: state.deckCount,
      myBooks: state.myBooks,
      opponentBooks: state.opponentBooks,
      gameLog: state.gameLog,
      isGameOver: state.isGameOver,
      winner: this.resolvedWinner,
      lastMoveAt: state.lastMoveAt,
      // 600s matches the contract's TURN_TIMEOUT. Hard-coding here keeps
      // the HUD one query lighter per poll tick — the value only changes
      // when the contract is re-deployed.
      turnTimeoutSecs: 600,
      respondInProgress: snapshot.respondInProgress,
      askInProgress: snapshot.askInProgress,
    });
  }

  private onNotification(d: NotificationDetail): void {
    this.hud.showNotification(d.title, d.message, d.durationMs);
  }

  private onWaitingBanner(d: WaitingBannerDetail): void {
    if (d.message === null) this.hud.hideWaitingBanner();
    else this.hud.showWaitingBanner(d.message);
  }

  private onSound(d: SoundDetail): void {
    soundManager.play(d.name);
  }

  private onDrewCard(d: DrewCardDetail): void {
    const newCard = d.card;
    this.hud.showNotification('Drew Card', `${newCard.rank} of ${newCard.suit}`, 5000);

    // Animate the drawn card from deck to hand
    this.animationQueue.enqueue(async () => {
      const deckWorldPos = new THREE.Vector3();
      this.app.getDeckGroup().getWorldPosition(deckWorldPos);
      const handGroup = this.app.getPlayerHandGroup();
      const deckLocalPos = handGroup.worldToLocal(deckWorldPos.clone());

      const cards = this.app.getPlayerCards();
      const drawnCard3D = cards.find(
        c3d => c3d.card.rank === newCard.rank && c3d.card.suit === newCard.suit,
      );
      if (drawnCard3D) {
        await animateDrawFromDeck(drawnCard3D, deckLocalPos, drawnCard3D.mesh.position.clone());
      }
    });
  }

  private onEnded(d: EndedDetail): void {
    const state = d.snapshot.state;
    if (!state) return;
    const won = d.winner === state.playerId;
    const draw = d.winner === null;
    this.hud.showNotification(
      won ? 'You Won!' : draw ? 'Draw!' : 'Game Over',
      won ? 'Congratulations!' : draw ? 'It\'s a tie.' : 'Better luck next time.',
      10000,
    );
  }

  // ─────────────────────────────────────────────────────────────────────
  //  Visual effects (view-local)
  // ─────────────────────────────────────────────────────────────────────

  private showOpponentAskNotification(state: GameSceneState): void {
    // Parse the latest game log entry to find what rank was asked for
    const latestLog = state.gameLog.length > 0 ? state.gameLog[state.gameLog.length - 1].message : '';
    // Log entries typically look like: "Player1 asked Player2 for 3s"
    const askMatch = latestLog.match(/asked.*for\s+(\w+)s?/i);
    const rankAsked = askMatch ? askMatch[1] : 'a card';

    soundManager.playNotification();
    this.hud.showNotification(
      `${state.opponentName} is Asking!`,
      `They want to know if you have any ${rankAsked}s`,
      6000,
    );
  }

  private showGainedCardsNotification(state: GameSceneState, previous: GameSceneState): void {
    // Find cards that are new
    const newCards = state.myHand.filter(
      c => !previous.myHand.some(p => p.rank === c.rank && p.suit === c.suit),
    );

    if (newCards.length === 0) return;

    soundManager.playCardsGained();
    const cardDescs = newCards.map(c => `${c.rank} of ${c.suit}`).join(', ');
    this.hud.showNotification(
      'Cards Gained!',
      `You received ${newCards.length} card${newCards.length > 1 ? 's' : ''} from ${state.opponentName}: ${cardDescs}`,
      6000,
    );

    // Animate new cards flying from opponent area to hand
    this.animationQueue.enqueue(async () => {
      const opponentWorldPos = new THREE.Vector3();
      this.app.getOpponentGroup().getWorldPosition(opponentWorldPos);
      const handGroup = this.app.getPlayerHandGroup();
      const fromLocal = handGroup.worldToLocal(opponentWorldPos.clone());

      const cards = this.app.getPlayerCards();
      // Find the Card3D objects matching the new cards
      const newCard3Ds = cards.filter(c3d =>
        newCards.some(nc => nc.rank === c3d.card.rank && nc.suit === c3d.card.suit)
      );

      const promises = newCard3Ds.map((card3d, i) => {
        const targetPos = card3d.mesh.position.clone();
        card3d.mesh.position.copy(fromLocal);
        return new Promise<void>(resolve => {
          const delay = i * 0.1;
          gsap.to(card3d.mesh.position, {
            x: targetPos.x,
            y: targetPos.y + 0.5,
            z: targetPos.z,
            duration: 0.4,
            delay,
            ease: 'power2.out',
            onComplete: () => {
              gsap.to(card3d.mesh.position, {
                y: targetPos.y,
                duration: 0.2,
                ease: 'bounce.out',
                onComplete: resolve,
              });
            },
          });
        });
      });
      await Promise.all(promises);
    });
  }

  private showLostCardsEffect(state: GameSceneState, previous: GameSceneState): void {
    // Find which cards were taken
    const lostCards = previous.myHand.filter(
      c => !state.myHand.some(p => p.rank === c.rank && p.suit === c.suit),
    );

    if (lostCards.length === 0) return;

    soundManager.playCardsTaken();

    // Camera shake — intensity scales with number of cards lost
    const intensity = Math.min(0.1 + lostCards.length * 0.05, 0.3);
    this.app.shakeCamera(intensity, 0.5);

    const cardDescs = lostCards.map(c => `${c.rank} of ${c.suit}`).join(', ');
    this.hud.showNotification(
      'Cards Taken!',
      `${state.opponentName} took ${lostCards.length} card${lostCards.length > 1 ? 's' : ''}: ${cardDescs}`,
      6000,
    );

    // The visual "card leaving" animation is handled upstream in onStateChange
    // via app.animateCardLoss() — this function covers the AUDIO + camera
    // shake + notification layer.
  }

  private showBookCompletionEffect(state: GameSceneState): void {
    // Flash notification
    const newBook = state.myBooks.length > 0 ? state.myBooks[state.myBooks.length - 1] : 'a rank';
    this.hud.showNotification('Book Complete!', `You completed a book of ${newBook}s!`, 6000);

    soundManager.playBookComplete();

    // Spawn celebratory particles in the scene
    this.animationQueue.enqueue(async () => {
      this.app.spawnCelebrationParticles();
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  //  Input handlers (view-local ask flow)
  // ─────────────────────────────────────────────────────────────────────

  private handleCardClick(card: Card): void {
    if (!this.session) return;
    const snapshot = this.session.getSnapshot();
    if (snapshot.askInProgress) return;
    const state = snapshot.state;
    if (!state) return;

    // Only allow clicks during turn_start when it's our turn
    if (state.phase !== 'turn_start' || state.currentTurn !== state.playerId) return;

    const rankIndex = RANK_NAMES.indexOf(card.rank as typeof RANK_NAMES[number]);
    if (rankIndex === -1) return;

    soundManager.playCardFlip();

    // Store the pending ask and enter opponent-selection mode
    this.pendingAskRank = card.rank;
    this.pendingAskRankIndex = rankIndex;

    // Enter opponent-select mode — player must click an opponent
    this.app.inputManager.setOpponentSelectMode(true);
    // Repurpose the turn indicator as the "ask target" prompt rather than
    // popping a second HUD modal. Clicking the opponent confirms; clicking
    // empty space cancels (wired via onEmptyClickInSelectMode).
    turnIndicator.show(`Click ${state.opponentName} to ask for ${card.rank}s`);
  }

  /** Clear any pending ask selection and return to normal turn prompt. */
  private cancelAskSelection(): void {
    if (this.pendingAskRankIndex === -1 && !this.app.inputManager.opponentSelectMode) return;
    this.pendingAskRank = null;
    this.pendingAskRankIndex = -1;
    this.app.inputManager.setOpponentSelectMode(false);
    this.app.setOpponentHighlighted(false);
    // Back to the default "select a card" prompt (still our turn)
    turnIndicator.show('Select a Card');
  }

  /** Called after opponent is clicked to confirm the ask. */
  private confirmAskForCard(_opponentId: number): void {
    if (this.pendingAskRankIndex === -1) return;
    const rankIndex = this.pendingAskRankIndex;

    // Exit opponent-select mode
    this.app.inputManager.setOpponentSelectMode(false);
    this.app.setOpponentHighlighted(false);
    turnIndicator.hide();

    // Disable card hover immediately — the batcher call can take 30+ seconds and
    // the state polling won't reflect wait_response until after it lands on-chain.
    this.app.setCardsInteractive(false);

    this.pendingAskRank = null;
    this.pendingAskRankIndex = -1;

    this.session?.askForCard(rankIndex);
  }

  /** Click on the deck to draw a card during wait_draw phase. No-op: the
   *  session auto-triggers afterGoFish when phase flips to wait_draw_check.
   *  Kept so clicking the deck still feels responsive (provides click sfx). */
  private handleDeckClick(): void {
    // Intentional no-op: drawing is fully automatic via the session.
  }

  /** Click on the opponent area — used for opponent selection during ask flow. */
  private handleOpponentClick(): void {
    if (!this.session) return;
    const state = this.session.getState();
    if (!state) return;

    // If we have a pending ask and need to select opponent, confirm it
    if (this.pendingAskRank && this.pendingAskRankIndex !== -1) {
      const opponentId = state.playerId === 1 ? 2 : 1;
      this.confirmAskForCard(opponentId);
    }
  }

  private navigateToLobbyList(): void {
    document.body.dispatchEvent(new CustomEvent('leave-game', { bubbles: false }));
    document.body.dispatchEvent(
      new CustomEvent('navigate', {
        detail: { screen: 'lobby-list' },
        bubbles: false,
      }),
    );
  }

  dispose(): void {
    this.stop();
    this.hud.dispose();
  }
}

/**
 * Typed event-handler map for session events — keeps the subscribe helper
 * type-safe without reaching into the CustomEvent detail shapes.
 */
interface GameSessionEventListeners {
  stateChange: (d: StateChangeDetail) => void;
  notification: (d: NotificationDetail) => void;
  waitingBanner: (d: WaitingBannerDetail) => void;
  sound: (d: SoundDetail) => void;
  drewCard: (d: DrewCardDetail) => void;
  ended: (d: EndedDetail) => void;
}

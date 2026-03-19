import * as THREE from 'three';
import gsap from 'gsap';
import type { Card } from '../../../../shared/data-types/src/go-fish-types';
import type { ThreeApp } from '../ThreeApp';
import { GameStateAdapter, type GameSceneState, type StateChanges } from '../state/GameStateAdapter';
import { AnimationQueue } from '../state/AnimationQueue';
import { GameHUD } from '../ui/GameHUD';
import { MidnightService } from '../../services/MidnightService';
import { PlayerKeyManager } from '../../services/PlayerKeyManager';
import { registerSecret as batcherRegisterSecret } from '../../services/BatcherMidnightService';
import { isBatcherModeEnabled } from '../../proving/batcher-providers';
import { animateDealHand, animateDrawFromDeck } from '../animations/CardAnimations';
import { soundManager } from '../SoundManager';

const RANK_NAMES = ['A', '2', '3', '4', '5', '6', '7'] as const;

/**
 * Explicit state machine for the setup phase.
 * Replaces the 6 separate boolean flags that were previously spread across the class.
 *
 * Transitions:
 *   idle → applying_mask → waiting_for_opponent → dealing → syncing → done
 *   Any state → failed (on error, triggering a retry)
 */
type SetupPhase =
  | 'idle'
  | 'applying_mask'
  | 'waiting_for_opponent'
  | 'dealing'
  | 'syncing'
  | 'done'
  | 'failed';

/**
 * Orchestrates the full game scene: reads game state from MidnightService,
 * updates 3D objects (cards, deck, opponent), and manages the HTML HUD overlay.
 */
export class GameScene {
  private app: ThreeApp;
  private adapter: GameStateAdapter | null = null;
  private animationQueue: AnimationQueue;
  private hud: GameHUD;
  private lobbyId: string = '';
  private walletAddress: string = '';
  private playerId: number = 0;

  // Setup phase — single explicit state machine replaces 6 boolean flags
  private setupPhase: SetupPhase = 'idle';

  // Card ask flow: selected rank waiting for opponent selection
  private pendingAskRank: string | null = null;
  private pendingAskRankIndex: number = -1;

  // Animation state
  private initialDealPlayed = false;
  private drawInProgress = false;
  private askInProgress = false;
  private respondInProgress = false;

  /**
   * When the asking player receives cards from the opponent, the on-chain indexer
   * may lag — the phase flips to turn_start before queryHandFromBatcher reflects
   * the transferred cards. This tracks the minimum hand size we expect before
   * re-enabling card selection. Set in performAskForCard when cardCount > 0.
   */
  private expectedMinHandSize: number = 0;

  constructor(app: ThreeApp) {
    this.app = app;
    this.animationQueue = new AnimationQueue();
    this.hud = new GameHUD();
  }

  /** Start the game scene for a given lobby. */
  start(lobbyId: string, walletAddress: string): void {
    this.lobbyId = lobbyId;
    this.walletAddress = walletAddress;
    this.setupPhase = 'idle';
    this.pendingAskRank = null;
    this.pendingAskRankIndex = -1;
    this.initialDealPlayed = false;
    this.drawInProgress = false;
    this.askInProgress = false;
    this.respondInProgress = false;
    this.expectedMinHandSize = 0;

    this.hud.show();
    this.hud.hideWaitingBanner();

    // Wire up card click handler
    this.app.inputManager.onCardClick = (card3d) => {
      this.handleCardClick(card3d.card);
    };

    // Wire up deck click handler
    this.app.inputManager.setDeckHitTarget(this.app.getDeckGroup());
    this.app.inputManager.onDeckClick = () => {
      this.handleDeckClick();
    };

    // Wire up opponent click/hover handler (for opponent selection)
    this.app.inputManager.setOpponentHitTarget(this.app.getOpponentGroup());
    this.app.inputManager.onOpponentClick = () => {
      this.handleOpponentClick();
    };
    this.app.inputManager.onOpponentHoverChange = (hovered: boolean) => {
      this.app.setOpponentHighlighted(hovered);
    };

    // Wire HUD opponent selection callback
    this.hud.onOpponentSelected = (opponentId: number) => {
      this.confirmAskForCard(opponentId);
    };
    this.hud.onCancelOpponentSelect = () => {
      this.pendingAskRank = null;
      this.pendingAskRankIndex = -1;
      this.app.inputManager.setOpponentSelectMode(false);
      this.app.setOpponentHighlighted(false);
      this.hud.hideOpponentSelectPrompt();
    };

    // Start polling
    this.adapter = new GameStateAdapter(lobbyId, walletAddress, (current, prev, changes) => {
      this.onGameStateChange(current, prev, changes);
    });
    this.adapter.start();
  }

  stop(): void {
    this.adapter?.stop();
    this.adapter = null;
    this.hud.hide();
    this.animationQueue.clear();
    this.app.inputManager.onCardClick = null;
    this.app.inputManager.onDeckClick = null;
    this.app.inputManager.onOpponentClick = null;
    this.app.inputManager.onOpponentHoverChange = null;
    this.app.inputManager.setDeckHitTarget(null);
    this.app.inputManager.setOpponentHitTarget(null);
    this.app.inputManager.setOpponentSelectMode(false);
    this.app.setOpponentHighlighted(false);
  }

  private onGameStateChange(
    state: GameSceneState,
    _previous: GameSceneState | null,
    changes: StateChanges,
  ): void {
    this.playerId = state.playerId;

    // Update 3D objects
    if (changes.handChanged) {
      this.app.setPlayerHand(state.myHand);

      // Play deal animation on first hand load
      if (!this.initialDealPlayed && state.myHand.length > 0) {
        this.initialDealPlayed = true;
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

    if (changes.handSizesChanged) {
      const opponentIdx = state.playerId === 1 ? 1 : 0;
      this.app.setOpponentCardCount(state.handSizes[opponentIdx]);
    }

    if (changes.deckCountChanged) {
      this.app.setDeckCount(state.deckCount);
    }

    // On first state update: register secret with backend and set opponent name.
    if (_previous === null) {
      // Push this player's secret to the backend so fetchSecretFromBackend always
      // has a valid secret for the opponent's proof, even after a node restart.
      if (isBatcherModeEnabled() && state.playerId) {
        batcherRegisterSecret(this.lobbyId, state.playerId as 1 | 2).catch(() => {
          console.warn('[GameScene] registerSecret fire-and-forget failed — non-critical');
        });
      }

      this.app.setOpponentName(state.opponentName);
    }

    const isMyTurn = state.currentTurn === state.playerId;

    // Set card interactivity: only allow hover animation when player can select a card.
    // Also wait until the hand has caught up with any cards transferred from the opponent
    // (the batcher indexer may lag behind the phase transition by several seconds).
    const handIsReady = this.expectedMinHandSize === 0 || state.myHand.length >= this.expectedMinHandSize;
    if (handIsReady && this.expectedMinHandSize > 0) {
      // Hand has caught up — clear the guard so future turns aren't blocked.
      this.expectedMinHandSize = 0;
    }
    // Also require the hand to be non-empty: even in turn_start the indexer may not have
    // synced cards to this player yet (dealing phase lag). Don't let the player interact
    // before their cards appear.
    const canSelectCard = state.phase === 'turn_start' && isMyTurn && handIsReady && state.myHand.length > 0;
    this.app.setCardsInteractive(canSelectCard);

    // Pulse the deck glow during draw phase when it's our turn and deck has cards
    const shouldGlowDeck = state.phase === 'wait_draw' && isMyTurn && state.deckCount > 0;
    this.app.setDeckGlowing(shouldGlowDeck);

    // Detect book completion (scores changed)
    if (_previous && changes.scoresChanged) {
      const myScoreIdx = state.playerId - 1;
      const prevMyScore = _previous.scores[myScoreIdx];
      const curMyScore = state.scores[myScoreIdx];
      if (curMyScore > prevMyScore) {
        this.showBookCompletionEffect(state);
      }

      const oppScoreIdx = state.playerId === 1 ? 1 : 0;
      const prevOppScore = _previous.scores[oppScoreIdx];
      const curOppScore = state.scores[oppScoreIdx];
      if (curOppScore > prevOppScore) {
        this.hud.showNotification('Opponent Book!', `${state.opponentName} completed a book!`, 5000);
      }
    }

    // Detect losing cards (hand shrank when opponent asked us) — shake camera
    if (_previous && changes.handChanged && !isMyTurn &&
        _previous.phase === 'wait_response' &&
        state.myHand.length < _previous.myHand.length) {
      this.showLostCardsEffect(state, _previous);
    }

    // Detect opponent asking for a card (phase changed to wait_response and it's not our turn)
    if (changes.phaseChanged && state.phase === 'wait_response' && !isMyTurn) {
      this.showOpponentAskNotification(state, _previous);
    }

    // Clear the waiting banner once we're no longer in wait_response (opponent responded)
    if (changes.phaseChanged && _previous?.phase === 'wait_response' && isMyTurn) {
      this.hud.hideWaitingBanner();
    }

    // Detect gaining cards from opponent (hand grew while we were asking)
    if (_previous && changes.handChanged && isMyTurn &&
        _previous.phase === 'wait_response' &&
        state.myHand.length > _previous.myHand.length) {
      this.showGainedCardsNotification(state, _previous);
    }

    // Update HUD
    this.hud.update({
      phase: state.phase,
      isMyTurn: state.currentTurn === state.playerId,
      playerName: state.playerName,
      opponentName: state.opponentName,
      myScore: state.scores[state.playerId - 1],
      opponentScore: state.scores[state.playerId === 1 ? 1 : 0],
      myHandSize: state.handSizes[state.playerId - 1],
      opponentHandSize: state.handSizes[state.playerId === 1 ? 1 : 0],
      deckCount: state.deckCount,
      myBooks: state.myBooks,
      gameLog: state.gameLog,
      isGameOver: state.isGameOver,
      respondInProgress: this.respondInProgress,
      askInProgress: this.askInProgress,
    });

    // Wire action buttons
    this.hud.onRespondClick = () => this.handleRespondToAsk();
    this.hud.onGoFishClick = () => this.handleGoFish();
    this.hud.onSkipDrawClick = () => this.handleSkipDraw();
    this.hud.onBackToLobby = () => this.navigateToLobbyList();

    // Handle setup phase automation
    // Only run when idle — 'failed' retries are scheduled explicitly by runAutomaticSetup
    if (this.setupPhase === 'idle' && (state.phase === 'dealing' || state.phase === 'turn_start')) {
      this.runAutomaticSetup();
    }

    // Handle game over
    if (changes.gameOver) {
      const won = state.scores[state.playerId - 1] > state.scores[state.playerId === 1 ? 1 : 0];
      this.hud.showNotification(won ? 'You Won!' : 'Game Over', won ? 'Congratulations!' : 'Better luck next time.', 10000);
    }
  }

  // --- Notifications for opponent actions ---

  private showOpponentAskNotification(state: GameSceneState, _previous: GameSceneState | null): void {
    // Parse the latest game log entry to find what rank was asked for
    const latestLog = state.gameLog.length > 0 ? state.gameLog[state.gameLog.length - 1] : '';
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

    // Note: The cards are already removed from the hand by setPlayerHand, so we
    // can't animate the removed Card3D objects. The camera shake + notification
    // provides the feedback. A future enhancement could create temporary card meshes
    // that fly to the opponent before the hand update.
  }

  // --- Book Completion Effect ---

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

  // --- Setup Phase ---

  /**
   * Poll for setup status until a condition is met or timeout
   */
  private async pollForSetupStatus(
    field: 'hasMaskApplied' | 'hasDealt',
    timeoutMs: number,
  ): Promise<boolean> {
    const startTime = Date.now();
    const pollIntervalMs = 3000;

    while (Date.now() - startTime < timeoutMs) {
      const status = await MidnightService.getSetupStatus(
        this.lobbyId,
        this.playerId as 1 | 2,
      );
      if (status[field]) return true;
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }
    return false;
  }

  /**
   * Schedule a setup retry after a delay.
   * Directly re-runs setup rather than relying on poll → onChange (which won't
   * fire if game state hasn't changed between polls).
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
   * Automatically run the setup sequence (applyMask + dealCards).
   * Orchestrates two focused steps: setupMask() and setupDealCards().
   */
  private async runAutomaticSetup(): Promise<void> {
    if (this.setupPhase !== 'idle') return;
    this.setupPhase = 'applying_mask';

    try {
      console.log(`[GameScene] Starting automatic setup... lobbyId=${this.lobbyId}, myPlayerId=${this.playerId}`);

      const status = await MidnightService.getSetupStatus(this.lobbyId, this.playerId as 1 | 2);
      console.log('[GameScene] Setup status:', status);

      if (!await this.setupMask(status)) return;
      if (!await this.setupDealCards()) return;

      console.log('[GameScene] Automatic setup complete!');
      this.setupPhase = 'done';
      this.hud.showNotification('Setup Complete', 'Waiting for game to start...', 5000);
      this.adapter?.forcePoll();
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('[GameScene] Automatic setup failed:', msg);
      this.hud.showNotification('Error', 'Setup failed. Retrying...', 10000);
      this.scheduleSetupRetry(10000);
    }
  }

  /** Step 1: Apply mask. Returns false if setup should be aborted/retried. */
  private async setupMask(status: { hasMaskApplied: boolean }): Promise<boolean> {
    if (status.hasMaskApplied) {
      console.log('[GameScene] Mask already applied, skipping');
      this.setupPhase = 'waiting_for_opponent';
      return true;
    }

    this.hud.showNotification('Setting Up', 'Applying cryptographic mask...', 30000);
    const pid = this.playerId as 1 | 2;
    const secretHex = PlayerKeyManager.getPlayerSecret(this.lobbyId, pid).toString(16).padStart(64, '0');
    const maskResult = await MidnightService.applyMask(this.lobbyId, pid, secretHex);

    if (maskResult.success) {
      console.log('[GameScene] Mask applied successfully');
      this.setupPhase = 'waiting_for_opponent';
      return true;
    }

    const err = maskResult.errorMessage ?? '';
    if (err.includes('already applied') || err.includes('Player has already applied')) {
      console.log('[GameScene] Mask already applied (detected via error) - continuing');
      this.setupPhase = 'waiting_for_opponent';
      return true;
    }
    if (err.includes('timed out') || err.includes('NetworkError') || err.includes('fetch') ||
        err.includes('EffectStream processing validation failed') || err.includes('Timeout')) {
      console.log('[GameScene] Mask timed out, polling for on-chain confirmation...');
      const confirmed = await this.pollForSetupStatus('hasMaskApplied', 30000);
      if (confirmed) {
        this.setupPhase = 'waiting_for_opponent';
        return true;
      }
      this.hud.showNotification('Setting Up', 'Retrying mask...', 10000);
      this.scheduleSetupRetry(10000);
      return false;
    }

    console.log(`[GameScene] Mask failed: ${err}, will retry in 5s`);
    this.hud.showNotification('Error', err || 'Mask failed', 5000);
    this.scheduleSetupRetry(5000);
    return false;
  }

  /** Step 2: Deal cards. Returns false if setup should be aborted/retried. */
  private async setupDealCards(): Promise<boolean> {
    const updatedStatus = await MidnightService.getSetupStatus(this.lobbyId, this.playerId as 1 | 2);
    console.log('[GameScene] Updated setup status:', updatedStatus);

    if (updatedStatus.hasDealt) {
      console.log('[GameScene] Cards already dealt, skipping');
      return true;
    }

    // Wait for opponent to apply their mask
    if (!updatedStatus.opponentHasMaskApplied) {
      console.log('[GameScene] Waiting for opponent to apply mask... will retry in 2s');
      this.hud.showNotification('Setting Up', 'Waiting for opponent...', 30000);
      this.scheduleSetupRetry(2000);
      return false;
    }

    // Wait for indexer to sync (only once per setup session)
    if (this.setupPhase === 'waiting_for_opponent') {
      console.log('[GameScene] Opponent mask applied, waiting 8s for indexer to sync...');
      this.hud.showNotification('Setting Up', 'Syncing blockchain state...', 10000);
      await new Promise(resolve => setTimeout(resolve, 8000));
      this.setupPhase = 'dealing';
    }

    const postSyncStatus = await MidnightService.getSetupStatus(this.lobbyId, this.playerId as 1 | 2);
    console.log('[GameScene] Post-sync setup status:', postSyncStatus);

    // Player 2 must wait for Player 1 to deal first
    if (this.playerId === 2 && !postSyncStatus.opponentHasDealt) {
      console.log('[GameScene] Player 2 waiting for Player 1 to deal first... will retry in 2s');
      this.hud.showNotification('Setting Up', 'Waiting for Player 1 to deal...', 30000);
      this.setupPhase = 'waiting_for_opponent'; // Allow re-entry to syncing step
      this.scheduleSetupRetry(2000);
      return false;
    }

    this.hud.showNotification('Setting Up', 'Dealing cards...', 30000);
    const pid = this.playerId as 1 | 2;
    const secretHex = PlayerKeyManager.getPlayerSecret(this.lobbyId, pid).toString(16).padStart(64, '0');
    const seedBytes = PlayerKeyManager.getShuffleSeed(this.lobbyId, pid);
    const seedHex = Array.from(seedBytes).map((b: number) => b.toString(16).padStart(2, '0')).join('');
    const dealResult = await MidnightService.dealCards(this.lobbyId, pid, secretHex, seedHex);

    if (dealResult.success) {
      console.log('[GameScene] Cards dealt successfully');
      return true;
    }

    const err = dealResult.errorMessage ?? '';
    if (err.includes('already dealt') || err.includes('has already dealt')) {
      console.log('[GameScene] Cards already dealt (detected via error) - continuing');
      return true;
    }
    if (err.includes('must apply mask')) {
      this.scheduleSetupRetry(3000);
      return false;
    }
    if (err.includes('timed out') || err.includes('NetworkError') || err.includes('fetch') ||
        err.includes('EffectStream processing validation failed') || err.includes('Timeout')) {
      const confirmed = await this.pollForSetupStatus('hasDealt', 30000);
      if (confirmed) {
        console.log('[GameScene] Cards were dealt despite timeout');
        return true;
      }
      this.hud.showNotification('Setting Up', 'Retrying deal...', 10000);
      this.scheduleSetupRetry(10000);
      return false;
    }
    if (err.includes('unreachable')) {
      this.hud.showNotification('Setting Up', 'Waiting for blockchain sync...', 10000);
      this.scheduleSetupRetry(10000);
      return false;
    }

    console.log(`[GameScene] Deal failed: ${err}, will retry in 5s`);
    this.hud.showNotification('Error', err || 'Deal failed', 5000);
    this.scheduleSetupRetry(5000);
    return false;
  }

  // --- Action Handlers ---

  private handleCardClick(card: Card): void {
    if (this.askInProgress) return;
    const state = this.adapter?.currentState;
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
    this.hud.showOpponentSelectPrompt(card.rank, state.opponentName);
  }

  /** Called after opponent is clicked to confirm the ask. */
  private confirmAskForCard(opponentId: number): void {
    if (this.pendingAskRankIndex === -1) return;

    // Exit opponent-select mode
    this.app.inputManager.setOpponentSelectMode(false);
    this.app.setOpponentHighlighted(false);
    this.hud.hideOpponentSelectPrompt();

    // Show persistent waiting banner immediately — stays until the batcher confirms
    const rankLabel = this.pendingAskRank ?? '';
    this.hud.showWaitingBanner(`Asking for ${rankLabel}s — waiting for opponent's response...`);

    this.performAskForCard(this.pendingAskRankIndex);

    this.pendingAskRank = null;
    this.pendingAskRankIndex = -1;
  }

  /** Click on the deck to draw a card during wait_draw phase. */
  private handleDeckClick(): void {
    if (this.drawInProgress) return;
    const state = this.adapter?.currentState;
    if (!state) return;

    if (state.phase === 'wait_draw' && state.currentTurn === state.playerId && state.deckCount > 0) {
      this.handleGoFish();
    }
  }

  /** Click on the opponent area — used for opponent selection during ask flow. */
  private handleOpponentClick(): void {
    const state = this.adapter?.currentState;
    if (!state) return;

    // If we have a pending ask and need to select opponent, confirm it
    if (this.pendingAskRank && this.pendingAskRankIndex !== -1) {
      const opponentId = state.playerId === 1 ? 2 : 1;
      this.confirmAskForCard(opponentId);
    }
  }

  private async performAskForCard(rankIndex: number): Promise<void> {
    if (this.askInProgress) return;
    this.askInProgress = true;
    // Disable card hover immediately — the batcher call can take 30+ seconds and
    // the state polling won't reflect wait_response until after it lands on-chain.
    this.app.setCardsInteractive(false);
    try {
      const handBefore = this.adapter?.currentState?.myHand.length ?? 0;
      const result = await MidnightService.askForCard(this.lobbyId, this.playerId as 1 | 2, rankIndex);
      if (result.success) {
        // Wait for the opponent to respond (phase leaves wait_response).
        // This tells us whether a transfer happened (wait_transfer) or go fish (wait_draw).
        const stateAfterResponse = await this.adapter?.pollUntilPhase(
          'wait_response',
          ['wait_transfer', 'wait_draw'],
        );

        if (stateAfterResponse?.phase === 'wait_transfer') {
          // Opponent has cards — a transfer circuit is running.
          // The batcher indexer will lag behind the phase transition to turn_start,
          // so guard card selection until the hand grows by at least 1.
          this.expectedMinHandSize = handBefore + 1;
          console.log(`[GameScene] askForCard: transfer in progress, expecting hand ≥ ${this.expectedMinHandSize}`);
        }

        // Clear the waiting banner — opponent has responded
        this.hud.hideWaitingBanner();
        this.adapter?.forcePoll();
      } else {
        this.hud.hideWaitingBanner();
        this.hud.showNotification('Error', result.errorMessage ?? 'Ask failed', 5000);
        // Re-enable cards so the player can try again
        this.app.setCardsInteractive(true);
      }
    } catch (err) {
      console.error('[GameScene] askForCard error:', err);
      this.hud.hideWaitingBanner();
      this.hud.showNotification('Error', 'Failed to ask for card', 5000);
      // Re-enable cards so the player can try again
      this.app.setCardsInteractive(true);
    } finally {
      this.askInProgress = false;
    }
  }

  private async handleRespondToAsk(): Promise<void> {
    if (this.respondInProgress) return;
    this.respondInProgress = true;
    try {
      this.hud.showNotification('Responding...', 'Checking hand...', 5000);
      const result = await MidnightService.respondToAsk(this.lobbyId, this.playerId as 1 | 2);
      if (result.success) {
        if (result.hasCards) {
          this.hud.showNotification('Responding...', `Transferring ${result.cardCount} card(s) — waiting for chain...`, 30000);
        } else {
          this.hud.showNotification('Responding...', 'Go Fish! — waiting for chain...', 30000);
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
          this.hud.showNotification('Cards Given', `You gave ${result.cardCount} card(s)`, 5000);
        } else {
          this.hud.showNotification('Go Fish!', 'You don\'t have that card', 5000);
        }
        await this.adapter?.forcePoll();
      } else {
        this.hud.showNotification('Error', result.errorMessage ?? 'Response failed', 5000);
      }
    } catch (err) {
      console.error('[GameScene] respondToAsk error:', err);
      this.hud.showNotification('Error', 'Failed to respond', 5000);
    } finally {
      this.respondInProgress = false;
    }
  }

  private async handleGoFish(): Promise<void> {
    this.drawInProgress = true;
    this.app.setDeckGlowing(false);
    try {
      this.hud.showNotification('Drawing...', 'Go Fish! Drawing from deck...', 5000);
      soundManager.playGoFish();

      // Capture state before the draw so we can detect the new card afterward.
      // Also capture the asked rank — needed to determine drewRequestedCard once
      // the chain confirms.
      const handBefore = this.adapter?.currentState?.myHand ?? [];
      const lastAskedRank = this.adapter?.currentState?.lastAskedRank ?? null;

      const result = await MidnightService.goFish(this.lobbyId, this.playerId as 1 | 2);
      if (!result.success) {
        this.hud.showNotification('Error', result.errorMessage ?? 'Go Fish failed', 5000);
        return;
      }

      // Wait for the chain to advance to wait_draw_check, which confirms the
      // goFish circuit has been executed and the drawn card is now on-chain.
      // Only then is the player's updated hand available via the batcher query.
      this.hud.showNotification('Drawing...', 'Waiting for chain confirmation...', 30000);
      const stateAfterDraw = await this.adapter?.pollUntilPhase(
        'wait_draw',
        ['wait_draw_check'],
      );

      const handAfter = stateAfterDraw?.myHand ?? this.adapter?.currentState?.myHand ?? [];

      // Find the newly drawn card by comparing the hand before and after.
      const newCard = handAfter.find(
        c => !handBefore.some(b => b.rank === c.rank && b.suit === c.suit),
      );

      // Determine whether the drawn card matches the rank that was asked for.
      // lastAskedRank is the numeric rank index from on-chain state (0–6).
      // Card.rank is a string like 'A','2','3',...,'7'; RANK_NAMES maps index→string.
      let drewRequestedCard = false;
      if (newCard && lastAskedRank !== null) {
        const askedRankName = RANK_NAMES[lastAskedRank];
        drewRequestedCard = newCard.rank === askedRankName;
        console.log(`[GameScene] goFish: drew ${newCard.rank}, asked for ${askedRankName} → drewRequestedCard=${drewRequestedCard}`);
      }

      await MidnightService.afterGoFish(
        this.lobbyId,
        this.playerId as 1 | 2,
        drewRequestedCard,
      );

      if (newCard) {
        const turnMsg = drewRequestedCard ? ' — another turn!' : '';
        this.hud.showNotification('Drew Card', `${newCard.rank} of ${newCard.suit}${turnMsg}`, 5000);

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

      // Final poll to sync UI with the post-afterGoFish chain state.
      await this.adapter?.forcePoll();
    } catch (err) {
      console.error('[GameScene] goFish error:', err);
      this.hud.showNotification('Error', 'Failed to draw', 5000);
    } finally {
      this.drawInProgress = false;
    }
  }

  private async handleSkipDraw(): Promise<void> {
    try {
      const result = await MidnightService.skipDrawDeckEmpty(this.lobbyId, this.playerId as 1 | 2);
      if (result.success) {
        this.hud.showNotification('Turn Ended', 'Deck is empty', 5000);
        this.adapter?.forcePoll();
      } else {
        this.hud.showNotification('Error', result.errorMessage ?? 'Skip failed', 5000);
      }
    } catch (err) {
      console.error('[GameScene] skipDraw error:', err);
      this.hud.showNotification('Error', 'Failed to skip draw', 5000);
    }
  }

  private navigateToLobbyList(): void {
    // Restore the app-container first so UIManager can process the event
    const appContainer = document.getElementById('app-container');
    if (appContainer) {
      appContainer.style.display = '';
    }

    // Dispatch on the app-container so UIManager's listener catches it
    if (appContainer) {
      appContainer.dispatchEvent(
        new CustomEvent('navigate', {
          detail: { screen: 'lobby-list' },
          bubbles: true,
        }),
      );
    }
  }

  dispose(): void {
    this.stop();
    this.hud.dispose();
  }
}

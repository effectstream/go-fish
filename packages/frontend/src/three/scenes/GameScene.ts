import * as THREE from 'three';
import gsap from 'gsap';
import type { Card } from '../../../../shared/data-types/src/go-fish-types';
import type { ThreeApp } from '../ThreeApp';
import { GameStateAdapter, type GameSceneState, type StateChanges } from '../state/GameStateAdapter';
import { AnimationQueue } from '../state/AnimationQueue';
import { GameHUD } from '../ui/GameHUD';
import { MidnightService } from '../../services/MidnightService';
import { PlayerKeyManager } from '../../services/PlayerKeyManager';
import { animateDealHand, animateDrawFromDeck } from '../animations/CardAnimations';
import { soundManager } from '../SoundManager';

const RANK_NAMES = ['A', '2', '3', '4', '5', '6', '7'] as const;

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

  // Setup phase state
  private maskApplied = false;
  private cardsDealt = false;
  private setupInProgress = false;
  private setupCompleted = false;
  private setupAttempted = false;
  private indexerSyncWaited = false;

  // Card ask flow: selected rank waiting for opponent selection
  private pendingAskRank: string | null = null;
  private pendingAskRankIndex: number = -1;

  // Animation state
  private initialDealPlayed = false;
  private drawInProgress = false;
  private askInProgress = false;

  constructor(app: ThreeApp) {
    this.app = app;
    this.animationQueue = new AnimationQueue();
    this.hud = new GameHUD();
  }

  /** Start the game scene for a given lobby. */
  start(lobbyId: string, walletAddress: string): void {
    this.lobbyId = lobbyId;
    this.walletAddress = walletAddress;
    this.maskApplied = false;
    this.cardsDealt = false;
    this.setupInProgress = false;
    this.setupCompleted = false;
    this.setupAttempted = false;
    this.indexerSyncWaited = false;
    this.pendingAskRank = null;
    this.pendingAskRankIndex = -1;
    this.initialDealPlayed = false;
    this.drawInProgress = false;
    this.askInProgress = false;

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

    // Update opponent name on first load
    if (_previous === null) {
      this.app.setOpponentName(state.opponentName);
    }

    const isMyTurn = state.currentTurn === state.playerId;

    // Set card interactivity: only allow hover animation when player can select a card
    const canSelectCard = state.phase === 'turn_start' && isMyTurn;
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
    });

    // Wire action buttons
    this.hud.onRespondClick = () => this.handleRespondToAsk();
    this.hud.onGoFishClick = () => this.handleGoFish();
    this.hud.onSkipDrawClick = () => this.handleSkipDraw();
    this.hud.onBackToLobby = () => this.navigateToLobbyList();

    // Handle setup phase automation
    // Trigger setup during 'dealing' phase, or if we haven't dealt yet even if phase advanced
    // (P1 may have dealt first, transitioning the phase, but P2 still needs to deal)
    const needsSetup = !this.setupCompleted && !this.setupInProgress && !this.setupAttempted;
    const inDealingPhase = state.phase === 'dealing';
    const stillNeedToDeal = !this.cardsDealt && !this.setupCompleted;

    if (needsSetup && (inDealingPhase || stillNeedToDeal)) {
      this.setupAttempted = true;
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
    setTimeout(() => {
      if (this.setupCompleted || this.setupInProgress) return;
      this.runAutomaticSetup();
    }, delayMs);
  }

  /**
   * Automatically run the setup sequence (applyMask + dealCards).
   * Mirrors the robust logic from GameScreen — checks status, waits for opponent,
   * enforces dealing order (Player 1 first), handles timeouts and retries.
   */
  private async runAutomaticSetup(): Promise<void> {
    this.setupInProgress = true;

    try {
      console.log(`[GameScene] Starting automatic setup... lobbyId=${this.lobbyId}, myPlayerId=${this.playerId}`);

      // Check current setup status from backend
      const status = await MidnightService.getSetupStatus(
        this.lobbyId,
        this.playerId as 1 | 2,
      );
      console.log('[GameScene] Setup status:', status);

      // Step 1: Apply mask (only if not already applied)
      if (!this.maskApplied && !status.hasMaskApplied) {
        this.hud.showNotification('Setting Up', 'Applying cryptographic mask...', 30000);
        console.log('[GameScene] Applying mask...');

        const pid = this.playerId as 1 | 2;
        const secret = PlayerKeyManager.getPlayerSecret(this.lobbyId, pid);
        const secretHex = secret.toString(16).padStart(64, '0');

        const maskResult = await MidnightService.applyMask(this.lobbyId, pid, secretHex);

        if (!maskResult.success) {
          const maskErr = maskResult.errorMessage ?? '';
          const maskAlreadyDone = maskErr.includes('already applied') ||
                                  maskErr.includes('Player has already applied');
          // EffectStream timeout means the tx landed on-chain but the batcher's
          // post-confirmation event never fired — treat as success by polling.
          const maskTimedOut = maskErr.includes('timed out') ||
                               maskErr.includes('NetworkError') ||
                               maskErr.includes('fetch') ||
                               maskErr.includes('EffectStream processing validation failed') ||
                               maskErr.includes('Timeout');

          if (maskAlreadyDone) {
            console.log('[GameScene] Mask already applied (detected via error) - continuing');
            this.maskApplied = true;
          } else if (maskTimedOut) {
            console.log('[GameScene] Mask request timed out / EffectStream timeout, polling for on-chain status...');
            const confirmed = await this.pollForSetupStatus('hasMaskApplied', 30000);
            if (confirmed) {
              console.log('[GameScene] Mask was applied despite timeout');
              this.maskApplied = true;
            } else {
              console.log('[GameScene] Mask not confirmed after polling, will retry in 10s');
              this.hud.showNotification('Setting Up', 'Retrying mask...', 10000);
              this.scheduleSetupRetry(10000);
              return;
            }
          } else {
            console.log(`[GameScene] Mask failed: ${maskErr}, will retry in 5s`);
            this.hud.showNotification('Error', maskErr || 'Mask failed', 5000);
            this.scheduleSetupRetry(5000);
            return;
          }
        } else {
          console.log('[GameScene] Mask applied successfully (confirmed on-chain)');
          this.maskApplied = true;
        }
      } else {
        console.log('[GameScene] Mask already applied, skipping');
        this.maskApplied = true;
      }

      // Step 2: Deal cards (requires both masks applied, Player 1 deals first)
      console.log(`[GameScene] Step 2 check: cardsDealt=${this.cardsDealt}, status.hasDealt=${status.hasDealt}`);
      if (!this.cardsDealt && !status.hasDealt) {
        // Re-fetch status to get latest opponent info
        const updatedStatus = await MidnightService.getSetupStatus(
          this.lobbyId,
          this.playerId as 1 | 2,
        );
        console.log('[GameScene] Updated setup status:', updatedStatus);

        // Wait for opponent to apply their mask
        if (!updatedStatus.opponentHasMaskApplied) {
          console.log('[GameScene] Waiting for opponent to apply mask... will retry in 2s');
          this.hud.showNotification('Setting Up', 'Waiting for opponent...', 30000);
          this.scheduleSetupRetry(2000);
          return;
        }

        // Wait for indexer to sync (only once)
        if (!this.indexerSyncWaited) {
          console.log('[GameScene] Opponent mask applied, waiting 8s for indexer to sync...');
          this.hud.showNotification('Setting Up', 'Syncing blockchain state...', 10000);
          await new Promise(resolve => setTimeout(resolve, 8000));
          this.indexerSyncWaited = true;
        }

        // Re-fetch status after potential indexer wait to get latest opponent info
        const postSyncStatus = await MidnightService.getSetupStatus(
          this.lobbyId,
          this.playerId as 1 | 2,
        );
        console.log('[GameScene] Post-sync setup status:', postSyncStatus);

        // Player 2 must wait for Player 1 to deal first
        if (this.playerId === 2 && !postSyncStatus.opponentHasDealt) {
          console.log('[GameScene] Player 2 waiting for Player 1 to deal first... will retry in 2s');
          this.hud.showNotification('Setting Up', 'Waiting for Player 1 to deal...', 30000);
          this.scheduleSetupRetry(2000);
          return;
        }

        this.hud.showNotification('Setting Up', 'Dealing cards...', 30000);
        console.log(`[GameScene] Player ${this.playerId} dealing cards...`);

        const dealPid = this.playerId as 1 | 2;
        const dealSecret = PlayerKeyManager.getPlayerSecret(this.lobbyId, dealPid);
        const dealSecretHex = dealSecret.toString(16).padStart(64, '0');
        const dealSeedBytes = PlayerKeyManager.getShuffleSeed(this.lobbyId, dealPid);
        const dealSeedHex = Array.from(dealSeedBytes).map((b: number) => b.toString(16).padStart(2, '0')).join('');

        const dealResult = await MidnightService.dealCards(this.lobbyId, dealPid, dealSecretHex, dealSeedHex);

        if (!dealResult.success) {
          if (dealResult.errorMessage?.includes('must apply mask')) {
            console.log('[GameScene] A player has not applied mask yet, will retry...');
            this.scheduleSetupRetry(3000);
            return;
          } else if (dealResult.errorMessage?.includes('already dealt') ||
                     dealResult.errorMessage?.includes('has already dealt')) {
            console.log('[GameScene] Cards already dealt (detected via error) - continuing');
            this.cardsDealt = true;
          } else if (dealResult.errorMessage?.includes('timed out') ||
                     dealResult.errorMessage?.includes('NetworkError') ||
                     dealResult.errorMessage?.includes('fetch') ||
                     dealResult.errorMessage?.includes('EffectStream processing validation failed') ||
                     dealResult.errorMessage?.includes('Timeout')) {
            console.log('[GameScene] Deal cards timed out / EffectStream timeout, polling for on-chain status...');
            const confirmed = await this.pollForSetupStatus('hasDealt', 30000);
            if (confirmed) {
              console.log('[GameScene] Cards were dealt despite timeout');
              this.cardsDealt = true;
            } else {
              console.log('[GameScene] Deal not confirmed, will retry in 10s');
              this.hud.showNotification('Setting Up', 'Retrying deal...', 10000);
              this.scheduleSetupRetry(10000);
              return;
            }
          } else if (dealResult.errorMessage?.includes('unreachable')) {
            console.log('[GameScene] Deal hit WASM assert (likely stale indexer state), will retry in 10s...');
            this.hud.showNotification('Setting Up', 'Waiting for blockchain sync...', 10000);
            this.scheduleSetupRetry(10000);
            return;
          } else {
            console.log(`[GameScene] Deal failed: ${dealResult.errorMessage}, will retry in 5s`);
            this.hud.showNotification('Error', dealResult.errorMessage ?? 'Deal failed', 5000);
            this.scheduleSetupRetry(5000);
            return;
          }
        } else {
          console.log('[GameScene] Cards dealt successfully (confirmed on-chain)');
          this.cardsDealt = true;
        }
      } else {
        console.log('[GameScene] Cards already dealt, skipping');
        this.cardsDealt = true;
      }

      console.log('[GameScene] Automatic setup complete!');
      this.setupCompleted = true;
      this.hud.showNotification('Setup Complete', 'Waiting for game to start...', 5000);
      // Force an immediate state poll now that both players have dealt on-chain.
      // The regular 5-second interval would otherwise leave the player waiting
      // up to 5 seconds before the phase transitions and their hand is shown.
      this.adapter?.forcePoll();
    } catch (error: any) {
      console.error('[GameScene] Automatic setup failed:', error);
      this.hud.showNotification('Error', 'Setup failed. Retrying...', 10000);
      this.scheduleSetupRetry(10000);
    } finally {
      this.setupInProgress = false;
    }
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
      const result = await MidnightService.askForCard(this.lobbyId, this.playerId as 1 | 2, rankIndex);
      if (result.success) {
        // Keep the waiting banner visible — it will be cleared once the opponent responds
        // and the phase transitions away from wait_response (handled in onGameStateChange).
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
    try {
      this.hud.showNotification('Responding...', 'Checking hand...', 5000);
      const result = await MidnightService.respondToAsk(this.lobbyId, this.playerId as 1 | 2);
      if (result.success) {
        if (result.hasCards) {
          this.hud.showNotification('Cards Given', `You gave ${result.cardCount} card(s)`, 5000);
        } else {
          this.hud.showNotification('Go Fish!', 'You don\'t have that card', 5000);
        }
        this.adapter?.forcePoll();
      } else {
        this.hud.showNotification('Error', result.errorMessage ?? 'Response failed', 5000);
      }
    } catch (err) {
      console.error('[GameScene] respondToAsk error:', err);
      this.hud.showNotification('Error', 'Failed to respond', 5000);
    }
  }

  private async handleGoFish(): Promise<void> {
    this.drawInProgress = true;
    this.app.setDeckGlowing(false);
    try {
      this.hud.showNotification('Drawing...', 'Go Fish! Drawing from deck...', 5000);
      soundManager.playGoFish();

      // Get hand before drawing
      const handBefore = this.adapter?.currentState?.myHand ?? [];

      const result = await MidnightService.goFish(this.lobbyId, this.playerId as 1 | 2);
      if (!result.success) {
        this.hud.showNotification('Error', result.errorMessage ?? 'Go Fish failed', 5000);
        return;
      }

      // Poll to get updated hand
      await this.adapter?.forcePoll();

      const handAfter = this.adapter?.currentState?.myHand ?? [];

      // Find new card
      const newCard = handAfter.find(
        c => !handBefore.some(b => b.rank === c.rank && b.suit === c.suit)
      );

      // Determine if drawn card matches asked rank
      // (In the real game, this is tracked by contract state)
      const drewRequestedCard = false; // Simplified — the contract determines this

      await MidnightService.afterGoFish(
        this.lobbyId,
        this.playerId as 1 | 2,
        drewRequestedCard,
      );

      if (newCard) {
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

      this.adapter?.forcePoll();
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

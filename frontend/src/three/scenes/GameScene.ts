import * as THREE from 'three';
import gsap from 'gsap';
import type { Card } from '../../../../packages/shared/data-types/src/go-fish-types';
import type { ThreeApp } from '../ThreeApp';
import { GameStateAdapter, type GameSceneState, type StateChanges } from '../state/GameStateAdapter';
import { AnimationQueue } from '../state/AnimationQueue';
import { GameHUD } from '../ui/GameHUD';
import { MidnightService } from '../../services/MidnightService';
import * as GoFishContractService from '../../services/GoFishContractService';
import { PlayerKeyManager } from '../../services/PlayerKeyManager';
import { registerSecret as batcherRegisterSecret } from '../../services/BatcherMidnightService';
import { isBatcherModeEnabled } from '../../proving/batcher-providers';
import { animateDealHand, animateDrawFromDeck } from '../animations/CardAnimations';
import { soundManager } from '../SoundManager';
import { globalLoader } from '../ui/GlobalLoader';
import { turnIndicator } from '../ui/TurnIndicator';

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
  private scoreBookInProgress = false;

  /**
   * When the asking player receives cards from the opponent, the on-chain indexer
   * may lag — the phase flips to turn_start before queryHandFromBatcher reflects
   * the transferred cards. This tracks the minimum hand size we expect before
   * re-enabling card selection. Set in performAskForCard when cardCount > 0.
   */
  private expectedMinHandSize: number = 0;

  /** Direct WS subscription for setup coordination. */
  private unsubscribeSetupWs: (() => void) | null = null;

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
      this.cancelAskSelection();
    };
    // Click empty space while in opponent-select mode → cancel selection
    this.app.inputManager.onEmptyClickInSelectMode = () => {
      this.cancelAskSelection();
    };

    // Start polling
    this.adapter = new GameStateAdapter(lobbyId, walletAddress, (current, prev, changes) => {
      this.onGameStateChange(current, prev, changes);
    });
    this.adapter.start();

    // Direct WS listener for setup coordination. When the opponent's
    // mask or deal lands on-chain, the contract state changes but the
    // game state fields (phase, scores, hands) look identical. This
    // listener ensures runAutomaticSetup fires immediately.
    this.unsubscribeSetupWs = GoFishContractService.onContractStateChange(() => {
      if (this.setupPhase === 'waiting_for_opponent') {
        console.log('[GameScene] WS: contract state changed while waiting_for_opponent → re-running setup');
        this.runAutomaticSetup();
      }
    });
  }

  stop(): void {
    this.adapter?.stop();
    this.adapter = null;
    this.unsubscribeSetupWs?.();
    this.unsubscribeSetupWs = null;
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

  private onGameStateChange(
    state: GameSceneState,
    _previous: GameSceneState | null,
    changes: StateChanges,
  ): void {
    this.playerId = state.playerId;

    // Update 3D objects
    if (changes.handChanged) {
      this.app.setPlayerHand(state.myHand);

      // Play deal animation on first hand load — but only when we actually
      // saw the game transition out of 'dealing'. If we joined with a
      // non-empty hand already past dealing (rejoin case), just show the
      // cards without replaying the animation.
      const isRejoin = _previous === null && state.phase !== 'dealing';
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

    // Hand changed → check for any complete book (3 of a rank) and score it.
    // Skips if we're already scoring, or if the game is over, or the hand
    // can't contain a book (fewer than 3 cards).
    if (changes.handChanged && state.myHand.length >= 3 && !state.isGameOver) {
      this.autoScoreBooks(state).catch(err => {
        console.warn('[GameScene] autoScoreBooks failed:', err);
      });
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

    // Update game log with current turn/wait status (replaces last status line)
    if (changes.phaseChanged || changes.turnChanged) {
      const opName = state.opponentName || 'Opponent';
      const statusPrefix = '⏳';
      const log = this.adapter?.gameLog ?? [];
      const lastIsStatus = log.length > 0 && log[log.length - 1].includes(statusPrefix);

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

      if (statusMsg && this.adapter) {
        if (lastIsStatus) {
          log[log.length - 1] = statusMsg;
        } else {
          this.adapter.addLog(statusMsg.replace(/^\[.*?\] /, ''));
        }
      }
    }

    // "Your turn" indicator — bottom-center golden ♣. Only when it's my turn
    // in turn_start and I don't have a local action running. While the user
    // is mid-selection (opponentSelectMode), handleCardClick owns the message,
    // so we don't overwrite it here.
    const localActionRunningForTurn =
      this.askInProgress || this.respondInProgress || this.drawInProgress || this.scoreBookInProgress;
    const inOpponentSelect = this.app.inputManager.opponentSelectMode;
    if (state.phase === 'turn_start' && isMyTurn && !localActionRunningForTurn && !state.isGameOver) {
      if (!inOpponentSelect) turnIndicator.show('Select a Card');
    } else {
      turnIndicator.hide();
    }

    // Background "waiting for opponent" loader — spades, slow ambient pulse.
    // Shows only when we have no local action running; the proving/sending
    // foreground loader masks it whenever the local player is submitting a tx.
    const localActionRunning = this.askInProgress || this.respondInProgress || this.drawInProgress;
    const opName = state.opponentName || 'Opponent';
    if (!localActionRunning && !state.isGameOver) {
      if (state.phase === 'turn_start' && !isMyTurn) {
        globalLoader.setBackground('waiting', `Waiting for ${opName} to ask…`);
      } else if (state.phase === 'wait_response' && isMyTurn) {
        globalLoader.setBackground('waiting', `Waiting for ${opName} to respond…`);
      } else if (state.phase === 'wait_draw_check' && !isMyTurn) {
        globalLoader.setBackground('waiting', `${opName} is drawing…`);
      } else if (state.phase === 'wait_transfer' && isMyTurn) {
        globalLoader.setBackground('waiting', `${opName} is transferring cards…`);
      } else {
        globalLoader.setBackground(null);
      }
    } else {
      globalLoader.setBackground(null);
    }

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
      // Auto-trigger respond — no user click required. The HUD shows a
      // "responding..." status instead of a button.
      if (!this.respondInProgress) {
        this.handleRespondToAsk();
      }
    }

    // Also auto-trigger when rejoining: first poll (previous===null) shows
    // wait_response and we're not the asker — start responding immediately.
    if (_previous === null && state.phase === 'wait_response' && !isMyTurn && !this.respondInProgress) {
      this.handleRespondToAsk();
    }

    // Auto-resolve the draw. After respondToAsk (no match), the contract
    // internally draws a card and moves to wait_draw_check. The asker must
    // now call afterGoFish to finalize. No user action needed — both
    // browsers observe wait_draw_check but only the asker (currentTurn ===
    // playerId) submits the tx. Guard with drawInProgress to avoid double-
    // submission, and fire on both phase transition AND fresh rejoin.
    const shouldAutoDraw =
      state.phase === 'wait_draw_check' &&
      isMyTurn &&
      !this.drawInProgress;
    if (shouldAutoDraw && (changes.phaseChanged || _previous === null)) {
      this.handleGoFish();
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

    // Handle setup phase automation. With the WS subscription, state
    // changes trigger this callback instantly — no need for 2s polling.
    // Re-run setup when idle (first entry) OR when waiting for opponent
    // (the WS just delivered the opponent's mask/deal landing on-chain).
    if ((this.setupPhase === 'idle' || this.setupPhase === 'waiting_for_opponent') &&
        (state.phase === 'dealing' || state.phase === 'turn_start')) {
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
    const pollIntervalMs = 2000;

    while (Date.now() - startTime < timeoutMs) {
      // queryCircuit always does fresh HTTP — no stale cache to worry about.
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
    // Allow re-entry from 'idle' (first run) and 'waiting_for_opponent'
    // (WS delivered opponent's state change). Block re-entry from
    // 'applying_mask' / 'dealing' / 'syncing' (already in progress).
    if (this.setupPhase !== 'idle' && this.setupPhase !== 'waiting_for_opponent') return;
    this.setupPhase = 'applying_mask';

    try {
      console.log(`[GameScene] Starting automatic setup... lobbyId=${this.lobbyId}, myPlayerId=${this.playerId}`);

      const status = await MidnightService.getSetupStatus(this.lobbyId, this.playerId as 1 | 2);
      console.log('[GameScene] Setup status:', status);

      if (!await this.setupMask(status)) return;
      if (!await this.setupDealCards()) return;

      console.log('[GameScene] Automatic setup complete!');
      this.setupPhase = 'done';
      // Setup WS listener no longer needed — unsubscribe to avoid noise
      this.unsubscribeSetupWs?.();
      this.unsubscribeSetupWs = null;
      this.hud.showNotification('Setup Complete', 'Waiting for game to start...', 5000);
      this.adapter?.forcePoll();
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('[GameScene] Automatic setup failed:', msg);
      this.hud.showNotification('Error', 'Setup failed. Retrying...', 10000);
      this.scheduleSetupRetry(10000);
    } finally {
      globalLoader.hide();
    }
  }

  /** Step 1: Apply mask. Returns false if setup should be aborted/retried.
   *  ORDERING: P1 (lobby creator) applies first, P2 (joiner) waits for P1.
   *  Preserves EVM player order into the Midnight contract. */
  private async setupMask(status: { hasMaskApplied: boolean; opponentHasMaskApplied?: boolean }): Promise<boolean> {
    if (status.hasMaskApplied) {
      console.log('[GameScene] Mask already applied, skipping');
      this.setupPhase = 'waiting_for_opponent';
      return true;
    }

    // P2 must wait for P1's mask before applying their own.
    // No scheduleSetupRetry — the WS subscription will trigger
    // onGameStateChange when P1's mask lands, re-entering setup.
    if (this.playerId === 2 && !status.opponentHasMaskApplied) {
      console.log('[GameScene] Player 2 waiting for Player 1 to apply mask (WS will trigger next attempt)');
      this.hud.showNotification('Setting Up', 'Waiting for opponent to shuffle the deck...', 30000);
      this.setupPhase = 'waiting_for_opponent';
      return false;
    }

    this.hud.showNotification('Setting Up', 'Applying cryptographic mask — proving...', 60000);
    const pid = this.playerId as 1 | 2;
    const secretHex = PlayerKeyManager.getPlayerSecret(this.lobbyId, pid).toString(16).padStart(64, '0');
    const maskResult = await MidnightService.applyMask(this.lobbyId, pid, secretHex);

    if (maskResult.success) {
      console.log('[GameScene] Mask submitted to batcher, waiting for on-chain confirmation...');
      this.hud.showNotification('Setting Up', 'Mask submitted — waiting for blockchain confirmation...', 120000);
      // Poll until the indexer confirms the mask is on-chain.
      // Without this wait, the setup loop retries immediately and
      // double-submits because hasMaskApplied is still false.
      const confirmed = await this.pollForSetupStatus('hasMaskApplied', 120000);
      if (confirmed) {
        console.log('[GameScene] Mask confirmed on-chain — forcing adapter poll so both browsers sync');
        this.adapter?.forcePoll(); // Trigger state refresh for WS listeners
        this.setupPhase = 'waiting_for_opponent';
        return true;
      }
      console.warn('[GameScene] Mask submitted but not confirmed within timeout');
      this.hud.showNotification('Warning', 'Mask may not have landed — retrying...', 10000);
      this.scheduleSetupRetry(5000);
      return false;
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
      console.log('[GameScene] Waiting for opponent to apply mask (WS will trigger next attempt)');
      this.hud.showNotification('Setting Up', 'Waiting for opponent...', 30000);
      this.setupPhase = 'waiting_for_opponent';
      return false;
    }

    // Brief pause for indexer to sync after opponent's mask lands.
    if (this.setupPhase === 'waiting_for_opponent') {
      console.log('[GameScene] Opponent mask applied, brief sync pause...');
      this.hud.showNotification('Setting Up', 'Syncing blockchain state...', 10000);
      await new Promise(resolve => setTimeout(resolve, 2000));
      this.setupPhase = 'dealing';
    }

    const postSyncStatus = await MidnightService.getSetupStatus(this.lobbyId, this.playerId as 1 | 2);
    console.log('[GameScene] Post-sync setup status:', postSyncStatus);

    // Player 2 must wait for Player 1 to deal first (enforced by contract).
    // WS will trigger next attempt when P1's deal lands on-chain.
    if (this.playerId === 2 && !postSyncStatus.opponentHasDealt) {
      console.log('[GameScene] Player 2 waiting for Player 1 to deal (WS will trigger next attempt)');
      this.hud.showNotification('Setting Up', 'Waiting for Player 1 to deal...', 30000);
      this.setupPhase = 'waiting_for_opponent';
      return false;
    }

    // Attempt dealCards with inline retry for "mask not yet on-chain" failures.
    // The batcher can take 30-60s to finalize applyMask transactions; we poll
    // until the on-chain state accepts the deal or we give up after 3 minutes.
    const pid = this.playerId as 1 | 2;
    const secretHex = PlayerKeyManager.getPlayerSecret(this.lobbyId, pid).toString(16).padStart(64, '0');
    const seedBytes = PlayerKeyManager.getShuffleSeed(this.lobbyId, pid);
    const seedHex = Array.from(seedBytes).map((b: number) => b.toString(16).padStart(2, '0')).join('');

    const dealDeadlineMs = Date.now() + 10 * 60 * 1000; // 10 minute deadline (batcher retry can take 90s+)
    let lastErr = '';
    while (Date.now() < dealDeadlineMs) {
      this.hud.showNotification('Setting Up', 'Dealing cards...', 30000);
      const dealResult = await MidnightService.dealCards(this.lobbyId, pid, secretHex, seedHex);

      if (dealResult.success) {
        console.log('[GameScene] Cards submitted to batcher, waiting for on-chain confirmation...');
        this.hud.showNotification('Setting Up', 'Cards submitted — waiting for blockchain confirmation...', 120000);
        const confirmed = await this.pollForSetupStatus('hasDealt', 120000);
        if (confirmed) {
          console.log('[GameScene] Cards dealt and confirmed on-chain — forcing adapter poll so both browsers sync');
          this.adapter?.forcePoll(); // Trigger state refresh for WS listeners
          return true;
        }
        console.warn('[GameScene] dealCards submitted but not confirmed within timeout');
        continue; // retry the while loop
      }

      lastErr = dealResult.errorMessage ?? '';
      console.log(`[GameScene] dealCards attempt failed: ${lastErr}`);

      if (lastErr.includes('already dealt') || lastErr.includes('has already dealt') ||
          lastErr.includes('Both players have already dealt')) {
        console.log('[GameScene] Cards already dealt (detected via error) - continuing');
        return true;
      }
      if (lastErr.includes('timed out') || lastErr.includes('NetworkError') || lastErr.includes('fetch') ||
          lastErr.includes('EffectStream processing validation failed') || lastErr.includes('Timeout')) {
        const confirmed = await this.pollForSetupStatus('hasDealt', 30000);
        if (confirmed) {
          console.log('[GameScene] Cards were dealt despite timeout');
          return true;
        }
        // Network issue — retry in 10s (stays in while loop)
        this.hud.showNotification('Setting Up', 'Retrying deal...', 10000);
        await new Promise(resolve => setTimeout(resolve, 10000));
        continue;
      }
      if (lastErr.includes('must apply mask') || lastErr.includes('apply mask before dealing')) {
        // Masks not yet visible on-chain — wait and retry without resetting phase
        console.log('[GameScene] Masks not yet on-chain, waiting 5s before retry...');
        this.hud.showNotification('Setting Up', 'Waiting for blockchain confirmation...', 10000);
        await new Promise(resolve => setTimeout(resolve, 5000));
        continue;
      }
      if (lastErr.includes('unreachable')) {
        this.hud.showNotification('Setting Up', 'Waiting for blockchain sync...', 10000);
        await new Promise(resolve => setTimeout(resolve, 10000));
        continue;
      }

      // Unknown error — fall back to full retry
      break;
    }

    console.log(`[GameScene] Deal failed: ${lastErr}, will retry full setup in 5s`);
    this.hud.showNotification('Error', lastErr || 'Deal failed', 5000);
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
  private confirmAskForCard(opponentId: number): void {
    if (this.pendingAskRankIndex === -1) return;

    // Exit opponent-select mode
    this.app.inputManager.setOpponentSelectMode(false);
    this.app.setOpponentHighlighted(false);
    turnIndicator.hide();

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
      this.adapter?.addLog(`🃏 Asking for ${RANK_NAMES[rankIndex]}s — proving...`);
      const result = await MidnightService.askForCard(this.lobbyId, this.playerId as 1 | 2, rankIndex);
      if (result.success) {
        this.adapter?.addLog(`🃏 Asked for ${RANK_NAMES[rankIndex]}s — waiting for opponent`);
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
      globalLoader.hide();
    }
  }

  private async handleRespondToAsk(): Promise<void> {
    if (this.respondInProgress) return;
    this.respondInProgress = true;
    try {
      this.hud.showNotification('Responding...', 'Checking hand...', 5000);
      this.adapter?.addLog('🔍 Checking hand — proving...');
      const result = await MidnightService.respondToAsk(this.lobbyId, this.playerId as 1 | 2);
      if (result.success) {
        if (result.hasCards) {
          this.adapter?.addLog(`📤 Gave ${result.cardCount} card(s) to opponent`);
          this.hud.showNotification('Responding...', `Transferring ${result.cardCount} card(s) — waiting for chain...`, 30000);
        } else {
          this.adapter?.addLog('🎣 Go Fish — opponent draws from deck');
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
      globalLoader.hide();
    }
  }

  /**
   * Scan the current hand for any 3-of-a-rank and submit checkAndScoreBook
   * for each. The contract removes the 3 cards and increments the score.
   * At ≥4 books, it sets GameOver.
   *
   * Serialized via scoreBookInProgress — if multiple hand updates arrive
   * quickly (e.g., after respondToAsk transfer + redraw), we only run one
   * scoring pass at a time. The next poll will pick up any remaining books.
   */
  private async autoScoreBooks(state: GameSceneState): Promise<void> {
    if (this.scoreBookInProgress) return;

    // Tally ranks first — bail out entirely if no book exists. Don't flip
    // scoreBookInProgress or touch the loader, otherwise an unrelated
    // in-flight "sending" loader would get hidden by our finally block.
    const rankCounts = new Map<string, number>();
    for (const card of state.myHand) {
      rankCounts.set(card.rank, (rankCounts.get(card.rank) ?? 0) + 1);
    }
    let hasBook = false;
    for (const count of rankCounts.values()) {
      if (count >= 3) { hasBook = true; break; }
    }
    if (!hasBook) return;

    this.scoreBookInProgress = true;
    try {
      for (const [rank, count] of rankCounts) {
        if (count < 3) continue;
        const rankIndex = RANK_NAMES.indexOf(rank as typeof RANK_NAMES[number]);
        if (rankIndex < 0) continue;

        console.log(`[GameScene] autoScoreBooks: ${count}×${rank} — scoring book`);
        this.adapter?.addLog(`📚 Scoring book of ${rank}s — proving...`);
        try {
          const result = await MidnightService.checkAndScoreBook(
            this.lobbyId,
            this.playerId as 1 | 2,
            rankIndex,
          );
          if (result.success) {
            this.adapter?.addLog(`★ Book of ${rank}s scored!`);
            this.hud.showNotification('Book Scored!', `Book of ${rank}s`, 4000);
            soundManager.playBookComplete();
          } else {
            console.warn(`[GameScene] checkAndScoreBook(${rank}) failed: ${result.errorMessage}`);
          }
        } catch (err) {
          // Local hand read may disagree with contract's internal rank
          // counting in edge cases — log and continue.
          console.warn(`[GameScene] checkAndScoreBook(${rank}) threw:`, err);
        }
      }
    } finally {
      this.scoreBookInProgress = false;
      // Safe to hide here — we only got past the early-return if we actually
      // submitted a book, so the loader we're clearing is our own.
      globalLoader.hide();
    }
  }

  private async handleGoFish(): Promise<void> {
    this.drawInProgress = true;
    this.app.setDeckGlowing(false);
    try {
      this.hud.showNotification('Drawing...', 'Go Fish! Resolving draw...', 5000);
      soundManager.playGoFish();

      // respondToAsk already drew the card from the deck and set phase to
      // WaitForDrawCheck. We just need to call afterGoFish — the contract
      // decrypts the drawn card internally and determines whether it
      // matches the asked rank (game.compact:451-510). No goFish() circuit
      // exists; the draw is handled inside respondToAsk.

      const handBefore = this.adapter?.currentState?.myHand ?? [];

      this.adapter?.addLog('🎣 Resolving draw — proving...');
      const result = await MidnightService.afterGoFish(
        this.lobbyId,
        this.playerId as 1 | 2,
      );
      if (!result.success) {
        this.hud.showNotification('Error', result.errorMessage ?? 'afterGoFish failed', 5000);
        return;
      }
      this.adapter?.addLog('🎣 Draw resolved — submitted');

      // Wait for the chain to advance out of WaitForDrawCheck.
      this.hud.showNotification('Drawing...', 'Waiting for chain confirmation...', 30000);
      const stateAfterDraw = await this.adapter?.pollUntilPhase(
        'wait_draw_check',
        ['turn_start'],
      );

      const handAfter = stateAfterDraw?.myHand ?? this.adapter?.currentState?.myHand ?? [];

      // Find the newly drawn card by comparing the hand before and after.
      const newCard = handAfter.find(
        c => !handBefore.some(b => b.rank === c.rank && b.suit === c.suit),
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

      // Final poll to sync UI with the post-afterGoFish chain state.
      await this.adapter?.forcePoll();
    } catch (err) {
      console.error('[GameScene] goFish error:', err);
      this.hud.showNotification('Error', 'Failed to draw', 5000);
    } finally {
      this.drawInProgress = false;
      globalLoader.hide();
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

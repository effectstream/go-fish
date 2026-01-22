/**
 * Game Screen - Go Fish gameplay with card visuals
 */

import { GoFishGameService } from '../services/GoFishGameService';
import { CardComponent } from '../components/Card';
import type { GoFishGameState, GoFishPlayer, Rank, Suit } from '../../../shared/data-types/src/go-fish-types';
import { getUniqueRanks } from '../../../shared/data-types/src/go-fish-types';
import { getWalletAddress } from '../effectstreamBridge';

// Type for API game state response
interface GameStateResponse {
  lobbyId: string;
  playerId: number;
  players: Array<{ accountId: number; name: string; walletAddress: string }>;
  phase: string;
  currentTurn: number;
  scores: [number, number];
  handSizes: [number, number];
  deckCount: number;
  isGameOver: boolean;
  myHand: Array<{ x: bigint; y: bigint }>; // Semi-masked cards
  myBooks: string[];
  gameLog: string[];
}

export class GameScreen {
  private container: HTMLElement;
  private gameService: GoFishGameService;
  private lobbyId: string;
  private refreshInterval?: number;
  private selectedRank: Rank | null = null;
  private selectedTargetId: string | null = null;
  private gameState: GameStateResponse | null = null;
  private previousGameState: GameStateResponse | null = null; // Track previous state for diff
  private walletAddress: string | null = null;
  private myDecryptedHand: Array<{ rank: number; suit: number }> = [];
  private previousHand: Array<{ rank: number; suit: number }> = []; // Track previous hand for diff
  private setupInProgress: boolean = false;
  private setupCompleted: boolean = false;
  private maskApplied: boolean = false;  // Track if we've applied mask (frontend-side cache)
  private cardsDealt: boolean = false;   // Track if we've dealt cards (frontend-side cache)
  private isHidden: boolean = false;     // Track if screen has been hidden to prevent stale renders
  private errorCount: number = 0;        // Track consecutive errors before navigating away
  private hasRenderedOnce: boolean = false; // Track if initial render has happened
  private showActionModal: boolean = false; // Track if action modal is visible
  private static readonly MAX_ERRORS = 3; // Navigate away after this many consecutive errors

  // Notification modal state
  private notificationModal: {
    type: 'draw' | 'gained' | 'lost' | 'book';
    card?: { rank: string; suit: string };
    cards?: Array<{ rank: string; suit: string }>;
    playerName?: string;
    bookRank?: string;
  } | null = null;

  // Track previous scores for book completion detection
  private previousScores: [number, number] | null = null;

  constructor(container: HTMLElement, lobbyId: string) {
    this.container = container;
    this.lobbyId = lobbyId;
    this.gameService = GoFishGameService.getInstance();

    // Get wallet address from effectstream bridge
    this.walletAddress = getWalletAddress();
  }

  show() {
    this.isHidden = false;
    this.errorCount = 0;
    this.render();
    // Poll every 5 seconds to reduce database pressure and prevent mutex deadlocks
    // The Paima sync process needs time to complete, and concurrent Midnight queries
    // can block the event loop causing sync protocols to timeout waiting for mutex
    // Increased from 3s to 5s to give more breathing room for sync operations
    this.refreshInterval = window.setInterval(() => this.render(), 5000);
  }

  hide() {
    this.isHidden = true;
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = undefined;
    }
  }

  private async render() {
    // Don't render if screen has been hidden (prevents stale interval callbacks)
    if (this.isHidden) {
      return;
    }

    // Fetch game state from API instead of local service
    if (!this.walletAddress) {
      this.container.innerHTML = '<div class="error">Wallet not connected</div>';
      return;
    }

    // Store previous state for comparison
    this.previousGameState = this.gameState;
    this.previousHand = [...this.myDecryptedHand];

    try {
      const response = await fetch(
        `http://localhost:9999/game_state?lobby_id=${this.lobbyId}&wallet=${this.walletAddress}`
      );

      if (!response.ok) {
        this.errorCount++;
        console.error(`Failed to fetch game state: ${response.status} (error ${this.errorCount}/${GameScreen.MAX_ERRORS})`);

        // Only navigate away after multiple consecutive errors to handle transient issues
        if (this.errorCount >= GameScreen.MAX_ERRORS) {
          console.log('Too many consecutive errors, navigating to lobby list');
          this.dispatchEvent('navigate', { screen: 'lobby-list' });
        }
        return;
      }

      // Reset error count on successful fetch
      this.errorCount = 0;
      this.gameState = await response.json();
    } catch (error) {
      this.errorCount++;
      console.error(`Error fetching game state (error ${this.errorCount}/${GameScreen.MAX_ERRORS}):`, error);

      if (this.errorCount >= GameScreen.MAX_ERRORS) {
        console.log('Too many consecutive errors, navigating to lobby list');
        this.dispatchEvent('navigate', { screen: 'lobby-list' });
      }
      return;
    }

    if (!this.gameState) {
      return;
    }

    if (this.gameState.isGameOver) {
      this.dispatchEvent('navigate', { screen: 'results', lobbyId: this.lobbyId });
      return;
    }

    // Check if we're in setup/dealing phase
    if (this.gameState.phase === 'dealing') {
      // Automatically run setup if not already completed
      if (!this.setupCompleted && !this.setupInProgress) {
        this.runAutomaticSetup();
      }
      this.renderSetupPhase();
      return;
    }

    // Extract game state variables first
    const isMyTurn = this.gameState.currentTurn === this.gameState.playerId;
    const currentTurnPlayer = this.gameState.players[this.gameState.currentTurn - 1];
    const myHandSize = this.gameState.handSizes[this.gameState.playerId - 1];
    const myScore = this.gameState.scores[this.gameState.playerId - 1];

    // Decrypt player's hand via backend API
    if (myHandSize > 0 && this.gameState.playerId) {
      try {
        const response = await fetch(
          `http://localhost:9999/api/midnight/player_hand?lobby_id=${this.lobbyId}&player_id=${this.gameState.playerId}`
        );

        if (response.ok) {
          const data = await response.json();
          this.myDecryptedHand = data.hand || [];
        } else {
          console.error('[GameScreen] Failed to fetch hand from backend:', response.status);
          this.myDecryptedHand = [];
        }
      } catch (error) {
        console.error('[GameScreen] Error fetching hand from backend:', error);
        this.myDecryptedHand = [];
      }
    } else {
      this.myDecryptedHand = [];
    }

    // Detect book completion (score increased) - only if not showing another notification
    if (this.previousScores && !this.notificationModal) {
      const prevMyScore = this.previousScores[this.gameState.playerId - 1];
      if (myScore > prevMyScore) {
        // Player completed a book! Try to determine which rank
        // Look for ranks that disappeared from hand
        const prevRanks = new Set(this.previousHand.map(c => c.rank));
        const rankNames: Rank[] = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

        // Find rank that was in previous hand but not in current (with 4 cards)
        let bookRank: string | undefined;
        for (const rank of prevRanks) {
          const prevCount = this.previousHand.filter(c => c.rank === rank).length;
          const currCount = this.myDecryptedHand.filter(c => c.rank === rank).length;
          if (prevCount >= 4 && currCount === 0) {
            bookRank = rankNames[rank];
            break;
          }
        }

        if (bookRank) {
          this.showNotification({
            type: 'book',
            bookRank
          });
        }
      }
    }

    // Update previous scores for next comparison
    this.previousScores = [...this.gameState.scores] as [number, number];

    // Detect gained cards (hand size increased without drawing) - only if not showing another notification
    // This happens when the opponent responds and transfers cards to us
    if (this.previousGameState && !this.notificationModal) {
      const prevHandSize = this.previousGameState.handSizes[this.previousGameState.playerId - 1];
      const wasMyTurn = this.previousGameState.currentTurn === this.previousGameState.playerId;
      const prevPhase = this.previousGameState.phase;

      // If we were asking (our turn, wait_response phase) and now have more cards, we gained them
      if (wasMyTurn && prevPhase === 'wait_response' && myHandSize > prevHandSize) {
        // Find the new cards
        const gainedCards: Array<{ rank: number; suit: number }> = [];
        for (const card of this.myDecryptedHand) {
          const existedBefore = this.previousHand.some(
            prev => prev.rank === card.rank && prev.suit === card.suit
          );
          if (!existedBefore) {
            gainedCards.push(card);
          }
        }

        if (gainedCards.length > 0) {
          // Find opponent's name (the one who gave cards)
          const opponentIndex = this.gameState.playerId === 1 ? 1 : 0;
          const opponentName = this.gameState.players[opponentIndex]?.name || 'Opponent';

          const rankNames: Rank[] = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
          const suitNames: Suit[] = ['spades', 'hearts', 'diamonds', 'clubs'];

          this.showNotification({
            type: 'gained',
            cards: gainedCards.map(c => ({
              rank: rankNames[c.rank],
              suit: suitNames[c.suit]
            })),
            playerName: opponentName
          });
        }
      }
    }

    // Check if we need a full render or can do selective updates
    if (!this.hasRenderedOnce || this.needsFullRender()) {
      this.fullRender(isMyTurn, currentTurnPlayer, myHandSize, myScore);
      this.hasRenderedOnce = true;
    } else {
      this.selectiveUpdate(isMyTurn, currentTurnPlayer, myHandSize, myScore);
    }
  }

  /**
   * Check if state changes require a full re-render
   */
  private needsFullRender(): boolean {
    if (!this.previousGameState || !this.gameState) return true;

    // Full render needed if phase changed
    if (this.previousGameState.phase !== this.gameState.phase) {
      console.log(`[GameScreen] Full render: phase changed ${this.previousGameState.phase} -> ${this.gameState.phase}`);
      return true;
    }

    // Full render needed if turn changed (cards clickable state depends on whose turn it is)
    if (this.previousGameState.currentTurn !== this.gameState.currentTurn) {
      console.log(`[GameScreen] Full render: turn changed ${this.previousGameState.currentTurn} -> ${this.gameState.currentTurn}`);
      return true;
    }

    // Full render needed if hand size changed (cards added/removed)
    const prevHandSize = this.previousGameState.handSizes[this.previousGameState.playerId - 1];
    const currHandSize = this.gameState.handSizes[this.gameState.playerId - 1];
    if (prevHandSize !== currHandSize) {
      console.log(`[GameScreen] Full render: hand size changed ${prevHandSize} -> ${currHandSize}`);
      return true;
    }

    // Full render needed if hand contents changed
    if (this.handChanged()) {
      console.log('[GameScreen] Full render: hand contents changed');
      return true;
    }

    // Full render needed if scores changed (might indicate book completion that needs UI update)
    const prevMyScore = this.previousGameState.scores[this.previousGameState.playerId - 1];
    const currMyScore = this.gameState.scores[this.gameState.playerId - 1];
    if (prevMyScore !== currMyScore) {
      console.log(`[GameScreen] Full render: score changed ${prevMyScore} -> ${currMyScore}`);
      return true;
    }

    return false;
  }

  /**
   * Check if the hand contents have changed
   */
  private handChanged(): boolean {
    if (this.previousHand.length !== this.myDecryptedHand.length) return true;

    for (let i = 0; i < this.previousHand.length; i++) {
      const prev = this.previousHand[i];
      const curr = this.myDecryptedHand[i];
      if (prev.rank !== curr.rank || prev.suit !== curr.suit) return true;
    }

    return false;
  }

  /**
   * Perform a full DOM render (used on first render or major state changes)
   */
  private fullRender(
    isMyTurn: boolean,
    currentTurnPlayer: any,
    myHandSize: number,
    myScore: number
  ) {
    this.container.innerHTML = `
      <div class="game-screen">
        <!-- Main Game Area - 2 column layout -->
        <div class="game-content">
          <!-- Left Panel: Your Hand + Books -->
          <div class="left-panel">
            <div class="game-info-panel">
              <h1>🎣 Go Fish</h1>
              <div id="turn-indicator" class="turn-indicator ${isMyTurn ? 'your-turn' : ''}">
                ${isMyTurn
                  ? '<strong>🎯 Your Turn!</strong> Click a card to ask for it.'
                  : `⏳ ${currentTurnPlayer?.name || 'Opponent'}'s turn`
                }
              </div>
              <div class="player-books-section">
                <h4 id="books-header">Your Books (${myScore})</h4>
                <div id="books-container">${myScore > 0 ? `<span class="books-count-display">📚 ${myScore} book${myScore !== 1 ? 's' : ''} completed</span>` : '<div class="no-books">None yet</div>'}</div>
              </div>
            </div>

            <!-- Your Hand -->
            <div class="player-hand-panel">
              <h3 id="hand-header">Your Hand (${myHandSize} cards)</h3>
              <div id="hand-container">
              ${myHandSize > 0
                ? this.myDecryptedHand.length > 0
                  ? `<div class="card-grid">
                       ${this.renderDecryptedHand()}
                     </div>`
                  : `<div class="hand-info">Decrypting cards...</div>
                     <div class="card-grid">
                       ${Array(myHandSize).fill(0).map(() => `<div class="card-wrapper">${CardComponent.renderCardBack()}</div>`).join('')}
                     </div>`
                : '<div class="empty-hand">No cards in hand</div>'
              }
              </div>
            </div>

            <!-- Non-modal action panels (respond, go fish, waiting) -->
            <div id="inline-action-panel">
              ${this.renderInlineActionPanel(isMyTurn)}
            </div>
          </div>

          <!-- Right Panel: Stats + Opponent + Game Log -->
          <div class="right-panel">
            <!-- Game Stats -->
            <div class="game-stats-panel">
              <h3>Game Stats</h3>
              <div class="stats-content">
                <div class="stat-row">
                  <span class="stat-label">🃏 Deck:</span>
                  <span id="deck-count" class="stat-value">${this.gameState!.deckCount} cards</span>
                </div>
                <div class="stat-row">
                  <span class="stat-label">📊 Your Books:</span>
                  <span id="my-score" class="stat-value">${myScore}</span>
                </div>
                <div class="stat-row">
                  <span class="stat-label">📊 Opponent's Books:</span>
                  <span id="opponent-score" class="stat-value">${this.gameState!.scores[this.gameState!.playerId === 1 ? 1 : 0]}</span>
                </div>
              </div>
            </div>

            <!-- Opponent -->
            <div class="opponent-panel">
              <h3>Opponent</h3>
              <div id="opponent-container">
              ${this.gameState!.players
                .map((p: any, index: number) => ({ player: p, playerNum: index + 1 }))
                .filter(({ playerNum }) => playerNum !== this.gameState!.playerId)
                .map(({ player, playerNum }) => this.renderOpponentFromAPI(player, playerNum))
                .join('')
              }
              </div>
            </div>

            <!-- Game Log -->
            <div class="game-log-panel">
              <h3>Game Log</h3>
              <div id="game-log-container">${this.renderGameLogFromAPI()}</div>
            </div>
          </div>
        </div>
      </div>

      <!-- Action Modal (shown when card is clicked during turn_start) -->
      <div id="action-modal-container">
        ${this.showActionModal ? this.renderActionModal() : ''}
      </div>

      <!-- Notification Modal (shown for card draw, gain/lose, book) -->
      <div id="notification-modal-container">
        ${this.renderNotificationModal()}
      </div>
    `;

    this.attachEventListeners();
  }

  /**
   * Perform selective DOM updates (preserves existing DOM structure)
   */
  private selectiveUpdate(
    isMyTurn: boolean,
    currentTurnPlayer: any,
    myHandSize: number,
    myScore: number
  ) {
    // Update turn indicator
    const turnIndicator = document.getElementById('turn-indicator');
    if (turnIndicator) {
      turnIndicator.className = `turn-indicator ${isMyTurn ? 'your-turn' : ''}`;
      turnIndicator.innerHTML = isMyTurn
        ? '<strong>🎯 Your Turn!</strong> Click a card to ask for it.'
        : `⏳ ${currentTurnPlayer?.name || 'Opponent'}'s turn`;
    }

    // Update stats
    this.updateTextContent('deck-count', `${this.gameState!.deckCount} cards`);
    this.updateTextContent('my-score', `${myScore}`);
    this.updateTextContent('opponent-score', `${this.gameState!.scores[this.gameState!.playerId === 1 ? 1 : 0]}`);
    this.updateTextContent('books-header', `Your Books (${myScore})`);
    this.updateTextContent('hand-header', `Your Hand (${myHandSize} cards)`);

    // Update books container
    const booksContainer = document.getElementById('books-container');
    if (booksContainer) {
      booksContainer.innerHTML = myScore > 0
        ? `<span class="books-count-display">📚 ${myScore} book${myScore !== 1 ? 's' : ''} completed</span>`
        : '<div class="no-books">None yet</div>';
    }

    // Update inline action panel (respond, go fish, waiting, etc.)
    const inlineActionPanel = document.getElementById('inline-action-panel');
    if (inlineActionPanel) {
      inlineActionPanel.innerHTML = this.renderInlineActionPanel(isMyTurn);
    }

    // Update action modal container
    const modalContainer = document.getElementById('action-modal-container');
    if (modalContainer) {
      modalContainer.innerHTML = this.showActionModal ? this.renderActionModal() : '';
    }

    // Update game log
    const gameLogContainer = document.getElementById('game-log-container');
    if (gameLogContainer) {
      gameLogContainer.innerHTML = this.renderGameLogFromAPI();
    }

    // Update opponent info
    const opponentContainer = document.getElementById('opponent-container');
    if (opponentContainer) {
      opponentContainer.innerHTML = this.gameState!.players
        .map((p: any, index: number) => ({ player: p, playerNum: index + 1 }))
        .filter(({ playerNum }) => playerNum !== this.gameState!.playerId)
        .map(({ player, playerNum }) => this.renderOpponentFromAPI(player, playerNum))
        .join('');
    }

    // Re-attach event listeners for updated elements
    this.attachEventListeners();
  }

  /**
   * Helper to update text content of an element by ID
   */
  private updateTextContent(id: string, text: string) {
    const el = document.getElementById(id);
    if (el && el.textContent !== text) {
      el.textContent = text;
    }
  }

  /**
   * Update just the modal container without full re-render
   */
  private updateModalContainer() {
    const modalContainer = document.getElementById('action-modal-container');
    if (modalContainer) {
      modalContainer.innerHTML = this.showActionModal ? this.renderActionModal() : '';
    }
  }

  /**
   * Close the action modal
   */
  private closeActionModal() {
    this.showActionModal = false;
    this.selectedRank = null;
    this.selectedTargetId = null;
    this.updateModalContainer();
  }

  private renderOpponent(player: GoFishPlayer, game: GoFishGameState): string {
    const isCurrentTurn = game.players[game.currentTurnIndex].id === player.id;

    return `
      <div class="opponent-area ${isCurrentTurn ? 'current-turn' : ''}">
        <div class="opponent-info">
          <div class="opponent-name">
            ${player.name} ${isCurrentTurn ? '👈' : ''}
          </div>
          <div class="opponent-stats">
            🃏 ${player.cardCount} cards | 📚 ${player.books.length} books
          </div>
          <div class="opponent-books">
            ${player.books.map(rank => `<span class="book-badge">${rank}</span>`).join(' ')}
          </div>
        </div>
        <div class="opponent-cards">
          ${Array(Math.min(player.cardCount, 10))
            .fill(0)
            .map(() => `<div class="card-wrapper-small">${CardComponent.renderCardBack()}</div>`)
            .join('')
          }
          ${player.cardCount > 10 ? `<span class="card-overflow">+${player.cardCount - 10}</span>` : ''}
        </div>
      </div>
    `;
  }

  private renderDecryptedHand(): string {
    // Convert numeric rank/suit to Card objects
    const rankNames: Rank[] = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
    const suitNames: Suit[] = ['spades', 'hearts', 'diamonds', 'clubs'];

    const cards = this.myDecryptedHand.map(({ rank, suit }) => ({
      rank: rankNames[rank],
      suit: suitNames[suit]
    }));

    // Check if it's the player's turn AND in turn_start phase to make cards clickable
    // Cards should only be clickable when it's time to ask for a card
    const isMyTurn = this.gameState?.currentTurn === this.gameState?.playerId;
    const canAskForCard = isMyTurn && this.gameState?.phase === 'turn_start';

    // Debug logging when cards should be clickable but something might be wrong
    if (isMyTurn && !canAskForCard) {
      console.log(`[GameScreen] Cards not clickable: isMyTurn=${isMyTurn}, phase=${this.gameState?.phase}`);
    }

    return cards
      .map(card => {
        const isSelected = this.selectedRank === card.rank;
        const clickableClass = canAskForCard ? 'clickable' : '';
        const selectedClass = isSelected ? 'selected' : '';
        return `
          <div class="card-wrapper ${clickableClass} ${selectedClass}"
               data-rank="${card.rank}"
               data-suit="${card.suit}">
            ${CardComponent.render(card, true)}
          </div>
        `;
      })
      .join('');
  }

  /**
   * Automatically run the setup sequence (applyMask + dealCards)
   * Checks state before each operation to avoid race conditions
   */
  private async runAutomaticSetup() {
    if (!this.gameState) return;

    this.setupInProgress = true;

    try {
      console.log('[GameScreen] Starting automatic setup...');

      // Check current setup status
      const statusResponse = await fetch(
        `http://localhost:9999/api/midnight/setup_status?lobby_id=${this.lobbyId}&player_id=${this.gameState.playerId}`
      );
      const status = await statusResponse.json();

      console.log('[GameScreen] Setup status:', status);

      // Step 1: Apply mask (only if not already applied)
      // Use frontend-side cache to prevent duplicate attempts
      if (!this.maskApplied && !status.hasMaskApplied) {
        console.log('[GameScreen] Applying mask...');
        const maskResponse = await fetch('http://localhost:9999/api/midnight/apply_mask', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            lobby_id: this.lobbyId,
            player_id: this.gameState.playerId
          })
        });

        const maskResult = await maskResponse.json();
        if (!maskResult.success) {
          // Check if error is "already applied" - treat as success and continue
          if (maskResult.errorMessage?.includes('already applied')) {
            console.log('[GameScreen] Mask already applied (detected via error) - continuing');
            this.maskApplied = true;  // Mark as applied
          } else {
            throw new Error(`Apply mask failed: ${maskResult.errorMessage}`);
          }
        } else {
          console.log('[GameScreen] Mask applied successfully');
          this.maskApplied = true;  // Mark as applied
        }
      } else {
        console.log('[GameScreen] Mask already applied, skipping');
      }

      // Step 2: Deal cards (only if both players have applied masks and we haven't dealt yet)
      // IMPORTANT: Contract requires Player 1 to deal FIRST, then Player 2
      // Use frontend-side cache to prevent duplicate attempts
      if (!this.cardsDealt && !status.hasDealt) {
        // Re-fetch status to get latest opponent info
        const updatedStatusResponse = await fetch(
          `http://localhost:9999/api/midnight/setup_status?lobby_id=${this.lobbyId}&player_id=${this.gameState.playerId}`
        );
        const updatedStatus = await updatedStatusResponse.json();

        if (!updatedStatus.opponentHasMaskApplied) {
          console.log('[GameScreen] Waiting for opponent to apply mask...');
          return; // Don't mark as complete, retry later
        }

        // Check dealing order - Player 1 must deal first, then Player 2
        const myPlayerId = this.gameState.playerId;

        // Player 2 must wait for Player 1 to deal first
        if (myPlayerId === 2 && !updatedStatus.opponentHasDealt) {
          console.log('[GameScreen] Player 2 waiting for Player 1 to deal first...');
          return; // Don't deal yet, retry later
        }

        console.log(`[GameScreen] Player ${myPlayerId} dealing cards...`);
        const dealResponse = await fetch('http://localhost:9999/api/midnight/deal_cards', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            lobby_id: this.lobbyId,
            player_id: this.gameState.playerId
          })
        });

        const dealResult = await dealResponse.json();
        if (!dealResult.success) {
          // Check if error is "already dealt" - treat as success
          if (dealResult.errorMessage?.includes('Player 1 must apply mask')) {
            console.log('[GameScreen] Opponent has not applied mask yet, will retry...');
            return; // Don't mark as complete, retry later
          } else if (dealResult.errorMessage?.includes('already dealt')) {
            console.log('[GameScreen] Cards already dealt (detected via error) - continuing');
            this.cardsDealt = true;  // Mark as dealt
          } else {
            throw new Error(`Deal cards failed: ${dealResult.errorMessage}`);
          }
        } else {
          console.log('[GameScreen] Cards dealt successfully');
          this.cardsDealt = true;  // Mark as dealt
        }
      } else {
        console.log('[GameScreen] Cards already dealt, skipping');
      }

      console.log('[GameScreen] Automatic setup complete!');
      this.setupCompleted = true;
    } catch (error: any) {
      console.error('[GameScreen] Automatic setup failed:', error);
      // Don't mark as completed so it can retry
    } finally {
      this.setupInProgress = false;
    }
  }

  private renderSetupPhase() {
    if (!this.gameState) return;

    // Show simplified UI during automatic setup
    const statusMessage = this.setupInProgress
      ? 'Setting up your game... (applying cryptographic masks and dealing cards)'
      : this.setupCompleted
      ? 'Setup complete! Waiting for opponent to finish...'
      : 'Initializing setup...';

    this.container.innerHTML = `
      <div class="game-setup-screen">
        <div class="setup-container">
          <h1>🎣 Go Fish</h1>
          <h2>🎴 Game Setup</h2>
          <p class="setup-description">
            Each player's secret cards are being initialized in the Midnight contract.
            This uses zero-knowledge proofs to ensure fair play - no one can see your cards!
          </p>

          <div class="setup-spinner-section">
            <div class="spinner"></div>
            <p class="setup-status">${statusMessage}</p>
          </div>

          <div class="setup-info">
            <p>Setup happens automatically. Once both players complete setup, the game will begin!</p>
          </div>
        </div>
      </div>

      <style>
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      </style>
    `;

    // Setup now runs automatically - no manual buttons needed
  }

  private renderActionPanel(game: GoFishGameState, currentPlayer: GoFishPlayer): string {
    if (!currentPlayer || currentPlayer.hand.length === 0) {
      return `
        <div class="ask-action-panel">
          <p class="info-text">You have no cards. Drawing will happen automatically...</p>
        </div>
      `;
    }

    const availableRanks = getUniqueRanks(currentPlayer.hand);
    const opponents = game.players.filter(p => p.id !== this.gameService.getPlayerId());

    return `
      <div class="ask-action-panel">
        <h3>Ask for a Card</h3>

        <div class="instruction-text">
          1. Select a rank from your hand
        </div>

        <div class="rank-selector">
          ${availableRanks.map(rank => `
            <button
              class="rank-btn ${this.selectedRank === rank ? 'selected' : ''}"
              data-rank="${rank}"
            >
              ${rank}
            </button>
          `).join('')}
        </div>

        <div class="instruction-text">
          2. Select which player to ask
        </div>

        <div class="player-selector">
          ${opponents.map(p => `
            <button
              class="player-select-btn ${this.selectedTargetId === p.id ? 'selected' : ''}"
              data-player-id="${p.id}"
            >
              ${p.name} - ${p.cardCount} cards
            </button>
          `).join('')}
        </div>

        <button
          id="ask-btn"
          class="btn btn-primary"
          ${!this.selectedRank || !this.selectedTargetId ? 'disabled' : ''}
        >
          Ask for ${this.selectedRank || '...'} from ${
            opponents.find(p => p.id === this.selectedTargetId)?.name || '...'
          }
        </button>
      </div>
    `;
  }

  private renderCenterPanel(isMyTurn: boolean): string {
    if (!this.gameState) return '';

    const phase = this.gameState.phase;
    const myPlayerId = this.gameState.playerId;
    const currentTurn = this.gameState.currentTurn;

    // Handle different game phases
    switch (phase) {
      case 'turn_start':
        // Current player can ask for cards
        if (isMyTurn) {
          return this.renderActionPanelFromAPI();
        } else {
          return this.renderWaitingPanel(`Waiting for ${this.gameState.players[currentTurn - 1]?.name || 'opponent'} to ask for cards...`);
        }

      case 'wait_response':
        // The opponent (non-current-turn player) needs to respond
        if (!isMyTurn) {
          // I'm the one who needs to respond
          return this.renderRespondPanel();
        } else {
          // I asked, waiting for opponent to respond
          return this.renderWaitingPanel('Waiting for opponent to check their cards...');
        }

      case 'wait_transfer':
        // Cards are being transferred
        return this.renderWaitingPanel('Transferring cards...');

      case 'wait_draw':
        // Current player needs to draw (Go Fish!)
        if (isMyTurn) {
          return this.renderGoFishPanel();
        } else {
          return this.renderWaitingPanel('Opponent is drawing a card...');
        }

      case 'wait_draw_check':
        // Checking if drawn card matches
        return this.renderWaitingPanel('Checking drawn card...');

      case 'finished':
        return this.renderGameOverPanel();

      default:
        if (isMyTurn) {
          return this.renderActionPanelFromAPI();
        } else {
          return this.renderWaitingPanel(`Waiting for ${this.gameState.players[currentTurn - 1]?.name || 'opponent'}...`);
        }
    }
  }

  private renderWaitingPanel(message?: string): string {
    return `
      <div class="ask-action-panel">
        <div class="waiting-indicator">
          <h3>⏳ ${message || 'Waiting for your turn...'}</h3>
          <p>Watch the game log to see what happens!</p>
        </div>
      </div>
    `;
  }

  /**
   * Render inline action panels (non-modal: respond, go fish, waiting, game over)
   * The "ask for card" action is handled via modal instead
   */
  private renderInlineActionPanel(isMyTurn: boolean): string {
    if (!this.gameState) return '';

    const phase = this.gameState.phase;
    const currentTurn = this.gameState.currentTurn;

    // Handle different game phases - only show inline panels for non-ask actions
    switch (phase) {
      case 'turn_start':
        // Don't show anything inline - asking is done via modal after clicking card
        if (isMyTurn) {
          return ''; // Modal handles the ask action
        } else {
          return this.renderWaitingPanel(`Waiting for ${this.gameState.players[currentTurn - 1]?.name || 'opponent'} to ask for cards...`);
        }

      case 'wait_response':
        // The opponent (non-current-turn player) needs to respond
        if (!isMyTurn) {
          // I'm the one who needs to respond
          return this.renderRespondPanel();
        } else {
          // I asked, waiting for opponent to respond
          return this.renderWaitingPanel('Waiting for opponent to check their cards...');
        }

      case 'wait_transfer':
        // Cards are being transferred
        return this.renderWaitingPanel('Transferring cards...');

      case 'wait_draw':
        // Current player needs to draw (Go Fish!)
        if (isMyTurn) {
          return this.renderGoFishPanel();
        } else {
          return this.renderWaitingPanel('Opponent is drawing a card...');
        }

      case 'wait_draw_check':
        // Checking if drawn card matches
        return this.renderWaitingPanel('Checking drawn card...');

      case 'finished':
        return this.renderGameOverPanel();

      default:
        if (!isMyTurn) {
          return this.renderWaitingPanel(`Waiting for ${this.gameState.players[currentTurn - 1]?.name || 'opponent'}...`);
        }
        return '';
    }
  }

  /**
   * Render the action modal for asking for cards
   */
  private renderActionModal(): string {
    if (!this.gameState || !this.selectedRank) return '';

    const opponents = this.gameState.players.filter((_p: any, index: number) =>
      index + 1 !== this.gameState!.playerId
    );

    return `
      <div class="game-action-modal-overlay" id="action-modal-overlay">
        <div class="game-action-modal">
          <div class="modal-header">
            <h3>Ask for Cards</h3>
            <button class="modal-close-btn" id="modal-close-btn">&times;</button>
          </div>

          <div class="selected-card-display">
            <div class="rank-display">${this.selectedRank}</div>
            <div class="label">Selected Rank</div>
          </div>

          <div class="instruction-text">
            Select which player to ask for ${this.selectedRank}s:
          </div>

          <div class="player-selector">
            ${opponents.map((p: any) => {
              const actualPlayerNum = this.gameState!.players.indexOf(p) + 1;
              return `
                <button
                  class="player-select-btn ${this.selectedTargetId === String(actualPlayerNum) ? 'selected' : ''}"
                  data-player-id="${actualPlayerNum}"
                >
                  ${p.name} - ${this.gameState!.handSizes[actualPlayerNum - 1]} cards
                </button>
              `;
            }).join('')}
          </div>

          <button
            id="ask-btn"
            class="btn btn-primary ask-button"
            style="width: 100%; margin-top: 16px;"
            ${!this.selectedTargetId ? 'disabled' : ''}
          >
            ${this.selectedTargetId
              ? `Ask for ${this.selectedRank}s`
              : 'Select a player above'}
          </button>
        </div>
      </div>
    `;
  }

  private renderRespondPanel(): string {
    return `
      <div class="ask-action-panel">
        <h3>🔍 Opponent Asked for Cards!</h3>
        <p class="info-text">Your opponent is asking if you have any cards of the requested rank.</p>
        <p class="info-text">Click the button below to check your hand and respond.</p>
        <button id="respond-btn" class="btn btn-primary ask-button">
          Check My Hand & Respond
        </button>
      </div>
    `;
  }

  private renderGoFishPanel(): string {
    // Check if deck is empty
    const deckEmpty = this.gameState && this.gameState.deckCount === 0;

    if (deckEmpty) {
      return `
        <div class="ask-action-panel">
          <h3>🃏 Deck is Empty!</h3>
          <p class="info-text">Your opponent doesn't have the cards you asked for, but the deck is empty.</p>
          <p class="info-text">Your turn ends without drawing.</p>
          <button id="skip-draw-btn" class="btn btn-primary ask-button">
            End Turn
          </button>
        </div>
      `;
    }

    return `
      <div class="ask-action-panel">
        <h3>🎣 Go Fish!</h3>
        <p class="info-text">Your opponent doesn't have the cards you asked for.</p>
        <p class="info-text">Draw a card from the deck!</p>
        <button id="go-fish-btn" class="btn btn-primary ask-button">
          🎣 Draw from Deck
        </button>
      </div>
    `;
  }

  private renderGameOverPanel(): string {
    if (!this.gameState) return '';

    const myScore = this.gameState.scores[this.gameState.playerId - 1];
    const opponentScore = this.gameState.scores[this.gameState.playerId === 1 ? 1 : 0];
    const isWinner = myScore > opponentScore;
    const isTie = myScore === opponentScore;

    return `
      <div class="ask-action-panel game-over-panel">
        <h2>${isTie ? '🤝 It\'s a Tie!' : isWinner ? '🎉 You Won!' : '😔 You Lost'}</h2>
        <div class="final-scores">
          <p>Your Books: ${myScore}</p>
          <p>Opponent's Books: ${opponentScore}</p>
        </div>
        <button id="back-to-lobby-btn" class="btn btn-primary">
          Back to Lobby List
        </button>
      </div>
    `;
  }

  private renderGameLog(): string {
    const messages = this.gameService.getMessages(this.lobbyId);

    if (messages.length === 0) {
      return '<div class="empty-log">Game starting...</div>';
    }

    return messages
      .slice(-10)
      .map(msg => `
        <div class="log-entry ${msg.isSystem ? 'system' : ''}">
          ${msg.message}
        </div>
      `)
      .join('');
  }

  /**
   * Render notification modal for game events (draw, gain/lose cards, book)
   */
  private renderNotificationModal(): string {
    if (!this.notificationModal) return '';

    const { type, card, cards, playerName, bookRank } = this.notificationModal;

    let title = '';
    let content = '';
    let icon = '';

    switch (type) {
      case 'draw':
        icon = '🎣';
        title = 'You Drew a Card!';
        if (card) {
          content = `
            <div class="notification-card-display">
              <div class="card-wrapper">
                ${CardComponent.render({ rank: card.rank as Rank, suit: card.suit as Suit }, true)}
              </div>
            </div>
            <p class="notification-text">You drew a <strong>${card.rank}</strong>!</p>
          `;
        }
        break;

      case 'gained':
        icon = '🎉';
        title = 'Cards Gained!';
        if (cards && cards.length > 0 && playerName) {
          const rankDisplay = cards[0].rank;
          content = `
            <div class="notification-cards-display">
              ${cards.map(c => `<div class="card-wrapper">${CardComponent.render({ rank: c.rank as Rank, suit: c.suit as Suit }, true)}</div>`).join('')}
            </div>
            <p class="notification-text">You got <strong>${cards.length} ${rankDisplay}${cards.length > 1 ? 's' : ''}</strong> from <strong>${playerName}</strong>!</p>
          `;
        }
        break;

      case 'lost':
        icon = '😢';
        title = 'Cards Lost';
        if (cards && cards.length > 0 && playerName) {
          const rankDisplay = cards[0].rank;
          content = `
            <div class="notification-cards-display lost">
              ${cards.map(c => `<div class="card-wrapper">${CardComponent.render({ rank: c.rank as Rank, suit: c.suit as Suit }, true)}</div>`).join('')}
            </div>
            <p class="notification-text"><strong>${playerName}</strong> took <strong>${cards.length} ${rankDisplay}${cards.length > 1 ? 's' : ''}</strong> from you!</p>
          `;
        }
        break;

      case 'book':
        icon = '📚';
        title = 'Book Completed!';
        if (bookRank) {
          content = `
            <div class="notification-book-display">
              <div class="book-icon">📚</div>
              <div class="book-rank">${bookRank}</div>
            </div>
            <p class="notification-text">You completed a book of <strong>${bookRank}s</strong>!</p>
          `;
        }
        break;
    }

    return `
      <div class="notification-modal-overlay" id="notification-modal-overlay">
        <div class="notification-modal">
          <div class="notification-icon">${icon}</div>
          <h3>${title}</h3>
          ${content}
          <button id="notification-dismiss-btn" class="btn btn-primary">
            Got it!
          </button>
        </div>
      </div>
    `;
  }

  /**
   * Show a notification modal
   */
  private showNotification(notification: typeof this.notificationModal): void {
    this.notificationModal = notification;
    this.updateNotificationContainer();
    this.attachNotificationListeners();
  }

  /**
   * Dismiss the notification modal
   */
  private dismissNotification(): void {
    this.notificationModal = null;
    this.updateNotificationContainer();
  }

  /**
   * Update just the notification modal container
   */
  private updateNotificationContainer(): void {
    const container = document.getElementById('notification-modal-container');
    if (container) {
      container.innerHTML = this.renderNotificationModal();
      if (this.notificationModal) {
        this.attachNotificationListeners();
      }
    }
  }

  /**
   * Attach event listeners for notification modal using event delegation
   */
  private attachNotificationListeners(): void {
    const container = document.getElementById('notification-modal-container');
    if (!container) return;

    // Use event delegation on the container to avoid issues with cloned elements
    container.onclick = (e) => {
      const target = e.target as HTMLElement;

      // Check if dismiss button was clicked
      if (target.id === 'notification-dismiss-btn' || target.closest('#notification-dismiss-btn')) {
        e.stopPropagation();
        this.dismissNotification();
        return;
      }

      // Check if overlay was clicked (but not the modal content)
      if (target.id === 'notification-modal-overlay') {
        this.dismissNotification();
      }
    };
  }

  // New API-based render methods

  private renderOpponentFromAPI(player: any, playerNum: number): string {
    if (!this.gameState) return '';

    const isCurrentTurn = this.gameState.currentTurn === playerNum;
    const opponentHandSize = this.gameState.handSizes[playerNum - 1];
    const opponentScore = this.gameState.scores[playerNum - 1];

    return `
      <div class="opponent-area ${isCurrentTurn ? 'current-turn' : ''}">
        <div class="opponent-info">
          <div class="opponent-name">
            ${player.name} ${isCurrentTurn ? '👈' : ''}
          </div>
          <div class="opponent-stats">
            🃏 ${opponentHandSize} cards | 📚 ${opponentScore} books
          </div>
        </div>
        <div class="opponent-cards">
          ${Array(Math.min(opponentHandSize, 10))
            .fill(0)
            .map(() => `<div class="card-wrapper-small">${CardComponent.renderCardBack()}</div>`)
            .join('')
          }
          ${opponentHandSize > 10 ? `<span class="card-overflow">+${opponentHandSize - 10}</span>` : ''}
        </div>
      </div>
    `;
  }

  private renderActionPanelFromAPI(): string {
    if (!this.gameState) return '';

    const myHandSize = this.gameState.handSizes[this.gameState.playerId - 1];

    if (myHandSize === 0) {
      return `
        <div class="ask-action-panel">
          <p class="info-text">You have no cards. Click "Go Fish" to draw from the deck.</p>
          <button id="go-fish-btn" class="btn btn-primary">🎣 Go Fish</button>
        </div>
      `;
    }

    const opponents = this.gameState.players.filter((_p: any, index: number) =>
      index + 1 !== this.gameState!.playerId
    );

    const selectedRankDisplay = this.selectedRank
      ? `<span class="selected-rank">${this.selectedRank}</span>`
      : '<span class="no-selection">Click a card in your hand</span>';

    return `
      <div class="ask-action-panel">
        <h3>Ask for a Card</h3>

        <div class="selection-display">
          <div class="selection-item">
            <span class="selection-label">Selected Rank:</span>
            ${selectedRankDisplay}
          </div>
        </div>

        <div class="instruction-text">
          Select which player to ask
        </div>

        <div class="player-selector">
          ${opponents.map((p: any) => {
            const actualPlayerNum = this.gameState!.players.indexOf(p) + 1;
            return `
              <button
                class="player-select-btn ${this.selectedTargetId === String(actualPlayerNum) ? 'selected' : ''}"
                data-player-id="${actualPlayerNum}"
              >
                ${p.name} - ${this.gameState!.handSizes[actualPlayerNum - 1]} cards
              </button>
            `;
          }).join('')}
        </div>

        <button
          id="ask-btn"
          class="btn btn-primary ask-button"
          ${!this.selectedRank || !this.selectedTargetId ? 'disabled' : ''}
        >
          ${this.selectedRank && this.selectedTargetId
            ? `Ask for ${this.selectedRank}s`
            : 'Select a card and player'}
        </button>
      </div>
    `;
  }

  private renderGameLogFromAPI(): string {
    if (!this.gameState || !this.gameState.gameLog) {
      return '<div class="empty-log">Game starting...</div>';
    }

    if (this.gameState.gameLog.length === 0) {
      return '<div class="empty-log">No moves yet</div>';
    }

    const totalEntries = this.gameState.gameLog.length;

    // Take last 10 entries, reverse to show newest first, and add numbering
    return `
      <table class="game-log-table">
        <tbody>
          ${this.gameState.gameLog
            .slice(-10)
            .reverse()
            .map((msg, reverseIndex) => {
              // Calculate the actual entry number (1-indexed from start of game)
              const entryNumber = totalEntries - reverseIndex;
              // Mark the newest entry (first in reversed list) for animation
              const isNewest = reverseIndex === 0;
              return `
                <tr class="log-row ${isNewest ? 'newest' : ''}">
                  <td class="log-number">${entryNumber}</td>
                  <td class="log-message">${msg}</td>
                </tr>
              `;
            })
            .join('')}
        </tbody>
      </table>
    `;
  }

  private attachEventListeners() {
    // Card selection - click on cards in your hand to select the rank and open modal
    const clickableCards = document.querySelectorAll('.card-wrapper.clickable');
    console.log(`[GameScreen] Attaching click listeners to ${clickableCards.length} clickable cards`);

    clickableCards.forEach(wrapper => {
      wrapper.addEventListener('click', (e) => {
        const target = e.currentTarget as HTMLElement;
        const rank = target.dataset.rank as Rank;
        console.log(`[GameScreen] Card clicked: rank=${rank}, showActionModal will be set to true`);
        if (rank) {
          this.selectedRank = rank;
          this.selectedTargetId = null; // Reset target when selecting new card
          this.showActionModal = true;
          this.updateModalContainer();
          this.attachModalEventListeners();
        }
      });
    });

    // Attach modal event listeners if modal is showing
    if (this.showActionModal) {
      this.attachModalEventListeners();
    }

    // Attach inline action panel event listeners
    this.attachInlineActionListeners();
  }

  /**
   * Attach event listeners for inline action panels (respond, go fish, back to lobby)
   */
  private attachInlineActionListeners() {
    // Go Fish action - draw from deck and complete turn
    document.getElementById('go-fish-btn')?.addEventListener('click', async () => {
      const btn = document.getElementById('go-fish-btn') as HTMLButtonElement;
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Drawing...';
      }

      if (this.gameState) {
        try {
          // Step 1: Get hand before drawing to compare later
          const handBeforeResponse = await fetch(
            `http://localhost:9999/api/midnight/player_hand?lobby_id=${this.lobbyId}&player_id=${this.gameState.playerId}`
          );
          const handBeforeData = await handBeforeResponse.json();
          const handBefore = handBeforeData.hand || [];
          console.log('[GameScreen] Hand before Go Fish:', handBefore);

          // Step 2: Draw card from deck
          const goFishResponse = await fetch('http://localhost:9999/api/midnight/go_fish', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              lobby_id: this.lobbyId,
              player_id: this.gameState.playerId
            })
          });

          const goFishResult = await goFishResponse.json();

          if (!goFishResult.success) {
            alert(`Failed to draw card: ${goFishResult.errorMessage}`);
            // Re-enable button on error
            if (btn) {
              btn.disabled = false;
              btn.textContent = '🎣 Draw from Deck';
            }
            return;
          }

          console.log('[GameScreen] Go Fish draw succeeded');

          // Step 3: Get hand after drawing to find the new card
          const handAfterResponse = await fetch(
            `http://localhost:9999/api/midnight/player_hand?lobby_id=${this.lobbyId}&player_id=${this.gameState.playerId}`
          );
          const handAfterData = await handAfterResponse.json();
          const handAfter = handAfterData.hand || [];
          console.log('[GameScreen] Hand after Go Fish:', handAfter);

          // Step 4: Find the new card by comparing hands
          // Cards are {rank, suit} objects - find the card in handAfter not in handBefore
          let drewRequestedCard = false;
          let drawnCard: { rank: number; suit: number } | null = null;

          // Find any new card by looking for cards in handAfter not in handBefore
          for (const cardAfter of handAfter) {
            const existsInBefore = handBefore.some(
              (cardBefore: {rank: number; suit: number}) =>
                cardBefore.rank === cardAfter.rank && cardBefore.suit === cardAfter.suit
            );
            if (!existsInBefore) {
              drawnCard = cardAfter;
              console.log(`[GameScreen] Drew card: rank=${cardAfter.rank}, suit=${cardAfter.suit}`);

              // Check if it matches the asked rank
              if (this.selectedRank !== null) {
                const rankMap: Record<string, number> = {
                  'A': 0, '2': 1, '3': 2, '4': 3, '5': 4, '6': 5, '7': 6,
                  '8': 7, '9': 8, '10': 9, 'J': 10, 'Q': 11, 'K': 12
                };
                const askedRankNum = rankMap[this.selectedRank] ?? -1;
                if (cardAfter.rank === askedRankNum) {
                  drewRequestedCard = true;
                  console.log('[GameScreen] Drew the requested card! Player gets another turn.');
                }
              }
              break;
            }
          }

          // Show notification for the drawn card
          if (drawnCard) {
            const rankNames: Rank[] = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
            const suitNames: Suit[] = ['spades', 'hearts', 'diamonds', 'clubs'];
            this.showNotification({
              type: 'draw',
              card: {
                rank: rankNames[drawnCard.rank],
                suit: suitNames[drawnCard.suit]
              }
            });
          }

          // Step 5: Call afterGoFish to complete the turn
          console.log(`[GameScreen] Calling afterGoFish with drewRequestedCard=${drewRequestedCard}`);
          const afterGoFishResponse = await fetch('http://localhost:9999/api/midnight/after_go_fish', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              lobby_id: this.lobbyId,
              player_id: this.gameState.playerId,
              drew_requested_card: drewRequestedCard
            })
          });

          const afterGoFishResult = await afterGoFishResponse.json();

          if (afterGoFishResult.success) {
            console.log('[GameScreen] afterGoFish succeeded, turn complete');
            // Clear selected rank since turn is complete
            this.selectedRank = null;
            // State will update on next poll
          } else {
            console.error('[GameScreen] afterGoFish failed:', afterGoFishResult.errorMessage);
            alert(`Failed to complete turn: ${afterGoFishResult.errorMessage}`);
          }
        } catch (error) {
          console.error('[GameScreen] Go Fish failed:', error);
          alert('Failed to draw card. Please try again.');
          // Re-enable button on error
          if (btn) {
            btn.disabled = false;
            btn.textContent = '🎣 Draw from Deck';
          }
        }
      }
    });

    // Respond to ask action - check hand and respond
    document.getElementById('respond-btn')?.addEventListener('click', async () => {
      const btn = document.getElementById('respond-btn') as HTMLButtonElement;
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Checking...';
      }

      if (this.gameState) {
        try {
          // Get hand before responding to compare later
          const handBeforeResponse = await fetch(
            `http://localhost:9999/api/midnight/player_hand?lobby_id=${this.lobbyId}&player_id=${this.gameState.playerId}`
          );
          const handBeforeData = await handBeforeResponse.json();
          const handBefore: Array<{ rank: number; suit: number }> = handBeforeData.hand || [];

          const response = await fetch('http://localhost:9999/api/midnight/respond_to_ask', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              lobby_id: this.lobbyId,
              player_id: this.gameState.playerId
            })
          });

          const result = await response.json();

          if (result.success) {
            console.log('[GameScreen] Respond to ask succeeded:', result);

            // If cards were transferred (we lost cards), show notification
            if (result.hasCards && result.cardCount > 0) {
              // Get hand after to find what cards were lost
              const handAfterResponse = await fetch(
                `http://localhost:9999/api/midnight/player_hand?lobby_id=${this.lobbyId}&player_id=${this.gameState.playerId}`
              );
              const handAfterData = await handAfterResponse.json();
              const handAfter: Array<{ rank: number; suit: number }> = handAfterData.hand || [];

              // Find cards that were in handBefore but not in handAfter
              const lostCards: Array<{ rank: number; suit: number }> = [];
              for (const cardBefore of handBefore) {
                const stillExists = handAfter.some(
                  cardAfter => cardAfter.rank === cardBefore.rank && cardAfter.suit === cardBefore.suit
                );
                if (!stillExists) {
                  lostCards.push(cardBefore);
                }
              }

              if (lostCards.length > 0) {
                // Find opponent's name (the one who asked)
                const opponentIndex = this.gameState.currentTurn - 1;
                const opponentName = this.gameState.players[opponentIndex]?.name || 'Opponent';

                const rankNames: Rank[] = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
                const suitNames: Suit[] = ['spades', 'hearts', 'diamonds', 'clubs'];

                this.showNotification({
                  type: 'lost',
                  cards: lostCards.map(c => ({
                    rank: rankNames[c.rank],
                    suit: suitNames[c.suit]
                  })),
                  playerName: opponentName
                });
              }
            }
            // State will update on next poll
          } else {
            alert(`Failed to respond: ${result.errorMessage}`);
            // Re-enable button on error
            if (btn) {
              btn.disabled = false;
              btn.textContent = 'Check My Hand & Respond';
            }
          }
        } catch (error) {
          console.error('[GameScreen] Respond to ask failed:', error);
          alert('Failed to respond. Please try again.');
          // Re-enable button on error
          if (btn) {
            btn.disabled = false;
            btn.textContent = 'Check My Hand & Respond';
          }
        }
      }
    });

    // Back to lobby list button (game over)
    document.getElementById('back-to-lobby-btn')?.addEventListener('click', () => {
      this.dispatchEvent('navigate', { screen: 'lobby-list' });
    });

    // Skip draw button (deck empty) - ends turn without drawing
    document.getElementById('skip-draw-btn')?.addEventListener('click', async () => {
      const btn = document.getElementById('skip-draw-btn') as HTMLButtonElement;
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Ending turn...';
      }

      if (this.gameState) {
        try {
          // Call skipDrawDeckEmpty to end the turn when deck is empty
          const skipDrawResponse = await fetch('http://localhost:9999/api/midnight/skip_draw_deck_empty', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              lobby_id: this.lobbyId,
              player_id: this.gameState.playerId
            })
          });

          const skipDrawResult = await skipDrawResponse.json();

          if (skipDrawResult.success) {
            console.log('[GameScreen] Skip draw (deck empty) succeeded, turn ended');
            this.selectedRank = null;
            // State will update on next poll
          } else {
            console.error('[GameScreen] Skip draw failed:', skipDrawResult.errorMessage);
            alert(`Failed to end turn: ${skipDrawResult.errorMessage}`);
            if (btn) {
              btn.disabled = false;
              btn.textContent = 'End Turn';
            }
          }
        } catch (error) {
          console.error('[GameScreen] Skip draw failed:', error);
          alert('Failed to end turn. Please try again.');
          if (btn) {
            btn.disabled = false;
            btn.textContent = 'End Turn';
          }
        }
      }
    });
  }

  /**
   * Attach event listeners specific to the modal
   */
  private attachModalEventListeners() {
    // Modal close button
    document.getElementById('modal-close-btn')?.addEventListener('click', () => {
      this.closeActionModal();
    });

    // Close modal on overlay click
    document.getElementById('action-modal-overlay')?.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).id === 'action-modal-overlay') {
        this.closeActionModal();
      }
    });

    // Player selection in modal - update button states without re-rendering modal
    document.querySelectorAll('.player-select-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const playerId = target.dataset.playerId;
        if (playerId) {
          this.selectedTargetId = playerId;

          // Update button selected states without re-rendering
          document.querySelectorAll('.player-select-btn').forEach(b => {
            b.classList.remove('selected');
          });
          target.classList.add('selected');

          // Update ask button state
          const askBtn = document.getElementById('ask-btn') as HTMLButtonElement;
          if (askBtn) {
            askBtn.disabled = false;
            askBtn.textContent = `Ask for ${this.selectedRank}s`;
          }
        }
      });
    });

    // Ask action - now uses backend API
    document.getElementById('ask-btn')?.addEventListener('click', async () => {
      if (this.selectedRank && this.selectedTargetId && this.gameState) {
        try {
          // Convert rank string to number (0-indexed: A=0, 2=1, ..., K=12)
          // Contract uses 0-12 for ranks, matching the card index pattern
          const rankMap: Record<string, number> = {
            'A': 0, '2': 1, '3': 2, '4': 3, '5': 4, '6': 5, '7': 6,
            '8': 7, '9': 8, '10': 9, 'J': 10, 'Q': 11, 'K': 12
          };
          const targetRank = rankMap[this.selectedRank] ?? 0;

          const response = await fetch('http://localhost:9999/api/midnight/ask_for_card', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              lobby_id: this.lobbyId,
              player_id: this.gameState.playerId,
              rank: targetRank
            })
          });

          const result = await response.json();

          if (result.success) {
            console.log('[GameScreen] Ask for card succeeded');
            this.closeActionModal(); // Close modal and reset selections
            // State will update on next poll
          } else {
            alert(`Failed to ask for card: ${result.errorMessage}`);
          }
        } catch (error) {
          console.error('[GameScreen] Ask for card failed:', error);
          alert('Failed to ask for card. Please try again.');
        }
      }
    });
  }

  private dispatchEvent(type: string, detail: any) {
    this.container.dispatchEvent(new CustomEvent(type, { detail, bubbles: true }));
  }
}

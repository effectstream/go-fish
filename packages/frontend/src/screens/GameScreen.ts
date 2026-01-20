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
  private walletAddress: string | null = null;
  private myDecryptedHand: Array<{ rank: number; suit: number }> = [];
  private setupInProgress: boolean = false;
  private setupCompleted: boolean = false;
  private maskApplied: boolean = false;  // Track if we've applied mask (frontend-side cache)
  private cardsDealt: boolean = false;   // Track if we've dealt cards (frontend-side cache)

  constructor(container: HTMLElement, lobbyId: string) {
    this.container = container;
    this.lobbyId = lobbyId;
    this.gameService = GoFishGameService.getInstance();

    // Get wallet address from effectstream bridge
    this.walletAddress = getWalletAddress();
  }

  show() {
    this.render();
    // Poll every 3 seconds to reduce database pressure and prevent mutex deadlocks
    // The Paima sync process needs time to complete, and concurrent Midnight queries
    // can block the event loop causing sync protocols to timeout waiting for mutex
    this.refreshInterval = window.setInterval(() => this.render(), 3000);
  }

  hide() {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
    }
  }

  private async render() {
    // Fetch game state from API instead of local service
    if (!this.walletAddress) {
      this.container.innerHTML = '<div class="error">Wallet not connected</div>';
      return;
    }

    try {
      const response = await fetch(
        `http://localhost:9999/game_state?lobby_id=${this.lobbyId}&wallet=${this.walletAddress}`
      );

      if (!response.ok) {
        console.error('Failed to fetch game state:', response.status);
        this.dispatchEvent('navigate', { screen: 'lobby-list' });
        return;
      }

      this.gameState = await response.json();
    } catch (error) {
      console.error('Error fetching game state:', error);
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
    const myBooks = this.gameState.myBooks;
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
          console.log(`[GameScreen] Decrypted ${this.myDecryptedHand.length} cards from backend`);
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

    this.container.innerHTML = `
      <div class="game-screen">
        <!-- Main Game Area - 3 column layout -->
        <div class="game-content">
          <!-- Left Panel: Game Info + Your Hand -->
          <div class="left-panel">
            <div class="game-info-panel">
              <h1>🎣 Go Fish</h1>
              <div class="turn-indicator ${isMyTurn ? 'your-turn' : ''}">
                ${isMyTurn
                  ? '<strong>🎯 Your Turn!</strong>'
                  : `⏳ Waiting for ${currentTurnPlayer?.name || 'opponent'}...`
                }
              </div>
              <div class="game-stats">
                <div class="stat-item">🃏 Deck: ${this.gameState.deckCount} cards</div>
                <div class="stat-item">📊 You: ${myScore} books | Opponent: ${this.gameState.scores[this.gameState.playerId === 1 ? 1 : 0]} books</div>
              </div>
              <div class="player-books-section">
                <h4>Your Books (${myBooks.length})</h4>
                ${this.renderBooks(myBooks)}
              </div>
            </div>

            <!-- Your Hand -->
            <div class="player-hand-panel">
              <h3>Your Hand (${myHandSize} cards)</h3>
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

          <!-- Center Panel: Actions -->
          <div class="center-panel">
            ${this.renderCenterPanel(isMyTurn)}
          </div>

          <!-- Right Panel: Opponent + Game Log -->
          <div class="right-panel">
            <div class="opponent-panel">
              <h3>Opponent</h3>
              ${this.gameState.players
                .map((p: any, index: number) => ({ player: p, playerNum: index + 1 }))
                .filter(({ playerNum }) => playerNum !== this.gameState!.playerId)
                .map(({ player, playerNum }) => this.renderOpponentFromAPI(player, playerNum))
                .join('')
              }
            </div>

            <div class="game-log-panel">
              <h3>Game Log</h3>
              ${this.renderGameLogFromAPI()}
            </div>
          </div>
        </div>
      </div>
    `;

    this.attachEventListeners();
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

  private renderBooks(books: Rank[] | string[]): string {
    if (books.length === 0) {
      return '<div class="no-books">None yet</div>';
    }

    return `
      <div class="books-container">
        ${books.map(rank => CardComponent.renderBook(rank as Rank)).join('')}
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

    // Check if it's the player's turn to make cards clickable
    const isMyTurn = this.gameState?.currentTurn === this.gameState?.playerId;

    return cards
      .map(card => {
        const isSelected = this.selectedRank === card.rank;
        const clickableClass = isMyTurn ? 'clickable' : '';
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
      <div class="game-screen">
        <div class="game-header">
          <div class="game-info">
            <h1>🎣 Go Fish - Setup Phase</h1>
            <p>Initializing the Midnight contract for this game...</p>
          </div>
        </div>

        <div class="game-content" style="display: flex; align-items: center; justify-content: center;">
          <div style="max-width: 600px; padding: 2rem; background-color: rgba(0, 0, 0, 0.5); border-radius: 1rem; text-align: center;">
            <h2 style="margin-bottom: 1rem;">🎴 Game Setup</h2>
            <p style="margin-bottom: 2rem; opacity: 0.9;">
              Each player's secret cards are being initialized in the Midnight contract.
              This uses zero-knowledge proofs to ensure fair play - no one can see your cards!
            </p>

            <div style="margin: 2rem 0;">
              <div class="spinner" style="margin: 0 auto 1rem; width: 50px; height: 50px; border: 4px solid rgba(255,255,255,0.1); border-top-color: #fff; border-radius: 50%; animation: spin 1s linear infinite;"></div>
              <p style="font-size: 1.1rem; font-weight: 500;">
                ${statusMessage}
              </p>
            </div>

            <div style="margin-top: 2rem; padding: 1rem; background-color: rgba(255,255,255,0.05); border-radius: 0.5rem;">
              <p style="font-size: 0.9rem; opacity: 0.7;">
                Setup happens automatically. Once both players complete setup, the game will begin!
              </p>
            </div>
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

    return this.gameState.gameLog
      .slice(-10)
      .map(msg => `
        <div class="log-entry">
          ${msg}
        </div>
      `)
      .join('');
  }

  private attachEventListeners() {
    // Card selection - click on cards in your hand to select the rank
    document.querySelectorAll('.card-wrapper.clickable').forEach(wrapper => {
      wrapper.addEventListener('click', (e) => {
        const target = e.currentTarget as HTMLElement;
        const rank = target.dataset.rank as Rank;
        if (rank) {
          this.selectedRank = rank;
          this.render();
        }
      });
    });

    // Player selection
    document.querySelectorAll('.player-select-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const playerId = target.dataset.playerId;
        if (playerId) {
          this.selectedTargetId = playerId;
          this.render();
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
            this.selectedRank = null;
            this.selectedTargetId = null;
            console.log('[GameScreen] Ask for card succeeded');
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

    // Go Fish action - draw from deck and complete turn
    document.getElementById('go-fish-btn')?.addEventListener('click', async () => {
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

          if (this.selectedRank !== null) {
            // Convert selectedRank to number (ranks are 0-12 for A-K)
            const askedRankNum = this.selectedRank;

            // Find any new card by looking for cards in handAfter not in handBefore
            for (const cardAfter of handAfter) {
              const existsInBefore = handBefore.some(
                (cardBefore: {rank: number; suit: number}) =>
                  cardBefore.rank === cardAfter.rank && cardBefore.suit === cardAfter.suit
              );
              if (!existsInBefore) {
                // This is the new card - check if it matches the asked rank
                console.log(`[GameScreen] Drew card: rank=${cardAfter.rank}, suit=${cardAfter.suit}, asked for rank=${askedRankNum}`);
                if (cardAfter.rank === askedRankNum) {
                  drewRequestedCard = true;
                  console.log('[GameScreen] Drew the requested card! Player gets another turn.');
                }
                break;
              }
            }
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
        }
      }
    });

    // Respond to ask action - check hand and respond
    document.getElementById('respond-btn')?.addEventListener('click', async () => {
      if (this.gameState) {
        try {
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
            // State will update on next poll
          } else {
            alert(`Failed to respond: ${result.errorMessage}`);
          }
        } catch (error) {
          console.error('[GameScreen] Respond to ask failed:', error);
          alert('Failed to respond. Please try again.');
        }
      }
    });

    // Back to lobby list button (game over)
    document.getElementById('back-to-lobby-btn')?.addEventListener('click', () => {
      this.dispatchEvent('navigate', { screen: 'lobby-list' });
    });
  }

  private dispatchEvent(type: string, detail: any) {
    this.container.dispatchEvent(new CustomEvent(type, { detail, bubbles: true }));
  }
}

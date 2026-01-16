/**
 * Game Screen - Go Fish gameplay with card visuals
 */

import { GoFishGameService } from '../services/GoFishGameService';
import { CardComponent } from '../components/Card';
import type { GoFishGameState, GoFishPlayer, Rank } from '../../../shared/data-types/src/go-fish-types';
import { getUniqueRanks } from '../../../shared/data-types/src/go-fish-types';
import { getWalletAddress } from '../effectstreamBridge';

// Lazy load MidnightBridge to avoid blocking app startup
let MidnightBridge: any = null;
async function getMidnightBridge() {
  if (!MidnightBridge) {
    try {
      const module = await import('../midnightBridge');
      MidnightBridge = module.MidnightBridge;
    } catch (error) {
      console.error('[GameScreen] Failed to load MidnightBridge:', error);
      return null;
    }
  }
  return MidnightBridge;
}

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

  constructor(container: HTMLElement, lobbyId: string) {
    this.container = container;
    this.lobbyId = lobbyId;
    this.gameService = GoFishGameService.getInstance();

    // Get wallet address from effectstream bridge
    this.walletAddress = getWalletAddress();
  }

  show() {
    this.render();
    this.refreshInterval = window.setInterval(() => this.render(), 1000);
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

    const isMyTurn = this.gameState.currentTurn === this.gameState.playerId;
    const currentTurnPlayer = this.gameState.players[this.gameState.currentTurn - 1];
    const myHandSize = this.gameState.handSizes[this.gameState.playerId - 1];
    const myBooks = this.gameState.myBooks;
    const myScore = this.gameState.scores[this.gameState.playerId - 1];

    this.container.innerHTML = `
      <div class="game-screen">
        <!-- Game Header -->
        <div class="game-header">
          <div class="game-info">
            <h1>🎣 Go Fish</h1>
            <div class="turn-indicator">
              ${isMyTurn
                ? '<strong>🎯 Your Turn!</strong>'
                : `Waiting for ${currentTurnPlayer?.name || 'player'}...`
              }
            </div>
            <div class="deck-info">
              🃏 Deck: ${this.gameState.deckCount} cards remaining
            </div>
            <div class="scores-info">
              📊 Scores: You (${myScore}) | Opponent (${this.gameState.scores[this.gameState.playerId === 1 ? 1 : 0]})
            </div>
          </div>
          <div class="player-books-header">
            <h3>Your Books: ${myBooks.length}</h3>
            ${this.renderBooks(myBooks)}
          </div>
        </div>

        <!-- Main Game Area -->
        <div class="game-content">
          <!-- Opponents -->
          <div class="opponents-container">
            <h3>Opponents</h3>
            ${this.gameState.players
              .filter((_p: any, index: number) => index + 1 !== this.gameState!.playerId)
              .map((p: any, originalIndex: number) => this.renderOpponentFromAPI(p, originalIndex + 1))
              .join('')
            }
          </div>

          <!-- Your Hand -->
          <div class="player-area">
            <h3>Your Hand (${myHandSize} cards)</h3>
            ${myHandSize > 0
              ? `<div class="hand-info">Your hand is encrypted. In a full implementation, cards would be decrypted client-side.</div>
                 <div class="card-placeholders">
                   ${Array(myHandSize).fill(0).map(() => CardComponent.renderCardBack()).join('')}
                 </div>`
              : '<div class="empty-hand">No cards in hand</div>'
            }
          </div>

          <!-- Actions Panel -->
          ${isMyTurn ? this.renderActionPanelFromAPI() : this.renderWaitingPanel()}

          <!-- Game Log -->
          <div class="game-log">
            <h3>Game Log</h3>
            ${this.renderGameLogFromAPI()}
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

  private renderWaitingPanel(): string {
    return `
      <div class="ask-action-panel">
        <div class="waiting-indicator">
          <h3>⏳ Waiting for your turn...</h3>
          <p>Watch the game log to see what happens!</p>
        </div>
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

    return `
      <div class="ask-action-panel">
        <h3>Ask for a Card</h3>

        <div class="instruction-text">
          Select a rank to ask for (you must have it in your hand)
        </div>

        <div class="rank-selector">
          ${['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'].map(rank => `
            <button
              class="rank-btn ${this.selectedRank === rank ? 'selected' : ''}"
              data-rank="${rank}"
            >
              ${rank}
            </button>
          `).join('')}
        </div>

        <div class="instruction-text">
          Select which player to ask
        </div>

        <div class="player-selector">
          ${opponents.map((p: any, index: number) => {
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
          class="btn btn-primary"
          ${!this.selectedRank || !this.selectedTargetId ? 'disabled' : ''}
        >
          Ask for ${this.selectedRank || '?'} from ${this.selectedTargetId ? 'selected player' : '?'}
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
    // Rank selection
    document.querySelectorAll('.rank-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const rank = target.dataset.rank as Rank;
        this.selectedRank = rank;
        this.render();
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

    // Ask action - now uses Midnight bridge
    document.getElementById('ask-btn')?.addEventListener('click', async () => {
      if (this.selectedRank && this.selectedTargetId && this.gameState) {
        try {
          // Convert rank string to number (A=1, 2-10=2-10, J=11, Q=12, K=13)
          const rankMap: Record<string, number> = {
            'A': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7,
            '8': 8, '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13
          };
          const targetRank = rankMap[this.selectedRank] || 0;

          const bridge = await getMidnightBridge();
          if (!bridge) {
            alert('Midnight contract not available. Please refresh the page.');
            return;
          }

          const result = await bridge.askForCard(
            this.lobbyId,
            this.gameState.playerId as 1 | 2,
            targetRank
          );

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

    // Go Fish action - draw from deck
    document.getElementById('go-fish-btn')?.addEventListener('click', async () => {
      if (this.gameState) {
        try {
          const bridge = await getMidnightBridge();
          if (!bridge) {
            alert('Midnight contract not available. Please refresh the page.');
            return;
          }

          const result = await bridge.goFish(
            this.lobbyId,
            this.gameState.playerId as 1 | 2
          );

          if (result.success) {
            console.log('[GameScreen] Go Fish succeeded, drew card');
            // State will update on next poll
          } else {
            alert(`Failed to draw card: ${result.errorMessage}`);
          }
        } catch (error) {
          console.error('[GameScreen] Go Fish failed:', error);
          alert('Failed to draw card. Please try again.');
        }
      }
    });
  }

  private dispatchEvent(type: string, detail: any) {
    this.container.dispatchEvent(new CustomEvent(type, { detail, bubbles: true }));
  }
}

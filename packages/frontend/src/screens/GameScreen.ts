/**
 * Game Screen - Go Fish gameplay with card visuals
 */

import { GoFishGameService } from '../services/GoFishGameService';
import { CardComponent } from '../components/Card';
import type { GoFishGameState, GoFishPlayer, Rank } from '../../../shared/data-types/src/go-fish-types';
import { getUniqueRanks } from '../../../shared/data-types/src/go-fish-types';

export class GameScreen {
  private container: HTMLElement;
  private gameService: GoFishGameService;
  private lobbyId: string;
  private refreshInterval?: number;
  private selectedRank: Rank | null = null;
  private selectedTargetId: string | null = null;

  constructor(container: HTMLElement, lobbyId: string) {
    this.container = container;
    this.lobbyId = lobbyId;
    this.gameService = GoFishGameService.getInstance();
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

  private render() {
    const game = this.gameService.getGameState(this.lobbyId);
    const currentPlayer = this.gameService.getCurrentPlayer(this.lobbyId);

    if (!game) {
      this.dispatchEvent('navigate', { screen: 'lobby-list' });
      return;
    }

    if (game.phase === 'finished') {
      this.dispatchEvent('navigate', { screen: 'results', lobbyId: this.lobbyId });
      return;
    }

    const isMyTurn = this.gameService.isMyTurn(this.lobbyId);
    const currentTurnPlayer = this.gameService.getCurrentTurnPlayer(this.lobbyId);

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
              🃏 Deck: ${game.deckCount} cards
            </div>
          </div>
          <div class="player-books-header">
            <h3>Your Books: ${currentPlayer?.books.length || 0}</h3>
            ${this.renderBooks(currentPlayer?.books || [])}
          </div>
        </div>

        <!-- Main Game Area -->
        <div class="game-content">
          <!-- Opponents -->
          <div class="opponents-container">
            <h3>Opponents</h3>
            ${game.players
              .filter(p => p.id !== this.gameService.getPlayerId())
              .map(p => this.renderOpponent(p, game))
              .join('')
            }
          </div>

          <!-- Your Hand -->
          <div class="player-area">
            <h3>Your Hand (${currentPlayer?.hand.length || 0} cards)</h3>
            ${currentPlayer && currentPlayer.hand.length > 0
              ? CardComponent.renderHand(currentPlayer.hand, true, false)
              : '<div class="empty-hand">No cards in hand</div>'
            }
          </div>

          <!-- Actions Panel -->
          ${isMyTurn ? this.renderActionPanel(game, currentPlayer!) : this.renderWaitingPanel()}

          <!-- Game Log -->
          <div class="game-log">
            <h3>Game Log</h3>
            ${this.renderGameLog()}
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

  private renderBooks(books: Rank[]): string {
    if (books.length === 0) {
      return '<div class="no-books">None yet</div>';
    }

    return `
      <div class="books-container">
        ${books.map(rank => CardComponent.renderBook(rank)).join('')}
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

    // Ask action
    document.getElementById('ask-btn')?.addEventListener('click', () => {
      if (this.selectedRank && this.selectedTargetId) {
        const success = this.gameService.askForCard(
          this.lobbyId,
          this.selectedTargetId,
          this.selectedRank
        );

        if (success) {
          this.selectedRank = null;
          this.selectedTargetId = null;
          this.render();
        } else {
          alert('Failed to ask for card. Make sure you have that rank in your hand.');
        }
      }
    });
  }

  private dispatchEvent(type: string, detail: any) {
    this.container.dispatchEvent(new CustomEvent(type, { detail, bubbles: true }));
  }
}

/**
 * ResultsScreen - Shows Go Fish game results and statistics
 */

import type { GoFishGameState, GoFishPlayer } from '../../../shared/data-types/src/go-fish-types';
import { GoFishGameService } from '../services/GoFishGameService';
import { CardComponent } from '../components/Card';

export class ResultsScreen {
  private gameService: GoFishGameService;
  private container: HTMLElement;
  private lobbyId: string = '';

  constructor(container: HTMLElement) {
    this.container = container;
    this.gameService = GoFishGameService.getInstance();
  }

  show(lobbyId: string) {
    this.lobbyId = lobbyId;
    this.render();
  }

  hide() {
    // Clear any intervals if needed
  }

  private render() {
    const game = this.gameService.getGameState(this.lobbyId);
    if (!game) {
      this.container.innerHTML = '<div class="error">Game not found</div>';
      return;
    }

    const html = `
      <div class="results-screen">
        ${this.renderResultsBanner(game)}
        ${this.renderPlayerStats(game)}
        ${this.renderGameSummary(game)}
        ${this.renderActions()}
      </div>
    `;

    this.container.innerHTML = html;
    this.attachEventListeners();
  }

  private renderResultsBanner(game: GoFishGameState): string {
    const winner = game.players.find(p => p.id === game.winner);
    const currentPlayer = this.gameService.getCurrentPlayer(this.lobbyId);
    const isWinner = currentPlayer?.id === game.winner;

    return `
      <div class="results-banner ${isWinner ? 'victory' : 'defeat'}">
        <div class="winner-announcement">
          <h1>🎣 Game Over!</h1>
          <div class="result-subtitle">
            ${winner ? `${winner.name} wins with ${winner.books.length} books!` : 'Game ended'}
          </div>
          <div class="player-result ${isWinner ? 'victory' : 'defeat'}">
            ${isWinner ? '🏆 Victory!' : '😔 Better luck next time!'}
          </div>
        </div>
      </div>
    `;
  }

  private renderPlayerStats(game: GoFishGameState): string {
    // Sort players by number of books (descending)
    const sortedPlayers = [...game.players].sort((a, b) => b.books.length - a.books.length);

    return `
      <div class="player-stats">
        <div class="stats-section">
          <h2>Final Standings</h2>
          <div class="player-list">
            ${sortedPlayers.map((player, index) => this.renderPlayerCard(player, index + 1, game)).join('')}
          </div>
        </div>
      </div>
    `;
  }

  private renderPlayerCard(player: GoFishPlayer, rank: number, game: GoFishGameState): string {
    const isWinner = player.id === game.winner;
    const currentPlayerId = this.gameService.getPlayerId();
    const isCurrentPlayer = player.id === currentPlayerId;

    return `
      <div class="player-card ${isWinner ? 'winner-card' : ''}">
        <div class="player-rank">
          ${rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `#${rank}`}
        </div>
        <div class="player-info">
          <div class="player-name">
            ${player.name} ${isCurrentPlayer ? '(You)' : ''}
          </div>
          <div class="player-books-result">
            <strong>${player.books.length}</strong> ${player.books.length === 1 ? 'Book' : 'Books'}
          </div>
          <div class="books-display">
            ${player.books.map(rank => CardComponent.renderBook(rank)).join('')}
          </div>
        </div>
      </div>
    `;
  }

  private renderGameSummary(game: GoFishGameState): string {
    const duration = game.endedAt && game.startedAt
      ? Math.floor((game.endedAt - game.startedAt) / 1000 / 60)
      : 0;

    const totalBooks = game.players.reduce((sum, p) => sum + p.books.length, 0);
    const avgBooks = (totalBooks / game.players.length).toFixed(1);

    return `
      <div class="game-summary">
        <h2>Game Statistics</h2>
        <div class="summary-stats">
          <div class="stat-item">
            <span class="stat-label">Duration</span>
            <span class="stat-value">${duration} min</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">Total Players</span>
            <span class="stat-value">${game.players.length}</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">Total Books</span>
            <span class="stat-value">${totalBooks}</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">Avg Books/Player</span>
            <span class="stat-value">${avgBooks}</span>
          </div>
        </div>
      </div>
    `;
  }

  private renderActions(): string {
    return `
      <div class="results-actions">
        <button id="return-to-lobby-btn" class="btn btn-primary">Return to Lobby List</button>
      </div>
    `;
  }

  private attachEventListeners() {
    document.getElementById('return-to-lobby-btn')?.addEventListener('click', () => {
      this.dispatchEvent('navigate', { screen: 'lobby-list' });
    });
  }

  private dispatchEvent(type: string, detail: any) {
    this.container.dispatchEvent(new CustomEvent(type, { detail, bubbles: true }));
  }
}

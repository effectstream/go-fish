/**
 * ResultsScreen - Shows game results and statistics
 */

import type { GameState, Player } from '../../../shared/data-types/src/game-types';
import { GameService } from '../services/GameService';

export class ResultsScreen {
  private gameService: GameService;
  private container: HTMLElement;
  private lobbyId: string = '';

  constructor(container: HTMLElement) {
    this.container = container;
    this.gameService = GameService.getInstance();
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

  private renderResultsBanner(game: GameState): string {
    const winner = game.winner;
    const isWinner = winner === 'werewolves'
      ? 'werewolf'
      : winner === 'villagers'
      ? ['villager', 'seer', 'doctor']
      : [];

    const currentPlayer = this.gameService.getCurrentPlayer(this.lobbyId);
    const playerWon = currentPlayer && Array.isArray(isWinner)
      ? isWinner.includes(currentPlayer.role || '')
      : currentPlayer?.role === isWinner;

    return `
      <div class="results-banner ${winner}">
        <div class="winner-announcement">
          <h1>${winner === 'werewolves' ? '🐺 Werewolves Win!' : '🏘️ Villagers Win!'}</h1>
          <p class="result-subtitle">
            ${winner === 'werewolves'
              ? 'The werewolves have overrun the village!'
              : 'The village has eliminated all werewolves!'}
          </p>
          ${currentPlayer ? `
            <div class="player-result ${playerWon ? 'victory' : 'defeat'}">
              ${playerWon ? '🎉 Victory!' : '💀 Defeat'}
            </div>
          ` : ''}
        </div>
      </div>
    `;
  }

  private renderPlayerStats(game: GameState): string {
    const survivors = game.players.filter(p => p.isAlive);
    const eliminated = game.players.filter(p => !p.isAlive);

    return `
      <div class="player-stats">
        <div class="stats-section">
          <h2>👥 Survivors (${survivors.length})</h2>
          <div class="player-list">
            ${survivors.map(player => this.renderPlayerCard(player, true)).join('')}
          </div>
        </div>

        ${eliminated.length > 0 ? `
          <div class="stats-section">
            <h2>💀 Eliminated (${eliminated.length})</h2>
            <div class="player-list">
              ${eliminated.map(player => this.renderPlayerCard(player, false)).join('')}
            </div>
          </div>
        ` : ''}
      </div>
    `;
  }

  private renderPlayerCard(player: Player, isAlive: boolean): string {
    const roleEmoji = {
      werewolf: '🐺',
      villager: '👤',
      seer: '🔮',
      doctor: '⚕️',
    };

    const roleColors = {
      werewolf: '#d32f2f',
      villager: '#1976d2',
      seer: '#7b1fa2',
      doctor: '#388e3c',
    };

    return `
      <div class="player-card ${isAlive ? 'alive' : 'eliminated'}">
        <div class="player-avatar" style="background-color: ${roleColors[player.role || 'villager']}">
          ${roleEmoji[player.role || 'villager']}
        </div>
        <div class="player-info">
          <div class="player-name">${player.name}</div>
          <div class="player-role" style="color: ${roleColors[player.role || 'villager']}">
            ${player.role ? player.role.charAt(0).toUpperCase() + player.role.slice(1) : 'Unknown'}
          </div>
        </div>
      </div>
    `;
  }

  private renderGameSummary(game: GameState): string {
    const duration = game.endedAt && game.startedAt
      ? Math.floor((game.endedAt - game.startedAt) / 1000)
      : 0;

    const minutes = Math.floor(duration / 60);
    const seconds = duration % 60;

    return `
      <div class="game-summary">
        <h2>📊 Game Summary</h2>
        <div class="summary-stats">
          <div class="stat-item">
            <span class="stat-label">Total Rounds:</span>
            <span class="stat-value">${game.round}</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">Duration:</span>
            <span class="stat-value">${minutes}m ${seconds}s</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">Total Players:</span>
            <span class="stat-value">${game.players.length}</span>
          </div>
        </div>
      </div>
    `;
  }

  private renderActions(): string {
    return `
      <div class="results-actions">
        <button class="btn btn-primary" id="return-lobby-btn">
          Return to Lobby List
        </button>
      </div>
    `;
  }

  private attachEventListeners() {
    const returnBtn = document.getElementById('return-lobby-btn');
    if (returnBtn) {
      returnBtn.addEventListener('click', () => {
        this.dispatchEvent('navigate', { screen: 'lobby-list' });
      });
    }
  }

  private dispatchEvent(eventType: string, detail: any) {
    const event = new CustomEvent(eventType, { detail });
    this.container.dispatchEvent(event);
  }
}

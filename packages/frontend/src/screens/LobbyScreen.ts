/**
 * Lobby Screen - Waiting room before game starts
 */

import { GoFishGameService } from '../services/GoFishGameService';
import type { GoFishGameState, GoFishPlayer } from '../../../shared/data-types/src/go-fish-types';

export class LobbyScreen {
  private container: HTMLElement;
  private gameService: GoFishGameService;
  private lobbyId: string = '';
  private refreshInterval?: number;

  constructor(container: HTMLElement) {
    this.container = container;
    this.gameService = GoFishGameService.getInstance();
  }

  show(lobbyId: string) {
    this.lobbyId = lobbyId;
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
    const lobby = this.gameService.getLobby(this.lobbyId);
    const currentPlayer = this.gameService.getCurrentPlayer(this.lobbyId);

    if (!game || !lobby) {
      this.dispatchEvent('navigate', { screen: 'lobby-list' });
      return;
    }

    // If game started, navigate to game screen
    if (game.status === 'in_progress') {
      this.dispatchEvent('navigate', { screen: 'game', lobbyId: this.lobbyId });
      return;
    }

    const isHost = game.hostId === this.gameService.getPlayerId();
    const canStart = this.gameService.canStartGame(this.lobbyId);

    this.container.innerHTML = `
      <div class="lobby-screen">
        <div class="lobby-header">
          <h1>🎣 ${lobby.name}</h1>
          <button id="leave-lobby-btn" class="btn btn-secondary">Leave Lobby</button>
        </div>

        <div class="lobby-content">
          <!-- Players Panel -->
          <div class="players-panel full-width">
            <h2>Players (${game.players.length}/${game.maxPlayers})</h2>
            <div class="players-list">
              ${game.players.map(p => this.renderPlayer(p, game)).join('')}
            </div>

            ${!isHost ? `
              <div class="ready-section">
                <button id="toggle-ready-btn" class="btn ${currentPlayer?.isReady ? 'btn-secondary' : 'btn-primary'}">
                  ${currentPlayer?.isReady ? 'Not Ready' : 'Ready Up!'}
                </button>
              </div>
            ` : ''}

            ${isHost ? `
              <div class="host-section">
                <p class="info-text">
                  ${canStart
                    ? 'All players are ready!'
                    : `Need ${game.players.length < 2 ? (2 - game.players.length) + ' more player(s) and ' : ''}all players to ready up`
                  }
                </p>
                <button
                  id="start-game-btn"
                  class="btn btn-primary"
                  ${!canStart ? 'disabled' : ''}
                >
                  Start Game
                </button>
              </div>
            ` : ''}
          </div>
        </div>

        <!-- Game Rules -->
        <div class="game-rules">
          <h3>How to Play Go Fish</h3>
          <ul>
            <li><strong>Objective</strong>: Collect the most "books" (sets of 4 cards of the same rank)</li>
            <li><strong>Your Turn</strong>: Ask any player for cards of a specific rank you have in your hand</li>
            <li><strong>Success</strong>: If they have cards of that rank, they give them all to you and you go again</li>
            <li><strong>Go Fish!</strong>: If they don't have any, you draw a card from the deck</li>
            <li><strong>Books</strong>: When you collect all 4 cards of a rank, they automatically form a book</li>
            <li><strong>Winning</strong>: The player with the most books when the deck runs out wins!</li>
          </ul>
        </div>
      </div>
    `;

    this.attachEventListeners();
  }

  private renderPlayer(player: GoFishPlayer, game: GoFishGameState): string {
    const isHost = player.id === game.hostId;
    const isCurrentPlayer = player.id === this.gameService.getPlayerId();

    return `
      <div class="player-item ${isCurrentPlayer ? 'current-player' : ''}">
        <span class="player-name">
          ${player.name}
          ${isHost ? '<span class="badge host">Host</span>' : ''}
          ${isCurrentPlayer ? '<span class="badge you">You</span>' : ''}
        </span>
        <span class="player-status ${player.isReady ? 'ready' : ''}">
          ${player.isReady ? '✓ Ready' : '○ Not Ready'}
        </span>
      </div>
    `;
  }

  private attachEventListeners() {
    // Leave lobby
    document.getElementById('leave-lobby-btn')?.addEventListener('click', () => {
      this.gameService.leaveLobby(this.lobbyId);
      this.dispatchEvent('navigate', { screen: 'lobby-list' });
    });

    // Ready toggle
    document.getElementById('toggle-ready-btn')?.addEventListener('click', () => {
      this.gameService.toggleReady(this.lobbyId);
      this.render();
    });

    // Start game
    document.getElementById('start-game-btn')?.addEventListener('click', () => {
      const success = this.gameService.startGame(this.lobbyId);
      if (success) {
        this.dispatchEvent('navigate', { screen: 'game', lobbyId: this.lobbyId });
      }
    });
  }

  private dispatchEvent(type: string, detail: any) {
    this.container.dispatchEvent(new CustomEvent(type, { detail, bubbles: true }));
  }
}

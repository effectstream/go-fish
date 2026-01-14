/**
 * Lobby Screen - Waiting room before game starts
 */

import { GoFishGameService } from '../services/GoFishGameService';
import type { GoFishGameState, GoFishPlayer } from '../../../shared/data-types/src/go-fish-types';
import * as EffectstreamBridge from '../effectstreamBridge';

export class LobbyScreen {
  private container: HTMLElement;
  private gameService: GoFishGameService;
  private lobbyId: string = '';
  private refreshInterval?: number;

  constructor(container: HTMLElement) {
    this.container = container;
    this.gameService = GoFishGameService.getInstance();
  }

  async show(lobbyId: string) {
    this.lobbyId = lobbyId;
    await this.render();
    this.refreshInterval = window.setInterval(() => this.render(), 1000);
  }

  hide() {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
    }
  }

  private async render() {
    // Fetch lobby state from API
    const response = await fetch(`http://localhost:9999/lobby_state?lobby_id=${this.lobbyId}`);
    if (!response.ok) {
      console.error('Failed to fetch lobby state');
      this.dispatchEvent('navigate', { screen: 'lobby-list' });
      return;
    }

    const lobbyData = await response.json();
    if (!lobbyData) {
      this.dispatchEvent('navigate', { screen: 'lobby-list' });
      return;
    }

    // Extract data from API response
    const players = lobbyData.players || [];
    const playerCount = players.length;
    const maxPlayers = lobbyData.max_players;
    const hostAccountId = lobbyData.host_account_id;
    const lobbyName = lobbyData.lobby_name;
    const status = lobbyData.status;

    // If game started, navigate to game screen
    if (status === 'in_progress') {
      this.dispatchEvent('navigate', { screen: 'game', lobbyId: this.lobbyId });
      return;
    }

    // Find current player
    const myWalletAddress = this.gameService.getPlayerId();
    const currentPlayer = players.find((p: any) => p.wallet_address.toLowerCase() === myWalletAddress.toLowerCase());

    // Check if current user is host (compare account IDs)
    const isHost = currentPlayer && currentPlayer.account_id === hostAccountId;

    // Check if all players are ready and there are at least 2 players
    const allReady = playerCount >= 2 && players.every((p: any) => p.is_ready || p.account_id === hostAccountId);

    this.container.innerHTML = `
      <div class="lobby-screen">
        <div class="lobby-header">
          <h1>🎣 ${lobbyName}</h1>
          <button id="leave-lobby-btn" class="btn btn-secondary">Leave Lobby</button>
        </div>

        <div class="lobby-content">
          <!-- Players Panel -->
          <div class="players-panel full-width">
            <h2>Players (${playerCount}/${maxPlayers})</h2>
            <div class="players-list">
              ${players.map((p: any) => this.renderPlayerFromAPI(p, hostAccountId, myWalletAddress)).join('')}
            </div>

            ${!isHost ? `
              <div class="ready-section">
                <button id="toggle-ready-btn" class="btn ${currentPlayer?.is_ready ? 'btn-secondary' : 'btn-primary'}">
                  ${currentPlayer?.is_ready ? 'Not Ready' : 'Ready Up!'}
                </button>
              </div>
            ` : ''}

            ${isHost ? `
              <div class="host-section">
                <p class="info-text">
                  ${allReady
                    ? 'All players are ready!'
                    : `Need ${playerCount < 2 ? (2 - playerCount) + ' more player(s) and ' : ''}all players to ready up`
                  }
                </p>
                <button
                  id="start-game-btn"
                  class="btn btn-primary"
                  ${!allReady ? 'disabled' : ''}
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

  private renderPlayerFromAPI(player: any, hostAccountId: number, myWalletAddress: string): string {
    const isHost = player.account_id === hostAccountId;
    const isCurrentPlayer = player.wallet_address.toLowerCase() === myWalletAddress.toLowerCase();

    return `
      <div class="player-item ${isCurrentPlayer ? 'current-player' : ''}">
        <span class="player-name">
          ${player.player_name}
          ${isHost ? '<span class="badge host">Host</span>' : ''}
          ${isCurrentPlayer ? '<span class="badge you">You</span>' : ''}
        </span>
        <span class="player-status ${player.is_ready ? 'ready' : ''}">
          ${player.is_ready ? '✓ Ready' : '○ Not Ready'}
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
    document.getElementById('toggle-ready-btn')?.addEventListener('click', async () => {
      const result = await EffectstreamBridge.toggleReady(this.lobbyId);
      if (!result.success) {
        console.error('Failed to toggle ready:', result.errorMessage);
        alert('Failed to toggle ready status. Please try again.');
      }
      // State will update automatically via the refresh interval
    });

    // Start game
    document.getElementById('start-game-btn')?.addEventListener('click', async () => {
      const result = await EffectstreamBridge.startGame(this.lobbyId);
      if (result.success) {
        // Game started - the lobby status will update to 'in_progress'
        // and the screen will automatically navigate when it refreshes
        console.log('Game started successfully');
      } else {
        console.error('Failed to start game:', result.errorMessage);
        alert('Failed to start game. Please try again.');
      }
    });
  }

  private dispatchEvent(type: string, detail: any) {
    this.container.dispatchEvent(new CustomEvent(type, { detail, bubbles: true }));
  }
}

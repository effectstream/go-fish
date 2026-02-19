/**
 * Lobby Screen - Waiting room before game starts
 */

import { GoFishGameService } from '../services/GoFishGameService';
import type { GoFishGameState, GoFishPlayer } from '../../../shared/data-types/src/go-fish-types';
import * as EffectstreamBridge from '../effectstreamBridge';

// Type for lobby state response
interface LobbyStateResponse {
  players: Array<{
    wallet_address: string;
    account_id: number;
    player_name: string;
    is_ready: boolean;
  }>;
  max_players: number;
  host_account_id: number;
  lobby_name: string;
  status: string;
}

export class LobbyScreen {
  private container: HTMLElement;
  private gameService: GoFishGameService;
  private lobbyId: string = '';
  private refreshInterval?: number;
  private previousLobbyState: LobbyStateResponse | null = null;
  private hasRenderedOnce: boolean = false;

  // Track pending transactions to prevent UI updates while processing
  private pendingReady: boolean = false;
  private _pendingLeave: boolean = false;
  private _pendingStart: boolean = false;

  constructor(container: HTMLElement) {
    this.container = container;
    this.gameService = GoFishGameService.getInstance();
  }

  async show(lobbyId: string) {
    this.lobbyId = lobbyId;
    this.hasRenderedOnce = false;
    this.previousLobbyState = null;
    await this.render();
    // Poll every 3 seconds to reduce database pressure
    // This prevents mutex deadlocks during block processing and Midnight queries
    this.refreshInterval = window.setInterval(() => this.render(), 3000);
  }

  hide() {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
    }
  }

  private async render() {
    // Fetch lobby state from API
    const { API_BASE_URL } = await import('../apiConfig');
    const response = await fetch(`${API_BASE_URL}/lobby_state?lobby_id=${this.lobbyId}`);
    if (!response.ok) {
      console.error('Failed to fetch lobby state');
      this.dispatchEvent('navigate', { screen: 'lobby-list' });
      return;
    }

    const lobbyData: LobbyStateResponse = await response.json();
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

    // Check if we need a full render or can do selective updates
    if (!this.hasRenderedOnce || this.needsFullRender(lobbyData)) {
      this.fullRender(players, playerCount, maxPlayers, hostAccountId, lobbyName, currentPlayer, isHost ?? false, allReady);
      this.hasRenderedOnce = true;
    } else {
      this.selectiveUpdate(players, playerCount, maxPlayers, hostAccountId, currentPlayer, isHost ?? false, allReady);
    }

    // Store for comparison on next render
    this.previousLobbyState = lobbyData;
  }

  /**
   * Check if state changes require a full re-render
   */
  private needsFullRender(currentState: LobbyStateResponse): boolean {
    if (!this.previousLobbyState) return true;

    // Full render needed if player count changed
    if (this.previousLobbyState.players.length !== currentState.players.length) return true;

    // Full render needed if host status changed (shouldn't happen but just in case)
    if (this.previousLobbyState.host_account_id !== currentState.host_account_id) return true;

    return false;
  }

  /**
   * Perform a full DOM render
   */
  private fullRender(
    players: any[],
    playerCount: number,
    maxPlayers: number,
    hostAccountId: number,
    lobbyName: string,
    currentPlayer: any,
    isHost: boolean,
    allReady: boolean
  ) {
    const myWalletAddress = this.gameService.getPlayerId();

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

  /**
   * Perform selective DOM updates (preserves existing DOM structure)
   */
  private selectiveUpdate(
    players: any[],
    playerCount: number,
    maxPlayers: number,
    hostAccountId: number,
    currentPlayer: any,
    isHost: boolean,
    allReady: boolean
  ) {
    const myWalletAddress = this.gameService.getPlayerId();

    // Update player count header
    const playersHeader = this.container.querySelector('.players-panel h2');
    if (playersHeader) {
      playersHeader.textContent = `Players (${playerCount}/${maxPlayers})`;
    }

    // Update players list
    const playersList = this.container.querySelector('.players-list');
    if (playersList) {
      playersList.innerHTML = players.map((p: any) => this.renderPlayerFromAPI(p, hostAccountId, myWalletAddress)).join('');
    }

    // Update ready button state
    const readyBtn = document.getElementById('toggle-ready-btn') as HTMLButtonElement;
    if (readyBtn && !isHost) {
      // Check if ready state changed from previous (transaction completed)
      if (this.pendingReady && this.previousLobbyState) {
        const prevPlayer = this.previousLobbyState.players.find(
          (p: any) => p.wallet_address.toLowerCase() === myWalletAddress.toLowerCase()
        );
        if (prevPlayer && prevPlayer.is_ready !== currentPlayer?.is_ready) {
          // State changed - transaction completed
          this.pendingReady = false;
        }
      }

      // Only update button if not pending
      if (!this.pendingReady) {
        readyBtn.className = `btn ${currentPlayer?.is_ready ? 'btn-secondary' : 'btn-primary'}`;
        readyBtn.textContent = currentPlayer?.is_ready ? 'Not Ready' : 'Ready Up!';
        readyBtn.disabled = false;
      }
    }

    // Update host section info text
    if (isHost) {
      const infoText = this.container.querySelector('.host-section .info-text');
      if (infoText) {
        infoText.textContent = allReady
          ? 'All players are ready!'
          : `Need ${playerCount < 2 ? (2 - playerCount) + ' more player(s) and ' : ''}all players to ready up`;
      }

      const startBtn = document.getElementById('start-game-btn') as HTMLButtonElement;
      if (startBtn) {
        startBtn.disabled = !allReady;
      }
    }
  }

  private _renderPlayer(player: GoFishPlayer, game: GoFishGameState): string {
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
    document.getElementById('leave-lobby-btn')?.addEventListener('click', async () => {
      const btn = document.getElementById('leave-lobby-btn') as HTMLButtonElement;
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Leaving...';
      }
      this._pendingLeave = true;

      try {
        const result = await this.gameService.leaveLobby(this.lobbyId);
        if (result) {
          this.dispatchEvent('navigate', { screen: 'lobby-list' });
        } else {
          console.error('Failed to leave lobby');
          alert('Failed to leave lobby. Please try again.');
          if (btn) {
            btn.disabled = false;
            btn.textContent = 'Leave Lobby';
          }
        }
      } catch (error) {
        console.error('Error leaving lobby:', error);
        alert('Failed to leave lobby. Please try again.');
        if (btn) {
          btn.disabled = false;
          btn.textContent = 'Leave Lobby';
        }
      } finally {
        this._pendingLeave = false;
      }
    });

    // Ready toggle
    document.getElementById('toggle-ready-btn')?.addEventListener('click', async () => {
      const btn = document.getElementById('toggle-ready-btn') as HTMLButtonElement;
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Processing...';
      }
      this.pendingReady = true;

      try {
        const result = await EffectstreamBridge.toggleReady(this.lobbyId);
        if (!result.success) {
          console.error('Failed to toggle ready:', result.errorMessage);
          alert('Failed to toggle ready status. Please try again.');
          // Re-enable button on error
          if (btn) {
            btn.disabled = false;
            btn.textContent = 'Ready Up!';
          }
          this.pendingReady = false;
        }
        // On success, pendingReady stays true until the next render detects the state change
        // Then selectiveUpdate will re-enable the button with the correct text
      } catch (error) {
        console.error('Error toggling ready:', error);
        if (btn) {
          btn.disabled = false;
          btn.textContent = 'Ready Up!';
        }
        this.pendingReady = false;
      }
    });

    // Start game
    document.getElementById('start-game-btn')?.addEventListener('click', async () => {
      const btn = document.getElementById('start-game-btn') as HTMLButtonElement;
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Starting...';
      }
      this._pendingStart = true;

      try {
        const result = await EffectstreamBridge.startGame(this.lobbyId);
        if (result.success) {
          // Game started - the lobby status will update to 'in_progress'
          // and the screen will automatically navigate when it refreshes
          console.log('Game started successfully');
          // Keep pendingStart true - we'll navigate away soon
        } else {
          console.error('Failed to start game:', result.errorMessage);
          alert('Failed to start game. Please try again.');
          // Re-enable button on error
          if (btn) {
            btn.disabled = false;
            btn.textContent = 'Start Game';
          }
          this._pendingStart = false;
        }
      } catch (error) {
        console.error('Error starting game:', error);
        if (btn) {
          btn.disabled = false;
          btn.textContent = 'Start Game';
        }
        this._pendingStart = false;
      }
    });
  }

  private dispatchEvent(type: string, detail: any) {
    this.container.dispatchEvent(new CustomEvent(type, { detail, bubbles: true }));
  }
}

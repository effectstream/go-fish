/**
 * Lobby List Screen - Shows available lobbies and create lobby option
 */

import { GoFishGameService } from '../services/GoFishGameService';
import type { Lobby } from '../../../shared/data-types/src/go-fish-types';

export class LobbyListScreen {
  private container: HTMLElement;
  private gameService: GoFishGameService;
  private refreshInterval?: number;

  constructor(container: HTMLElement) {
    this.container = container;
    this.gameService = GoFishGameService.getInstance();
  }

  show() {
    this.render();
    // Refresh lobby list every 2 seconds
    this.refreshInterval = window.setInterval(() => this.render(), 2000);
  }

  hide() {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
    }
  }

  private render() {
    const lobbies = this.gameService.getLobbies();

    // Check if modal is open - if so, don't re-render
    const existingModal = document.getElementById('create-lobby-modal') as HTMLElement;
    const isModalOpen = existingModal && existingModal.style.display !== 'none';
    if (isModalOpen) {
      // Just update the lobby list without full re-render
      const lobbyListEl = document.querySelector('.lobby-list');
      if (lobbyListEl) {
        lobbyListEl.innerHTML = lobbies.length === 0
          ? '<div class="empty-state">No lobbies available. Create one!</div>'
          : lobbies.map(lobby => this.renderLobby(lobby)).join('');

        // Reattach join button listeners
        document.querySelectorAll('.join-btn').forEach(btn => {
          btn.addEventListener('click', (e) => {
            const target = e.target as HTMLElement;
            const lobbyId = target.dataset.lobbyId;
            if (lobbyId) {
              this.joinLobby(lobbyId);
            }
          });
        });
      }
      return;
    }

    // Store current input value, focus state, and cursor position before re-render
    const nameInput = document.getElementById('player-name') as HTMLInputElement;
    const currentValue = nameInput?.value || this.gameService.getPlayerName();
    const isFocused = document.activeElement === nameInput;
    const cursorStart = nameInput?.selectionStart || 0;
    const cursorEnd = nameInput?.selectionEnd || 0;

    this.container.innerHTML = `
      <div class="lobby-list-screen">
        <h1 class="title">🎣 Go Fish Game</h1>

        <div class="player-info">
          <label>Your Name:</label>
          <input
            type="text"
            id="player-name"
            value="${currentValue}"
            placeholder="Enter your name"
            maxlength="20"
          />
        </div>

        <div class="actions">
          <button id="create-lobby-btn" class="btn btn-primary">Create New Lobby</button>
          <button id="refresh-btn" class="btn btn-secondary">Refresh</button>
        </div>

        <h2>Available Lobbies (${lobbies.length})</h2>

        <div class="lobby-list">
          ${lobbies.length === 0
            ? '<div class="empty-state">No lobbies available. Create one!</div>'
            : lobbies.map(lobby => this.renderLobby(lobby)).join('')
          }
        </div>

        <!-- Create Lobby Modal -->
        <div id="create-lobby-modal" class="modal" style="display: none;">
          <div class="modal-content">
            <h2>Create New Lobby</h2>
            <div class="form-group">
              <label>Lobby Name:</label>
              <input type="text" id="lobby-name" placeholder="Enter lobby name" maxlength="30"/>
            </div>
            <div class="form-group">
              <label>Max Players:</label>
              <select id="max-players">
                <option value="2">2 Players</option>
                <option value="3">3 Players</option>
                <option value="4" selected>4 Players</option>
                <option value="5">5 Players</option>
                <option value="6">6 Players</option>
              </select>
            </div>
            <div class="modal-actions">
              <button id="confirm-create-btn" class="btn btn-primary">Create</button>
              <button id="cancel-create-btn" class="btn btn-secondary">Cancel</button>
            </div>
          </div>
        </div>
      </div>
    `;

    // Restore focus and cursor position if it was focused before
    if (isFocused) {
      const newNameInput = document.getElementById('player-name') as HTMLInputElement;
      if (newNameInput) {
        newNameInput.focus();
        // Restore exact cursor position
        newNameInput.setSelectionRange(cursorStart, cursorEnd);
      }
    }

    this.attachEventListeners();
  }

  private renderLobby(lobby: Lobby): string {
    return `
      <div class="lobby-card" data-lobby-id="${lobby.id}">
        <div class="lobby-header">
          <h3>${lobby.name}</h3>
          <span class="lobby-status ${lobby.status}">${lobby.status}</span>
        </div>
        <div class="lobby-info">
          <div class="info-item">
            <span class="label">Host:</span>
            <span class="value">${lobby.hostName}</span>
          </div>
          <div class="info-item">
            <span class="label">Players:</span>
            <span class="value">${lobby.playerCount} / ${lobby.maxPlayers}</span>
          </div>
        </div>
        <button
          class="btn btn-primary join-btn"
          data-lobby-id="${lobby.id}"
          ${lobby.playerCount >= lobby.maxPlayers ? 'disabled' : ''}
        >
          ${lobby.playerCount >= lobby.maxPlayers ? 'Full' : 'Join'}
        </button>
      </div>
    `;
  }

  private attachEventListeners() {
    // Player name input - save on both input and change
    const nameInput = document.getElementById('player-name') as HTMLInputElement;
    nameInput?.addEventListener('input', (e) => {
      const target = e.target as HTMLInputElement;
      this.gameService.setPlayerName(target.value.trim());
    });
    nameInput?.addEventListener('change', (e) => {
      const target = e.target as HTMLInputElement;
      this.gameService.setPlayerName(target.value.trim());
    });

    // Create lobby button
    document.getElementById('create-lobby-btn')?.addEventListener('click', () => {
      this.showCreateLobbyModal();
    });

    // Refresh button
    document.getElementById('refresh-btn')?.addEventListener('click', () => {
      this.render();
    });

    // Join buttons
    document.querySelectorAll('.join-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const lobbyId = target.dataset.lobbyId;
        if (lobbyId) {
          this.joinLobby(lobbyId);
        }
      });
    });
  }

  private showCreateLobbyModal() {
    const modal = document.getElementById('create-lobby-modal');
    if (!modal) return;

    modal.style.display = 'flex';

    // Cancel button
    document.getElementById('cancel-create-btn')?.addEventListener('click', () => {
      modal.style.display = 'none';
    });

    // Confirm button
    document.getElementById('confirm-create-btn')?.addEventListener('click', () => {
      const nameInput = document.getElementById('lobby-name') as HTMLInputElement;
      const maxPlayersInput = document.getElementById('max-players') as HTMLSelectElement;

      const lobbyName = nameInput.value.trim() || `${this.gameService.getPlayerName()}'s Lobby`;
      const maxPlayers = parseInt(maxPlayersInput.value);

      if (!this.gameService.getPlayerName()) {
        alert('Please enter your name first!');
        return;
      }

      const lobby = this.gameService.createLobby(lobbyName, maxPlayers);
      this.gameService.joinLobby(lobby.id);

      modal.style.display = 'none';

      // Navigate to lobby screen
      this.dispatchEvent('navigate', { screen: 'lobby', lobbyId: lobby.id });
    });
  }

  private joinLobby(lobbyId: string) {
    if (!this.gameService.getPlayerName()) {
      alert('Please enter your name first!');
      return;
    }

    const success = this.gameService.joinLobby(lobbyId);
    if (success) {
      this.dispatchEvent('navigate', { screen: 'lobby', lobbyId });
    } else {
      alert('Failed to join lobby. It may be full.');
    }
  }

  private dispatchEvent(type: string, detail: any) {
    this.container.dispatchEvent(new CustomEvent(type, { detail, bubbles: true }));
  }
}

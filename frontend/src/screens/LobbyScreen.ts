/**
 * Lobby Screen - Waiting room before game starts.
 *
 * Go Fish is always 2 players. The second `joinedLobby` auto-starts the game,
 * so this screen is almost always shown to the host while they wait for an
 * opponent. It also appears briefly to a joiner in the window between
 * submitting their join tx and the state machine flipping the lobby to
 * `in_progress`.
 *
 * Actions:
 *   - Host, alone: "Cancel Lobby" → closedLobby (deletes the lobby).
 *   - Anyone: auto-navigate to the game screen when status becomes in_progress.
 */

import { GoFishGameService } from '../services/GoFishGameService';

interface LobbyStateResponse {
  players: Array<{
    wallet_address: string;
    account_id: number;
    player_name: string;
  }>;
  host_account_id: number;
  lobby_name: string;
  status: string;
}

export class LobbyScreen {
  private container: HTMLElement;
  private gameService: GoFishGameService;
  private lobbyId: string = '';
  private refreshInterval?: number;
  private fetchFailCount: number = 0;
  private cancelPending: boolean = false;

  // Tolerate a few consecutive failures while the lobby row is being indexed.
  // A sustained fail likely means the lobby was deleted (host cancelled).
  private static readonly MAX_FETCH_FAILS = 5;

  constructor(container: HTMLElement) {
    this.container = container;
    this.gameService = GoFishGameService.getInstance();
  }

  async show(lobbyId: string) {
    this.lobbyId = lobbyId;
    this.fetchFailCount = 0;
    this.cancelPending = false;
    await this.render();
    // Poll every 3 seconds to pick up the status flip without hammering the DB.
    this.refreshInterval = window.setInterval(() => this.render(), 3000);
  }

  hide() {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = undefined;
    }
  }

  private async render() {
    const { API_BASE_URL } = await import('../apiConfig');
    const response = await fetch(`${API_BASE_URL}/lobby_state?lobby_id=${this.lobbyId}`);

    if (!response.ok) {
      this.fetchFailCount++;
      if (this.fetchFailCount >= LobbyScreen.MAX_FETCH_FAILS) {
        console.warn('[LobbyScreen] Lobby no longer available, returning to list');
        this.dispatchEvent('navigate', { screen: 'lobby-list' });
      } else {
        this.renderLoading();
      }
      return;
    }

    this.fetchFailCount = 0;

    const lobbyData: LobbyStateResponse = await response.json();

    // Auto-navigate once the state machine has flipped status to in_progress.
    if (lobbyData.status === 'in_progress') {
      if (this.refreshInterval) {
        clearInterval(this.refreshInterval);
        this.refreshInterval = undefined;
      }
      this.dispatchEvent('navigate', { screen: 'game', lobbyId: this.lobbyId });
      return;
    }

    const players = lobbyData.players || [];
    const myWalletAddress = this.gameService.getPlayerId();
    const currentPlayer = players.find(
      (p: any) => p.wallet_address?.toLowerCase() === myWalletAddress.toLowerCase()
    );
    const isHost = currentPlayer?.account_id === lobbyData.host_account_id;

    this.renderWaiting(
      lobbyData.lobby_name,
      players,
      lobbyData.host_account_id,
      isHost,
    );
  }

  private renderLoading() {
    this.container.innerHTML = `
      <div class="lobby-screen">
        <header class="side-header">
          <h1 class="title">Loading…</h1>
        </header>
        <div class="side-content"></div>
      </div>
    `;
  }

  private renderWaiting(
    lobbyName: string,
    players: any[],
    hostAccountId: number,
    isHost: boolean,
  ) {
    const myWalletAddress = this.gameService.getPlayerId();
    const playerCount = players.length;

    const infoText = isHost
      ? (playerCount < 2 ? 'Waiting for an opponent to join…' : 'Starting game…')
      : 'Starting game…';

    // Host-only Cancel Lobby button. Everyone gets the Back button which
    // just returns them to the lobby list (doesn't leave the lobby).
    const cancelButton = isHost
      ? `<button id="cancel-lobby-btn" class="btn btn-secondary">Cancel Lobby</button>`
      : '';

    this.container.innerHTML = `
      <div class="lobby-screen">
        <header class="side-header">
          <button id="back-btn" class="icon-btn back-btn" title="Back to lobbies" aria-label="Back">‹</button>
          <h1 class="title">${lobbyName}</h1>
          <div class="welcome">${infoText}</div>
        </header>

        <div class="side-content">
          <h2>Players (${playerCount}/2)</h2>
          <div class="players-list">
            ${players.map((p: any) => this.renderPlayer(p, hostAccountId, myWalletAddress)).join('')}
            ${playerCount < 2 ? `
              <div class="player-item waiting-slot">
                <span class="player-name">Waiting for opponent…</span>
              </div>
            ` : ''}
          </div>
        </div>

        <footer class="side-footer">
          ${cancelButton}
        </footer>
      </div>
    `;

    this.attachEventListeners(isHost);
  }

  private renderPlayer(player: any, hostAccountId: number, myWalletAddress: string): string {
    const playerIsHost = player.account_id === hostAccountId;
    const isMe = player.wallet_address?.toLowerCase() === myWalletAddress.toLowerCase();
    return `
      <div class="player-item ${isMe ? 'current-player' : ''}">
        <span class="player-name">
          ${player.player_name}
          ${playerIsHost ? '<span class="badge host">Host</span>' : ''}
          ${isMe ? '<span class="badge you">You</span>' : ''}
        </span>
      </div>
    `;
  }

  private attachEventListeners(isHost: boolean) {
    // Back button — return to the lobby list without leaving the lobby.
    // The refresh interval keeps polling status and will auto-navigate to
    // the game when a second player joins.
    document.getElementById('back-btn')?.addEventListener('click', () => {
      this.dispatchEvent('navigate', { screen: 'lobby-list' });
    });

    if (!isHost) return;

    document.getElementById('cancel-lobby-btn')?.addEventListener('click', async () => {
      if (this.cancelPending) return;
      this.cancelPending = true;

      const btn = document.getElementById('cancel-lobby-btn') as HTMLButtonElement;
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Cancelling…';
      }

      try {
        const ok = await this.gameService.closeLobby(this.lobbyId);
        if (ok) {
          this.dispatchEvent('navigate', { screen: 'lobby-list' });
        } else {
          alert('Failed to cancel the lobby. It may already have a second player.');
          if (btn) {
            btn.disabled = false;
            btn.textContent = 'Cancel Lobby';
          }
          this.cancelPending = false;
        }
      } catch (err) {
        console.error('[LobbyScreen] Error cancelling lobby:', err);
        alert('Failed to cancel the lobby. Please try again.');
        if (btn) {
          btn.disabled = false;
          btn.textContent = 'Cancel Lobby';
        }
        this.cancelPending = false;
      }
    });
  }

  private dispatchEvent(type: string, detail: any) {
    this.container.dispatchEvent(new CustomEvent(type, { detail, bubbles: true }));
  }
}

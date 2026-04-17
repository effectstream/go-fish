/**
 * Lobby List Screen - Shows available lobbies and create lobby option
 */

import { GoFishGameService } from '../services/GoFishGameService';
import type { Lobby } from '../../../packages/shared/data-types/src/go-fish-types';
import { getWalletAddress, switchAccount, getLobbyState } from '../effectstreamBridge';

export class LobbyListScreen {
  private container: HTMLElement;
  private gameService: GoFishGameService;
  private refreshInterval?: number;
  private pendingJoinLobbyId: string | null = null; // Track which lobby we're joining

  constructor(container: HTMLElement) {
    this.container = container;
    this.gameService = GoFishGameService.getInstance();
  }

  async show() {
    await this.render();
    // Refresh lobby list every 4 seconds to reduce database pressure
    // The lobby list doesn't need to be super responsive
    this.refreshInterval = window.setInterval(() => this.render(), 4000);
  }

  hide() {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
    }
  }

  private async render() {
    // Don't re-render if we're in the middle of joining a lobby
    if (this.pendingJoinLobbyId) {
      return;
    }

    // Fetch open lobbies and the player's resumable games in parallel
    const [lobbies, resumableGames] = await Promise.all([
      this.gameService.fetchOpenLobbies(),
      this.gameService.findResumableGames().catch(err => {
        console.warn('[LobbyListScreen] findResumableGames failed:', err);
        return [] as Array<{ lobbyId: string; playerId: 1 | 2; lobbyName: string; opponentName: string }>;
      }),
    ]);

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
            const isRejoin = target.dataset.isRejoin === 'true';
            if (lobbyId) {
              if (isRejoin) {
                console.log('[LobbyListScreen] Rejoining lobby (already a member):', lobbyId);
                this.dispatchEvent('navigate', { screen: 'lobby', lobbyId });
              } else {
                this.joinLobby(lobbyId);
              }
            }
          });
        });
      }
      return;
    }

    const playerName = this.gameService.getPlayerName() || 'Player';

    // Compute a default lobby name that doesn't collide with existing lobby
    // names (open lobbies + my active games). Starts with "{name}'s game"
    // and appends " #2", " #3", … until unique. Pure UI — avoids showing
    // duplicates in the sidebar list; the contract doesn't care.
    const existingNames = new Set<string>([
      ...lobbies.map(l => l.name),
      ...resumableGames.map(g => g.lobbyName),
    ]);
    const defaultLobbyName = this.nextAvailableLobbyName(`${playerName}'s game`, existingNames);

    this.container.innerHTML = `
      <div class="lobby-list-screen">
        <header class="side-header">
          <div class="top-actions">
            <button id="leaderboard-btn" class="icon-btn" title="Leaderboard" aria-label="Leaderboard">🏆</button>
            <button id="refresh-btn" class="icon-btn" title="Refresh" aria-label="Refresh">↻</button>
            <button id="help-btn" class="icon-btn" title="How to play" aria-label="Help">?</button>
            <button id="about-btn" class="icon-btn" title="About / Report" aria-label="About">ⓘ</button>
          </div>
          <h1 class="title">Go Fish</h1>
          <div class="welcome">Welcome<span class="name">${playerName}</span></div>
        </header>

        <div class="side-content">
          ${resumableGames.length > 0 ? `
            <h2>My Active Games (${resumableGames.length})</h2>
            <div class="resume-list">
              ${resumableGames.map(g => this.renderResumableGame(g)).join('')}
            </div>
          ` : ''}

          <h2>Available Lobbies (${lobbies.length})</h2>
          <div class="lobby-list">
            ${lobbies.length === 0
              ? '<div class="empty-state">No lobbies available yet.</div>'
              : lobbies.map(lobby => this.renderLobby(lobby)).join('')
            }
          </div>
        </div>

        <footer class="side-footer">
          <button id="create-lobby-btn" class="btn btn-primary">Create New Lobby</button>
        </footer>

        <!-- Create Lobby Modal (with overlay) -->
        <div id="create-lobby-modal" class="create-lobby-modal-overlay" style="display: none;">
          <div class="create-lobby-modal">
            <div class="modal-header">
              <h2>Create New Lobby</h2>
              <button class="modal-close-btn" id="modal-close-btn">&times;</button>
            </div>
            <div class="form-group">
              <label>Lobby Name:</label>
              <input type="text" id="lobby-name" placeholder="Enter lobby name" maxlength="30" value="${defaultLobbyName}"/>
            </div>
            <div class="form-group">
              <span class="form-hint">Go Fish is a 2-player game. Your game will start automatically when someone joins.</span>
            </div>
            <div class="modal-actions">
              <button id="confirm-create-btn" class="btn btn-primary">Create</button>
              <button id="cancel-create-btn" class="btn btn-secondary">Cancel</button>
            </div>
          </div>
        </div>
      </div>
    `;

    this.attachEventListeners();
  }

  private renderResumableGame(game: {
    lobbyId: string;
    playerId: 1 | 2;
    lobbyName: string;
    opponentName: string;
    myScore: number;
    opponentScore: number;
    isMyTurn: boolean;
    phase: number;
  }): string {
    // Phase → user-facing status. 0=dealing, 1=turn_start, 2=wait_response,
    // 3=wait_transfer, 4=wait_draw, 5=wait_draw_check, 6=game_over
    const inSetup = game.phase === 0;
    const finished = game.phase === 6;
    // Turn states use the in-row dealer chip; only setup/finished show a pill
    const showStatusPill = inSetup || finished;
    const statusText = inSetup ? 'Setup' : 'Finished';
    const statusClass = inSetup ? 'in_progress' : 'finished';

    // Turn chip — small gold disc marking whose turn it is. Uses a play
    // arrow (▶) rather than the poker "D" dealer-button convention.
    const chip = `<span class="dealer-chip" title="Current turn">▶</span>`;
    const meActive = !inSetup && !finished && game.isMyTurn;
    const themActive = !inSetup && !finished && !game.isMyTurn;

    // Mocked mini-hand preview — NOT connected to the contract. Seeded off
    // the lobby id so each card shows a stable (but card-specific) mini hand
    // without an extra witness query per render.
    const mockHand = this.mockMiniHand(game.lobbyId);

    return `
      <div class="lobby-card resume-card" data-lobby-id="${game.lobbyId}">
        <div class="lobby-header">
          <h3>${game.lobbyName}</h3>
          ${showStatusPill ? `<span class="lobby-status ${statusClass}">${statusText}</span>` : ''}
        </div>
        <div class="mini-hand">
          ${mockHand.map(c => `
            <div class="mini-card ${c.red ? 'red' : ''}">
              <span class="mc-rank">${c.rank}</span>
              <span class="mc-suit">${c.suit}</span>
            </div>
          `).join('')}
        </div>
        <div class="score-row">
          <div class="score-side me ${meActive ? 'active' : ''}">
            <span class="name">${meActive ? chip : ''} You</span>
            <span class="books">${game.myScore}</span>
          </div>
          <span class="divider">♣</span>
          <div class="score-side them ${themActive ? 'active' : ''}">
            <span class="name">${game.opponentName} ${themActive ? chip : ''}</span>
            <span class="books">${game.opponentScore}</span>
          </div>
        </div>
        <button class="btn btn-primary resume-btn" data-lobby-id="${game.lobbyId}">
          ${meActive ? 'Play Turn' : 'Resume'}
        </button>
      </div>
    `;
  }

  /** Find the first name in the sequence "base", "base #2", "base #3", … that
   *  isn't already taken by an existing lobby. Comparison is case-insensitive
   *  and trim-insensitive so we don't accept near-duplicates. */
  private nextAvailableLobbyName(base: string, taken: Set<string>): string {
    const norm = (s: string) => s.trim().toLowerCase();
    const takenLower = new Set<string>();
    for (const n of taken) takenLower.add(norm(n));

    if (!takenLower.has(norm(base))) return base;
    for (let i = 2; i < 100; i++) {
      const candidate = `${base} #${i}`;
      if (!takenLower.has(norm(candidate))) return candidate;
    }
    // Fallback — extremely unlikely to hit, but keep it stable.
    return `${base} #${Date.now().toString().slice(-4)}`;
  }

  /** Deterministic mock hand derived from the lobby id. Shows 4 cards so
   *  each Active Games card has a sensible preview without extra contract
   *  reads. Real hand data lives in the game screen. */
  private mockMiniHand(seedStr: string): Array<{ rank: string; suit: string; red: boolean }> {
    // Simple string hash for deterministic seeding
    let hash = 0;
    for (let i = 0; i < seedStr.length; i++) {
      hash = ((hash << 5) - hash) + seedStr.charCodeAt(i);
      hash |= 0;
    }
    const RANKS = ['A', '2', '3', '4', '5', '6', '7'];
    const SUITS = [
      { sym: '♥', red: true },
      { sym: '♦', red: true },
      { sym: '♣', red: false },
      { sym: '♠', red: false },
    ];
    const hand: Array<{ rank: string; suit: string; red: boolean }> = [];
    for (let i = 0; i < 4; i++) {
      // LCG step from the seed hash → different index per position
      hash = (hash * 1103515245 + 12345) | 0;
      const rIdx = Math.abs(hash) % RANKS.length;
      hash = (hash * 1103515245 + 12345) | 0;
      const sIdx = Math.abs(hash) % SUITS.length;
      const s = SUITS[sIdx];
      hand.push({ rank: RANKS[rIdx], suit: s.sym, red: s.red });
    }
    return hand;
  }

  private renderLobby(lobby: Lobby): string {
    const isFull = lobby.playerCount >= 2;
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
            <span class="value">${lobby.playerCount} / 2</span>
          </div>
        </div>
        <button
          class="btn btn-primary join-btn"
          data-lobby-id="${lobby.id}"
          data-is-rejoin="${lobby.isPlayerInLobby ? 'true' : 'false'}"
          ${isFull && !lobby.isPlayerInLobby ? 'disabled' : ''}
        >
          ${lobby.isPlayerInLobby ? 'Rejoin' : (isFull ? 'Full' : 'Join')}
        </button>
      </div>
    `;
  }

  private attachEventListeners() {
    // Create lobby button (sticky footer)
    document.getElementById('create-lobby-btn')?.addEventListener('click', () => {
      this.showCreateLobbyModal();
    });

    // Refresh icon (top-right of sidebar header)
    document.getElementById('refresh-btn')?.addEventListener('click', () => {
      this.render();
    });

    // Leaderboard icon — dispatch a custom event so UIManager can toggle the
    // LeaderboardPanel (which is owned by UIManager, not this screen).
    document.getElementById('leaderboard-btn')?.addEventListener('click', () => {
      document.dispatchEvent(new CustomEvent('open-leaderboard', { bubbles: true }));
    });

    // Help icon — placeholder for a future "How to play" modal.
    document.getElementById('help-btn')?.addEventListener('click', () => {
      console.log('[LobbyListScreen] Help button clicked — modal not implemented yet');
    });

    // About / Report icon — placeholder for a future "About & Report an
    // issue" modal.
    document.getElementById('about-btn')?.addEventListener('click', () => {
      console.log('[LobbyListScreen] About button clicked — modal not implemented yet');
    });

    // Resume buttons — jump straight into the game screen
    document.querySelectorAll('.resume-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const lobbyId = target.dataset.lobbyId;
        if (lobbyId) {
          console.log('[LobbyListScreen] Resuming game:', lobbyId);
          this.dispatchEvent('navigate', { screen: 'game', lobbyId });
        }
      });
    });

    // Join buttons
    document.querySelectorAll('.join-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const lobbyId = target.dataset.lobbyId;
        const isRejoin = target.dataset.isRejoin === 'true';
        if (lobbyId) {
          if (isRejoin) {
            // Already in the lobby — just navigate, don't send another join transaction
            console.log('[LobbyListScreen] Rejoining lobby (already a member):', lobbyId);
            this.dispatchEvent('navigate', { screen: 'lobby', lobbyId });
          } else {
            this.joinLobby(lobbyId);
          }
        }
      });
    });
  }

  private showCreateLobbyModal() {
    const modal = document.getElementById('create-lobby-modal');
    if (!modal) return;

    modal.style.display = 'flex';

    // Close button (X)
    document.getElementById('modal-close-btn')?.addEventListener('click', () => {
      modal.style.display = 'none';
    });

    // Close on overlay click
    modal.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).id === 'create-lobby-modal') {
        modal.style.display = 'none';
      }
    });

    // Cancel button
    document.getElementById('cancel-create-btn')?.addEventListener('click', () => {
      modal.style.display = 'none';
    });

    // Confirm button
    document.getElementById('confirm-create-btn')?.addEventListener('click', async () => {
      const nameInput = document.getElementById('lobby-name') as HTMLInputElement;
      const confirmBtn = document.getElementById('confirm-create-btn') as HTMLButtonElement;

      const lobbyName = nameInput.value.trim() || `${this.gameService.getPlayerName()}'s Lobby`;

      if (!this.gameService.getPlayerName()) {
        alert('Please enter your name first!');
        return;
      }

      // Disable button while creating
      if (confirmBtn) {
        confirmBtn.disabled = true;
        confirmBtn.textContent = 'Creating...';
      }

      try {
        // Create lobby on-chain
        const lobby = await this.gameService.createLobby(lobbyName);

        if (!lobby) {
          alert('Failed to create lobby. Please try again.');
          return;
        }

        // Join the lobby
        this.gameService.joinLobby(lobby.id);

        modal.style.display = 'none';

        // Navigate to lobby screen
        this.dispatchEvent('navigate', { screen: 'lobby', lobbyId: lobby.id });
      } catch (error) {
        console.error('Error creating lobby:', error);
        alert('Error creating lobby. Please check your wallet and try again.');
      } finally {
        // Re-enable button
        if (confirmBtn) {
          confirmBtn.disabled = false;
          confirmBtn.textContent = 'Create';
        }
      }
    });
  }

  private async joinLobby(lobbyId: string) {
    if (!this.gameService.getPlayerName()) {
      alert('Please enter your name first!');
      return;
    }

    // Find and disable the join button
    const joinBtn = document.querySelector(`.join-btn[data-lobby-id="${lobbyId}"]`) as HTMLButtonElement;
    if (joinBtn) {
      joinBtn.disabled = true;
      joinBtn.textContent = 'Joining...';
    }

    // Track that we're joining to prevent render from re-enabling the button
    this.pendingJoinLobbyId = lobbyId;

    try {
      // Check for wallet collision with existing lobby players before joining.
      // Two browsers can randomly pick the same Hardhat account index (1-9),
      // causing both players to have the same wallet address and both getting playerId=1.
      const lobbyResult = await getLobbyState(lobbyId);
      if (lobbyResult.success && lobbyResult.lobby?.players) {
        const myAddress = getWalletAddress()?.toLowerCase();
        const existingAddresses = (lobbyResult.lobby.players as any[])
          .map((p) => p.wallet_address as string | null)
          .filter((a): a is string => a != null);
        const hasCollision = myAddress != null && existingAddresses.some(
          (addr) => addr.toLowerCase() === myAddress
        );

        if (hasCollision) {
          console.warn('[LobbyListScreen] Wallet collision detected with lobby host, switching account...');
          const switched = await switchAccount(existingAddresses);
          if (!switched) {
            alert('Could not find a unique wallet. Please try again.');
            if (joinBtn) { joinBtn.disabled = false; joinBtn.textContent = 'Join'; }
            this.pendingJoinLobbyId = null;
            return;
          }
          // Re-initialize game service with the new wallet address
          await this.gameService.initializeWithWallet();
          console.log('[LobbyListScreen] Switched to new wallet:', getWalletAddress());
        }
      }

      const success = await this.gameService.joinLobby(lobbyId);
      if (success) {
        this.dispatchEvent('navigate', { screen: 'lobby', lobbyId });
      } else {
        alert('Failed to join lobby. It may be full.');
        // Re-enable button on failure
        if (joinBtn) {
          joinBtn.disabled = false;
          joinBtn.textContent = 'Join';
        }
      }
    } catch (error) {
      console.error('Error joining lobby:', error);
      alert('Error joining lobby. Please check your wallet and try again.');
      // Re-enable button on error
      if (joinBtn) {
        joinBtn.disabled = false;
        joinBtn.textContent = 'Join';
      }
    } finally {
      this.pendingJoinLobbyId = null;
    }
  }

  private dispatchEvent(type: string, detail: any) {
    this.container.dispatchEvent(new CustomEvent(type, { detail, bubbles: true }));
  }
}

/**
 * Game Screen - Main gameplay with SVG visuals
 */

import { GameService } from '../services/GameService';
import type { GameState, Player, PlayerRole } from '../../../shared/data-types/src/game-types';

export class GameScreen {
  private container: HTMLElement;
  private gameService: GameService;
  private lobbyId: string;
  private refreshInterval?: number;
  private selectedTarget: string | null = null;

  constructor(container: HTMLElement, lobbyId: string) {
    this.container = container;
    this.lobbyId = lobbyId;
    this.gameService = GameService.getInstance();
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

    const isAlive = currentPlayer?.isAlive ?? false;

    this.container.innerHTML = `
      <div class="game-screen">
        <!-- Game Header -->
        <div class="game-header">
          <div class="game-info">
            <h1>🐺 Werewolf - Round ${game.round}</h1>
            <div class="phase-indicator ${game.phase}">
              ${this.getPhaseEmoji(game.phase)} ${this.getPhaseText(game.phase)}
            </div>
          </div>
          <div class="player-role-card">
            ${currentPlayer?.role ? `
              <div class="role-badge ${currentPlayer.role}">
                ${this.getRoleEmoji(currentPlayer.role)} ${currentPlayer.role}
              </div>
              ${!isAlive ? '<div class="dead-indicator">💀 You are dead</div>' : ''}
            ` : ''}
          </div>
        </div>

        <!-- Main Game Area -->
        <div class="game-content">
          <!-- SVG Village Display -->
          <div class="village-display">
            ${this.renderVillageSVG(game, currentPlayer)}
          </div>

          <!-- Game Actions Panel -->
          <div class="actions-panel">
            ${isAlive ? this.renderActionPanel(game, currentPlayer!) : this.renderSpectatorView(game)}
          </div>
        </div>

        <!-- Chat (condensed during game) -->
        <div class="game-chat-mini">
          <details>
            <summary>💬 Chat (${this.gameService.getMessages(this.lobbyId).length})</summary>
            <div id="game-chat-messages" class="chat-messages-mini">
              ${this.renderChatMessages()}
            </div>
            <div class="chat-input-container-mini">
              <input type="text" id="game-chat-input" placeholder="Type..." maxlength="200" />
              <button id="game-send-btn" class="btn btn-sm">Send</button>
            </div>
          </details>
        </div>
      </div>
    `;

    this.attachEventListeners();
  }

  private renderVillageSVG(game: GameState, currentPlayer: Player | undefined): string {
    const alive = game.players.filter(p => p.isAlive);
    const dead = game.players.filter(p => !p.isAlive);

    return `
      <svg viewBox="0 0 800 600" class="village-svg">
        <!-- Sky background -->
        <rect width="800" height="600" fill="${game.phase === 'night' ? '#1a1a2e' : '#87CEEB'}" />

        <!-- Moon or Sun -->
        ${game.phase === 'night'
          ? '<circle cx="700" cy="100" r="50" fill="#f4f4f4" opacity="0.9"/>'
          : '<circle cx="700" cy="100" r="60" fill="#FFD700"/>'
        }

        <!-- Ground -->
        <rect x="0" y="450" width="800" height="150" fill="${game.phase === 'night' ? '#2d4a2b' : '#4a7c4e'}"/>

        <!-- Village Houses -->
        <g class="houses">
          ${this.renderHouses()}
        </g>

        <!-- Player Circles (arranged in a circle) -->
        <g class="players">
          ${this.renderPlayerCircles(alive, currentPlayer)}
        </g>

        <!-- Dead Players (at bottom) -->
        ${dead.length > 0 ? `
          <g class="dead-players">
            <text x="400" y="520" text-anchor="middle" fill="#fff" font-size="16">Eliminated:</text>
            ${dead.map((p, i) => `
              <text x="${300 + i * 80}" y="550" text-anchor="middle" fill="#999" font-size="14">
                💀 ${p.name}
              </text>
            `).join('')}
          </g>
        ` : ''}

        <!-- Phase Instructions -->
        <rect x="200" y="20" width="400" height="60" fill="rgba(0,0,0,0.7)" rx="10"/>
        <text x="400" y="50" text-anchor="middle" fill="#fff" font-size="18" font-weight="bold">
          ${this.getPhaseInstructions(game, currentPlayer)}
        </text>
      </svg>
    `;
  }

  private renderHouses(): string {
    const houses = [
      { x: 100, y: 350 },
      { x: 250, y: 350 },
      { x: 550, y: 350 },
      { x: 650, y: 350 },
    ];

    return houses.map(({ x, y }) => `
      <g>
        <!-- House body -->
        <rect x="${x}" y="${y}" width="80" height="90" fill="#8B4513"/>
        <!-- Roof -->
        <polygon points="${x},${y} ${x + 40},${y - 40} ${x + 80},${y}" fill="#654321"/>
        <!-- Door -->
        <rect x="${x + 30}" y="${y + 50}" width="20" height="40" fill="#4a3520"/>
        <!-- Window -->
        <rect x="${x + 15}" y="${y + 20}" width="20" height="20" fill="#FFD700"/>
      </g>
    `).join('');
  }

  private renderPlayerCircles(players: Player[], currentPlayer: Player | undefined): string {
    const centerX = 400;
    const centerY = 280;
    const radius = 150;

    return players.map((player, index) => {
      const angle = (2 * Math.PI * index) / players.length - Math.PI / 2;
      const x = centerX + radius * Math.cos(angle);
      const y = centerY + radius * Math.sin(angle);

      const isCurrentPlayer = player.id === this.gameService.getPlayerId();
      const isSelected = player.id === this.selectedTarget;
      const canSelect = this.canSelectPlayer(player);

      return `
        <g class="player-circle ${canSelect ? 'selectable' : ''}"
           data-player-id="${player.id}"
           style="cursor: ${canSelect ? 'pointer' : 'default'}">
          <!-- Selection ring -->
          ${isSelected ? `<circle cx="${x}" cy="${y}" r="42" fill="none" stroke="#FFD700" stroke-width="3"/>` : ''}

          <!-- Player circle -->
          <circle
            cx="${x}"
            cy="${y}"
            r="35"
            fill="${isCurrentPlayer ? '#4CAF50' : '#2196F3'}"
            stroke="${isSelected ? '#FFD700' : '#fff'}"
            stroke-width="2"
          />

          <!-- Player name -->
          <text
            x="${x}"
            y="${y + 5}"
            text-anchor="middle"
            fill="#fff"
            font-size="12"
            font-weight="bold"
          >
            ${player.name}
          </text>

          <!-- Current player indicator -->
          ${isCurrentPlayer ? `
            <text x="${x}" y="${y + 55}" text-anchor="middle" fill="#4CAF50" font-size="10">
              (You)
            </text>
          ` : ''}

          <!-- Role indicator (only show own role or if dead) -->
          ${isCurrentPlayer && player.role ? `
            <text x="${x}" y="${y - 45}" text-anchor="middle" fill="#fff" font-size="14">
              ${this.getRoleEmoji(player.role)}
            </text>
          ` : ''}
        </g>
      `;
    }).join('');
  }

  private canSelectPlayer(player: Player): boolean {
    const game = this.gameService.getGameState(this.lobbyId);
    const currentPlayer = this.gameService.getCurrentPlayer(this.lobbyId);

    if (!game || !currentPlayer || !currentPlayer.isAlive) return false;
    if (player.id === currentPlayer.id) return false;
    if (!player.isAlive) return false;

    if (game.phase === 'night' && currentPlayer.role) {
      return ['werewolf', 'seer', 'doctor'].includes(currentPlayer.role);
    }

    if (game.phase === 'voting') {
      return true;
    }

    return false;
  }

  private renderActionPanel(game: GameState, currentPlayer: Player): string {
    if (game.phase === 'night') {
      return this.renderNightActions(currentPlayer);
    } else if (game.phase === 'day') {
      return this.renderDayPhase(game);
    } else if (game.phase === 'voting') {
      return this.renderVotingPhase(game, currentPlayer);
    }

    return '<div class="no-actions">Waiting for next phase...</div>';
  }

  private renderNightActions(currentPlayer: Player): string {
    const role = currentPlayer.role!;

    const actions: Record<string, { title: string; description: string; action: string }> = {
      werewolf: {
        title: '🐺 Werewolf Action',
        description: 'Choose a villager to eliminate',
        action: 'kill',
      },
      seer: {
        title: '🔮 Seer Action',
        description: 'Investigate a player to learn their role',
        action: 'investigate',
      },
      doctor: {
        title: '⚕️ Doctor Action',
        description: 'Protect a player from the werewolves',
        action: 'protect',
      },
      villager: {
        title: '😴 Villager',
        description: 'You have no night action. Sleep tight!',
        action: '',
      },
    };

    const info = actions[role];

    return `
      <div class="action-panel night-action">
        <h2>${info.title}</h2>
        <p>${info.description}</p>
        ${role !== 'villager' ? `
          <div class="selected-target">
            ${this.selectedTarget
              ? `<p>Selected: <strong>${this.getPlayerName(this.selectedTarget)}</strong></p>`
              : '<p class="hint">Click a player in the village above</p>'
            }
          </div>
          <button
            id="confirm-action-btn"
            class="btn btn-primary"
            ${!this.selectedTarget ? 'disabled' : ''}
          >
            Confirm ${role === 'werewolf' ? 'Kill' : role === 'doctor' ? 'Protect' : 'Investigate'}
          </button>
        ` : ''}
      </div>
    `;
  }

  private renderDayPhase(game: GameState): string {
    return `
      <div class="action-panel day-phase">
        <h2>☀️ Day Phase</h2>
        <p>Discuss with other players who might be a werewolf.</p>
        <p class="hint">Use the chat below to coordinate with others!</p>

        <div class="alive-count">
          <p>Alive: ${game.players.filter(p => p.isAlive).length}</p>
          <p>Werewolves: ${game.players.filter(p => p.isAlive && p.role === 'werewolf').length} (hidden)</p>
        </div>

        ${game.hostId === this.gameService.getPlayerId() ? `
          <button id="start-voting-btn" class="btn btn-primary">Start Voting</button>
        ` : '<p class="hint">Waiting for host to start voting...</p>'}
      </div>
    `;
  }

  private renderVotingPhase(game: GameState, currentPlayer: Player): string {
    const hasVoted = game.votes.some(v => v.voterId === currentPlayer.id);
    const totalVotes = game.votes.length;
    const alivePlayers = game.players.filter(p => p.isAlive).length;

    return `
      <div class="action-panel voting-phase">
        <h2>🗳️ Voting Phase</h2>
        <p>Vote for who you think is a werewolf!</p>

        <div class="voting-status">
          <p>Votes cast: ${totalVotes} / ${alivePlayers}</p>
          ${hasVoted ? '<p class="voted">✓ You have voted</p>' : ''}
        </div>

        <div class="selected-target">
          ${this.selectedTarget
            ? `<p>Voting for: <strong>${this.getPlayerName(this.selectedTarget)}</strong></p>`
            : '<p class="hint">Click a player to vote for them</p>'
          }
        </div>

        <button
          id="confirm-vote-btn"
          class="btn btn-primary"
          ${!this.selectedTarget ? 'disabled' : ''}
        >
          ${hasVoted ? 'Change Vote' : 'Cast Vote'}
        </button>

        ${game.hostId === this.gameService.getPlayerId() && totalVotes === alivePlayers ? `
          <button id="end-voting-btn" class="btn btn-secondary">End Voting</button>
        ` : ''}
      </div>
    `;
  }

  private renderSpectatorView(game: GameState): string {
    return `
      <div class="action-panel spectator-view">
        <h2>👻 Spectator</h2>
        <p>You have been eliminated, but you can still watch the game!</p>
        <div class="game-stats">
          <p>Alive Players: ${game.players.filter(p => p.isAlive).length}</p>
          <p>Current Round: ${game.round}</p>
        </div>
      </div>
    `;
  }

  private renderChatMessages(): string {
    const messages = this.gameService.getMessages(this.lobbyId).slice(-20);
    return messages.map(msg => `
      <div class="chat-msg ${msg.isSystem ? 'system' : ''}">
        <strong>${msg.playerName}:</strong> ${this.escapeHtml(msg.message)}
      </div>
    `).join('');
  }

  private attachEventListeners() {
    // Player selection
    document.querySelectorAll('.player-circle.selectable').forEach(circle => {
      circle.addEventListener('click', (e) => {
        const target = (e.currentTarget as HTMLElement).dataset.playerId;
        if (target) {
          this.selectedTarget = target;
          this.render();
        }
      });
    });

    // Night action confirmation
    document.getElementById('confirm-action-btn')?.addEventListener('click', () => {
      const currentPlayer = this.gameService.getCurrentPlayer(this.lobbyId);
      if (!currentPlayer || !this.selectedTarget) return;

      let actionType: 'kill' | 'protect' | 'investigate';
      if (currentPlayer.role === 'werewolf') actionType = 'kill';
      else if (currentPlayer.role === 'doctor') actionType = 'protect';
      else if (currentPlayer.role === 'seer') actionType = 'investigate';
      else return;

      this.gameService.performNightAction(this.lobbyId, actionType, this.selectedTarget);
      this.selectedTarget = null;
      alert('Action confirmed! Waiting for other players...');
    });

    // Start voting
    document.getElementById('start-voting-btn')?.addEventListener('click', () => {
      this.gameService.startVoting(this.lobbyId);
    });

    // Vote confirmation
    document.getElementById('confirm-vote-btn')?.addEventListener('click', () => {
      if (!this.selectedTarget) return;
      this.gameService.castVote(this.lobbyId, this.selectedTarget);
      this.selectedTarget = null;
      this.render();
    });

    // End voting
    document.getElementById('end-voting-btn')?.addEventListener('click', () => {
      this.gameService.processVotingPhase(this.lobbyId);
    });

    // Chat
    const chatInput = document.getElementById('game-chat-input') as HTMLInputElement;
    const sendBtn = document.getElementById('game-send-btn');

    const sendMessage = () => {
      const message = chatInput?.value.trim();
      if (message) {
        this.gameService.sendMessage(this.lobbyId, message);
        chatInput.value = '';
      }
    };

    sendBtn?.addEventListener('click', sendMessage);
    chatInput?.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') sendMessage();
    });
  }

  // Helper methods
  private getPhaseEmoji(phase: string): string {
    const emojis: Record<string, string> = {
      night: '🌙',
      day: '☀️',
      voting: '🗳️',
      lobby: '⏳',
      finished: '🏁',
    };
    return emojis[phase] || '❓';
  }

  private getPhaseText(phase: string): string {
    return phase.charAt(0).toUpperCase() + phase.slice(1);
  }

  private getRoleEmoji(role: PlayerRole): string {
    const emojis: Record<PlayerRole, string> = {
      werewolf: '🐺',
      villager: '👤',
      seer: '🔮',
      doctor: '⚕️',
    };
    return emojis[role];
  }

  private getPhaseInstructions(game: GameState, currentPlayer: Player | undefined): string {
    if (!currentPlayer) return 'Spectating...';
    if (!currentPlayer.isAlive) return 'You are eliminated - Spectating';

    if (game.phase === 'night') {
      if (currentPlayer.role === 'werewolf') return 'Choose someone to eliminate';
      if (currentPlayer.role === 'seer') return 'Choose someone to investigate';
      if (currentPlayer.role === 'doctor') return 'Choose someone to protect';
      return 'Sleep tight, villager!';
    } else if (game.phase === 'day') {
      return 'Discuss and find the werewolves!';
    } else if (game.phase === 'voting') {
      return 'Vote for who you think is a werewolf!';
    }

    return '';
  }

  private getPlayerName(playerId: string): string {
    const game = this.gameService.getGameState(this.lobbyId);
    return game?.players.find(p => p.id === playerId)?.name || 'Unknown';
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  private dispatchEvent(type: string, detail: any) {
    this.container.dispatchEvent(new CustomEvent(type, { detail, bubbles: true }));
  }
}

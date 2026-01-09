/**
 * Lobby Screen - Waiting room with chat before game starts
 */

import { GameService } from '../services/GameService';
import type { GameState, Player, ChatMessage } from '../../../shared/data-types/src/game-types';

export class LobbyScreen {
  private container: HTMLElement;
  private gameService: GameService;
  private lobbyId: string = '';
  private refreshInterval?: number;

  constructor(container: HTMLElement) {
    this.container = container;
    this.gameService = GameService.getInstance();
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
          <h1>🐺 ${lobby.name}</h1>
          <button id="leave-lobby-btn" class="btn btn-secondary">Leave Lobby</button>
        </div>

        <div class="lobby-content">
          <!-- Players Panel -->
          <div class="players-panel">
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
                    : `Need ${game.players.length < 4 ? (4 - game.players.length) + ' more players and ' : ''}all players to ready up`
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

          <!-- Chat Panel -->
          <div class="chat-panel">
            <h2>Chat</h2>
            <div id="chat-messages" class="chat-messages">
              ${this.renderChatMessages()}
            </div>
            <div class="chat-input-container">
              <input
                type="text"
                id="chat-input"
                placeholder="Type a message..."
                maxlength="200"
              />
              <button id="send-chat-btn" class="btn btn-primary">Send</button>
            </div>
          </div>
        </div>

        <!-- Game Rules -->
        <div class="game-rules">
          <h3>How to Play</h3>
          <ul>
            <li><strong>Werewolves</strong>: Kill a villager each night</li>
            <li><strong>Villagers</strong>: Vote out werewolves during the day</li>
            <li><strong>Seer</strong>: Investigate one player each night</li>
            <li><strong>Doctor</strong>: Protect one player from werewolves each night</li>
          </ul>
          <p>Werewolves win if they equal or outnumber villagers. Villagers win if all werewolves are eliminated.</p>
        </div>
      </div>
    `;

    this.attachEventListeners();
    this.scrollChatToBottom();
  }

  private renderPlayer(player: Player, game: GameState): string {
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

  private renderChatMessages(): string {
    const messages = this.gameService.getMessages(this.lobbyId);

    if (messages.length === 0) {
      return '<div class="empty-chat">No messages yet. Say hello!</div>';
    }

    return messages.map(msg => this.renderChatMessage(msg)).join('');
  }

  private renderChatMessage(msg: ChatMessage): string {
    const time = new Date(msg.timestamp).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });

    if (msg.isSystem) {
      return `
        <div class="chat-message system-message">
          <span class="message-content">${msg.message}</span>
        </div>
      `;
    }

    const isOwnMessage = msg.playerId === this.gameService.getPlayerId();

    return `
      <div class="chat-message ${isOwnMessage ? 'own-message' : ''}">
        <div class="message-header">
          <span class="message-sender">${msg.playerName}</span>
          <span class="message-time">${time}</span>
        </div>
        <div class="message-content">${this.escapeHtml(msg.message)}</div>
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

    // Chat input
    const chatInput = document.getElementById('chat-input') as HTMLInputElement;
    const sendBtn = document.getElementById('send-chat-btn');

    const sendMessage = () => {
      const message = chatInput?.value.trim();
      if (message) {
        this.gameService.sendMessage(this.lobbyId, message);
        chatInput.value = '';
        this.render();
      }
    };

    sendBtn?.addEventListener('click', sendMessage);
    chatInput?.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        sendMessage();
      }
    });
  }

  private scrollChatToBottom() {
    const chatMessages = document.getElementById('chat-messages');
    if (chatMessages) {
      chatMessages.scrollTop = chatMessages.scrollHeight;
    }
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

/**
 * NameEntryScreen - Let user set their display name after wallet connection
 */

import { GoFishGameService } from '../services/GoFishGameService';
import * as EffectstreamBridge from '../effectstreamBridge';

export class NameEntryScreen {
  private container: HTMLElement;
  private gameService: GoFishGameService;
  private nameInput: HTMLInputElement | null = null;
  private submitButton: HTMLButtonElement | null = null;
  private walletDisplay: HTMLElement | null = null;

  constructor(gameService: GoFishGameService, container: HTMLElement) {
    this.container = container;
    this.gameService = gameService;
  }

  private static readonly STORAGE_KEY = 'gofish_player_name';

  async show() {
    await this.gameService.initializeWithWallet();

    // Restore saved name — skip the entry screen entirely if we have one
    const saved = localStorage.getItem(NameEntryScreen.STORAGE_KEY);
    if (saved && saved.trim().length >= 2) {
      this.gameService.setPlayerName(saved.trim());
      console.log('Player name restored from localStorage:', saved.trim());
      this.dispatchNavigate('lobby-list');
      return;
    }

    this.render();

    const address = EffectstreamBridge.getWalletAddress();
    if (this.walletDisplay && address) {
      this.walletDisplay.textContent = this.formatAddress(address);
    }
  }

  hide() {
    // No cleanup needed
  }

  private render() {
    this.container.innerHTML = `
      <div class="name-entry-screen">
        <header class="side-header">
          <h1 class="title">Go Fish</h1>
          <div class="welcome">Welcome, stranger</div>
        </header>

        <div class="side-content">
          <div class="name-entry-body">
            <p class="ne-subtitle">Pick a display name to get started.</p>

            <div class="form-group">
              <input
                type="text"
                id="player-name-input"
                placeholder="Enter your name"
                maxlength="20"
                autofocus
              />
            </div>

            <div class="wallet-badge">
              <span class="wallet-label">Connected:</span>
              <span class="wallet-address" id="wallet-display"></span>
            </div>
          </div>
        </div>

        <footer class="side-footer">
          <button id="submit-name-btn" class="btn btn-primary">Continue</button>
        </footer>
      </div>
    `;
    this.attachEventListeners();
  }

  private attachEventListeners(): void {
    this.nameInput = document.getElementById('player-name-input') as HTMLInputElement;
    this.submitButton = document.getElementById('submit-name-btn') as HTMLButtonElement;
    this.walletDisplay = document.getElementById('wallet-display');

    this.submitButton?.addEventListener('click', () => this.handleSubmit());
    this.nameInput?.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        this.handleSubmit();
      }
    });
  }

  private handleSubmit(): void {
    if (!this.nameInput) return;

    const name = this.nameInput.value.trim();

    if (name.length === 0) {
      alert('Please enter your name');
      return;
    }

    if (name.length < 2) {
      alert('Name must be at least 2 characters');
      return;
    }

    // Persist + set player name
    localStorage.setItem(NameEntryScreen.STORAGE_KEY, name);
    this.gameService.setPlayerName(name);

    console.log('Player name set:', name);

    // Navigate to lobby list
    this.dispatchNavigate('lobby-list');
  }

  private formatAddress(address: string): string {
    if (address.length < 10) return address;
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  }

  private dispatchNavigate(screen: string, data: any = {}) {
    const event = new CustomEvent('navigate', {
      detail: { screen, ...data },
      bubbles: true,
    });
    this.container.dispatchEvent(event);
  }
}

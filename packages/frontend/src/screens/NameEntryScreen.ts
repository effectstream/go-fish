/**
 * NameEntryScreen - Let user set their display name after wallet connection
 */

import { GoFishGameService } from '../services/GoFishGameService';
import * as PaimaMiddleware from '../paimaMiddleware';

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

  async show() {
    await this.gameService.initializeWithWallet();
    this.render();

    const address = PaimaMiddleware.getWalletAddress();
    if (this.walletDisplay && address) {
      this.walletDisplay.textContent = this.formatAddress(address);
    }
  }

  hide() {
    // No cleanup needed
  }

  private render() {
    this.container.innerHTML = `
      <style>
        .name-entry-container {
          display: flex;
          justify-content: center;
          align-items: center;
          min-height: 100vh;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          padding: 20px;
        }

        .name-entry-card {
          background: white;
          border-radius: 16px;
          padding: 48px;
          max-width: 480px;
          width: 100%;
          box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
        }

        .wallet-badge {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          padding: 12px 20px;
          background: #f7fafc;
          border-radius: 24px;
          margin-bottom: 32px;
          font-size: 14px;
        }

        .wallet-label {
          color: #718096;
          font-weight: 500;
        }

        .wallet-address {
          color: #667eea;
          font-weight: 600;
          font-family: 'Courier New', monospace;
        }

        .name-entry-card h2 {
          font-size: 32px;
          margin: 0 0 8px 0;
          color: #1a202c;
          text-align: center;
        }

        .subtitle {
          font-size: 16px;
          color: #718096;
          margin: 0 0 32px 0;
          text-align: center;
        }

        .form-group {
          margin: 24px 0;
        }

        .name-input {
          width: 100%;
          padding: 16px 20px;
          font-size: 18px;
          border: 2px solid #e2e8f0;
          border-radius: 12px;
          transition: all 0.3s ease;
          box-sizing: border-box;
        }

        .name-input:focus {
          outline: none;
          border-color: #667eea;
          box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
        }

        .btn-large {
          padding: 16px 48px;
          font-size: 18px;
          font-weight: 600;
          margin: 16px 0;
          width: 100%;
          transition: all 0.3s ease;
          background: #667eea;
          color: white;
          border: none;
          border-radius: 8px;
          cursor: pointer;
        }

        .btn-large:hover {
          transform: translateY(-2px);
          box-shadow: 0 8px 20px rgba(102, 126, 234, 0.4);
        }

        .btn-large:disabled {
          opacity: 0.6;
          cursor: not-allowed;
          transform: none;
        }
      </style>

      <div class="name-entry-container">
        <div class="name-entry-card">
          <div class="wallet-badge">
            <span class="wallet-label">Connected:</span>
            <span class="wallet-address" id="wallet-display"></span>
          </div>

          <h2>Welcome to Go Fish!</h2>
          <p class="subtitle">Enter your display name</p>

          <div class="form-group">
            <input
              type="text"
              id="player-name-input"
              class="name-input"
              placeholder="Enter your name"
              maxlength="20"
              autofocus
            />
          </div>

          <button id="submit-name-btn" class="btn-large">
            Continue
          </button>
        </div>
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

    // Set player name in game service
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

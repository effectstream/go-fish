/**
 * WalletScreen - Handles wallet connection before entering the game
 */

import * as PaimaMiddleware from '../paimaMiddleware';
import { WalletMode } from '@paimaexample/wallets';

export class WalletScreen {
  private container: HTMLElement;
  private connectButton: HTMLButtonElement | null = null;
  private statusText: HTMLElement | null = null;
  private errorText: HTMLElement | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  async show() {
    // Check if already connected
    if (PaimaMiddleware.isWalletConnected()) {
      const address = PaimaMiddleware.getWalletAddress();
      console.log('Already connected to wallet:', address);
      this.dispatchNavigate('name-entry');
      return;
    }

    this.render();
  }

  hide() {
    // No cleanup needed
  }

  private render() {
    this.container.innerHTML = `
      <style>
        .wallet-container {
          display: flex;
          justify-content: center;
          align-items: center;
          min-height: 100vh;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          padding: 20px;
        }

        .wallet-card {
          background: white;
          border-radius: 16px;
          padding: 48px;
          max-width: 480px;
          width: 100%;
          box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
          text-align: center;
        }

        .wallet-card h1 {
          font-size: 48px;
          margin: 0 0 8px 0;
          color: #1a202c;
          font-weight: 700;
        }

        .subtitle {
          font-size: 18px;
          color: #718096;
          margin: 0 0 32px 0;
        }

        .wallet-info {
          margin: 32px 0;
          padding: 24px;
          background: #f7fafc;
          border-radius: 12px;
        }

        .wallet-info p {
          margin: 8px 0;
          color: #2d3748;
          font-size: 16px;
        }

        .wallet-status {
          font-weight: 600;
          color: #667eea;
          min-height: 24px;
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

        .error-text {
          color: #e53e3e;
          font-size: 14px;
          min-height: 20px;
          margin: 16px 0;
        }

        .wallet-details {
          margin-top: 32px;
          padding-top: 32px;
          border-top: 1px solid #e2e8f0;
        }

        .small-text {
          font-size: 14px;
          color: #718096;
          margin: 4px 0;
        }

        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }

        .connecting {
          animation: pulse 1.5s ease-in-out infinite;
        }
      </style>

      <div class="wallet-container">
        <div class="wallet-card">
          <h1>Go Fish</h1>
          <p class="subtitle">A blockchain card game</p>

          <div class="wallet-info">
            <p>Connect your wallet to start playing</p>
            <p class="wallet-status" id="wallet-status"></p>
          </div>

          <button id="connect-wallet-btn" class="btn-large">
            Connect Wallet
          </button>

          <p class="error-text" id="error-text"></p>

          <div class="wallet-details">
            <p class="small-text">Supported wallets:</p>
            <p class="small-text">• MetaMask</p>
            <p class="small-text">• Any EVM-compatible injected wallet</p>
          </div>
        </div>
      </div>
    `;
    this.attachEventListeners();
  }

  private attachEventListeners(): void {
    this.connectButton = document.getElementById('connect-wallet-btn') as HTMLButtonElement;
    this.statusText = document.getElementById('wallet-status');
    this.errorText = document.getElementById('error-text');

    this.connectButton?.addEventListener('click', () => this.handleConnectWallet());
  }

  private async handleConnectWallet(): Promise<void> {
    if (!this.connectButton || !this.statusText || !this.errorText) return;

    // Disable button and show loading state
    this.connectButton.disabled = true;
    this.connectButton.textContent = 'Connecting...';
    this.connectButton.classList.add('connecting');
    this.errorText.textContent = '';
    this.statusText.textContent = 'Opening wallet...';

    try {
      // Attempt to connect wallet
      const result = await PaimaMiddleware.userWalletLogin({
        mode: 0, // WalletMode.EvmInjected
        preferBatchedMode: false,
      });

      if (result.success) {
        const address = PaimaMiddleware.getWalletAddress();
        console.log('Wallet connected successfully:', address);

        this.statusText.textContent = `Connected: ${this.formatAddress(address || '')}`;

        // Wait a moment to show success, then navigate
        setTimeout(() => {
          this.dispatchNavigate('name-entry');
        }, 1000);
      } else {
        // Connection failed
        this.handleConnectionError(result.errorMessage || 'Failed to connect wallet');
      }
    } catch (error) {
      console.error('Error connecting wallet:', error);
      this.handleConnectionError(
        error instanceof Error ? error.message : 'Unknown error occurred'
      );
    }
  }

  private handleConnectionError(message: string): void {
    if (!this.connectButton || !this.statusText || !this.errorText) return;

    this.connectButton.disabled = false;
    this.connectButton.textContent = 'Connect Wallet';
    this.connectButton.classList.remove('connecting');
    this.statusText.textContent = '';
    this.errorText.textContent = `Error: ${message}`;

    // Show user-friendly error messages
    if (message.includes('user rejected') || message.includes('User rejected')) {
      this.errorText.textContent = 'Connection cancelled. Please try again.';
    } else if (message.includes('No injected')) {
      this.errorText.textContent = 'Please install MetaMask or another Web3 wallet.';
    }
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

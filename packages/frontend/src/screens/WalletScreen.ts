/**
 * WalletScreen - Handles wallet connection before entering the game
 * Only requires Lace wallet for Midnight ZK operations.
 * EVM wallet is auto-generated locally (no MetaMask needed).
 *
 * In mock mode (USE_TYPESCRIPT_CONTRACT=true): No wallet needed, auto-proceed
 * In production mode: Only Lace wallet required for Midnight transactions
 */

import * as EffectstreamBridge from '../effectstreamBridge';
import * as LaceWalletBridge from '../laceWalletBridge';
import { MidnightService } from '../services/MidnightService';
import { isBatcherModeEnabled } from '../proving/batcher-providers';

// Config from backend
interface AppConfig {
  useMockedMidnight: boolean;
  requiresLaceWallet: boolean;
  requiresEvmWallet: boolean;
}

export class WalletScreen {
  private container: HTMLElement;
  private connectLaceButton: HTMLButtonElement | null = null;
  private statusText: HTMLElement | null = null;
  private errorText: HTMLElement | null = null;

  // Connection state - only tracking Lace now
  private laceConnected: boolean = false;

  // Config from backend
  // Default to production mode (require Lace wallet)
  private config: AppConfig = {
    useMockedMidnight: false,
    requiresLaceWallet: true,
    requiresEvmWallet: false, // No longer required - using local wallet
  };

  constructor(container: HTMLElement) {
    this.container = container;
  }

  async show() {
    // Fetch config from backend to determine which wallets are needed
    await this.fetchConfig();

    // Check existing Lace connection
    this.laceConnected = LaceWalletBridge.isLaceConnected();

    // Check if batcher mode is enabled (no Lace wallet required)
    const batcherMode = isBatcherModeEnabled();
    if (batcherMode) {
      console.log('[WalletScreen] Batcher mode enabled - no Lace wallet required');
    }

    // Initialize the local EVM wallet automatically (no user interaction needed)
    console.log('[WalletScreen] Initializing local EVM wallet...');
    await EffectstreamBridge.userWalletLogin();
    console.log('[WalletScreen] Local EVM wallet ready');

    // If in mock mode, batcher mode, or Lace already connected, proceed
    if (this.config.useMockedMidnight || batcherMode || this.laceConnected) {
      console.log('[WalletScreen] Proceeding to game...');

      // If batcher mode is enabled, initialize on-chain service now
      // (in wallet mode, this happens after Lace connection)
      if (batcherMode && !this.config.useMockedMidnight) {
        console.log('[WalletScreen] Initializing batcher mode on-chain service...');
        MidnightService.tryInitializeOnChain().then((initialized) => {
          if (initialized) {
            console.log('[WalletScreen] Batcher mode on-chain service initialized');
          } else {
            console.log('[WalletScreen] Batcher mode on-chain service not ready yet');
          }
        }).catch((error) => {
          console.error('[WalletScreen] Batcher mode initialization error:', error);
        });
      }

      this.dispatchNavigate('name-entry');
      return;
    }

    this.render();
  }

  hide() {
    // No cleanup needed
  }

  private async fetchConfig(): Promise<void> {
    try {
      const { API_BASE_URL } = await import('../apiConfig');
      const response = await fetch(`${API_BASE_URL}/api/config`);
      if (response.ok) {
        const serverConfig = await response.json();
        // Override EVM requirement - we always use local wallet now
        this.config = {
          ...serverConfig,
          requiresEvmWallet: false,
        };
        console.log('[WalletScreen] Config loaded:', this.config);
      }
    } catch (error) {
      console.warn('[WalletScreen] Could not fetch config, using defaults:', error);
      // Keep defaults
    }
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
          max-width: 520px;
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

        .wallet-buttons {
          display: flex;
          flex-direction: column;
          gap: 12px;
          margin: 24px 0;
        }

        .btn-large {
          padding: 16px 48px;
          font-size: 18px;
          font-weight: 600;
          width: 100%;
          transition: all 0.3s ease;
          border: none;
          border-radius: 8px;
          cursor: pointer;
        }

        .btn-lace {
          background: linear-gradient(135deg, #1a472a 0%, #2d6b3f 100%);
          color: white;
        }

        .btn-lace:hover:not(:disabled) {
          transform: translateY(-2px);
          box-shadow: 0 8px 20px rgba(26, 71, 42, 0.4);
        }

        .btn-large:disabled {
          opacity: 0.6;
          cursor: not-allowed;
          transform: none;
        }

        .btn-connected {
          background: #48bb78 !important;
          cursor: default;
        }

        .btn-connected:hover {
          transform: none !important;
          box-shadow: none !important;
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

        .wallet-section {
          margin: 16px 0;
        }

        .wallet-section-title {
          font-size: 12px;
          font-weight: 600;
          color: #a0aec0;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          margin-bottom: 8px;
        }

        .connection-status {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          margin-top: 8px;
          font-size: 14px;
        }

        .status-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
        }

        .status-connected {
          background: #48bb78;
        }

        .status-disconnected {
          background: #e53e3e;
        }

        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }

        .connecting {
          animation: pulse 1.5s ease-in-out infinite;
        }

        .local-wallet-notice {
          background: #e6fffa;
          border: 1px solid #38b2ac;
          border-radius: 8px;
          padding: 12px 16px;
          margin-bottom: 24px;
          font-size: 14px;
          color: #234e52;
        }

        .local-wallet-notice strong {
          color: #1a365d;
        }
      </style>

      <div class="wallet-container">
        <div class="wallet-card">
          <h1>Go Fish</h1>
          <p class="subtitle">A blockchain card game with ZK privacy</p>

          <div class="local-wallet-notice">
            <strong>No MetaMask needed!</strong><br>
            A local wallet has been automatically created for game transactions.
          </div>

          <div class="wallet-info">
            <p>Connect your Lace wallet to enable Midnight ZK privacy features</p>
            <p class="wallet-status" id="wallet-status"></p>
          </div>

          <div class="wallet-buttons">
            <div class="wallet-section">
              <div class="wallet-section-title">Midnight Network (ZK Privacy)</div>
              <button id="connect-lace-btn" class="btn-large btn-lace ${this.laceConnected ? 'btn-connected' : ''}">
                ${this.laceConnected ? 'Lace Connected' : 'Connect Lace Wallet'}
              </button>
              <div class="connection-status">
                <span class="status-dot ${this.laceConnected ? 'status-connected' : 'status-disconnected'}"></span>
                <span>${this.laceConnected ? 'Connected' : 'Not connected'}</span>
              </div>
            </div>
          </div>

          <p class="error-text" id="error-text"></p>

          <div class="wallet-details">
            <p class="small-text">Requirements:</p>
            <p class="small-text">• Lace Midnight Preview wallet extension</p>
            <p class="small-text">• tDUST tokens for transaction fees</p>
          </div>
        </div>
      </div>
    `;
    this.attachEventListeners();
  }

  private attachEventListeners(): void {
    this.connectLaceButton = document.getElementById('connect-lace-btn') as HTMLButtonElement;
    this.statusText = document.getElementById('wallet-status');
    this.errorText = document.getElementById('error-text');

    this.connectLaceButton?.addEventListener('click', () => {
      if (!this.laceConnected) {
        this.handleConnectLaceWallet();
      }
    });
  }

  private async handleConnectLaceWallet(): Promise<void> {
    if (!this.connectLaceButton || !this.statusText || !this.errorText) return;

    // Disable button and show loading state
    this.setButtonLoading(this.connectLaceButton, true);
    this.errorText.textContent = '';
    this.statusText.textContent = 'Opening Lace wallet...';

    try {
      // Attempt to connect Lace wallet
      const result = await LaceWalletBridge.laceWalletLogin();

      if (result.success) {
        const address = result.address || LaceWalletBridge.getLaceAddress();
        console.log('Lace wallet connected successfully:', address);

        this.laceConnected = true;

        // Try to initialize on-chain service now that Lace is connected
        // This enables real Midnight blockchain transactions in production mode
        console.log('[WalletScreen] Attempting to initialize on-chain service...');
        MidnightService.tryInitializeOnChain().then((initialized) => {
          if (initialized) {
            console.log('[WalletScreen] On-chain service initialized successfully');
          } else {
            console.log('[WalletScreen] On-chain service not initialized (mock mode or not ready)');
          }
        }).catch((error) => {
          console.error('[WalletScreen] On-chain service initialization error:', error);
        });

        // Navigate to game
        this.statusText.textContent = `Connected! Proceeding...`;
        this.connectLaceButton.textContent = 'Lace Connected';
        this.connectLaceButton.classList.remove('connecting');
        this.connectLaceButton.classList.add('btn-connected');

        setTimeout(() => {
          this.dispatchNavigate('name-entry');
        }, 300);
      } else {
        // Connection failed
        this.handleConnectionError(result.errorMessage || 'Failed to connect Lace wallet');
      }
    } catch (error) {
      console.error('Error connecting Lace wallet:', error);
      this.handleConnectionError(
        error instanceof Error ? error.message : 'Unknown error occurred'
      );
    }
  }

  private setButtonLoading(button: HTMLButtonElement, loading: boolean): void {
    if (loading) {
      button.disabled = true;
      button.textContent = 'Connecting...';
      button.classList.add('connecting');
    } else {
      button.disabled = false;
      button.textContent = 'Connect Lace Wallet';
      button.classList.remove('connecting');
    }
  }

  private handleConnectionError(message: string): void {
    // Re-render to reset button states
    this.render();

    this.errorText = document.getElementById('error-text');
    if (!this.errorText) return;

    // Show user-friendly error messages
    if (message.includes('user rejected') || message.includes('User rejected')) {
      this.errorText.textContent = 'Connection cancelled. Please try again.';
    } else if (message.includes('Lace wallet not found') || message.includes('extension installed')) {
      this.errorText.textContent = 'Please install the Lace Midnight Preview wallet extension.';
    } else if (message.includes('No compatible Midnight wallet')) {
      this.errorText.textContent = 'Please update your Lace wallet to a compatible version.';
    } else if (message.includes('Network ID mismatch')) {
      this.errorText.textContent = 'Network mismatch. Please switch to the correct network in Lace.';
    } else {
      this.errorText.textContent = `Error: ${message}`;
    }
  }

  private dispatchNavigate(screen: string, data: any = {}) {
    const event = new CustomEvent('navigate', {
      detail: { screen, ...data },
      bubbles: true,
    });
    this.container.dispatchEvent(event);
  }
}

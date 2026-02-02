/**
 * WalletScreen - Handles wallet connection before entering the game
 * Supports both EVM (MetaMask) and Midnight (Lace) wallets
 *
 * In mock mode (USE_TYPESCRIPT_CONTRACT=true): Only EVM wallet is needed
 * In production mode: Both EVM and Lace wallets are required
 */

import * as EffectstreamBridge from '../effectstreamBridge';
import * as LaceWalletBridge from '../laceWalletBridge';
import { MidnightService } from '../services/MidnightService';

// Wallet type selection
type WalletType = 'evm' | 'lace';

// Config from backend
interface AppConfig {
  useMockedMidnight: boolean;
  requiresLaceWallet: boolean;
  requiresEvmWallet: boolean;
}

export class WalletScreen {
  private container: HTMLElement;
  private connectEvmButton: HTMLButtonElement | null = null;
  private connectLaceButton: HTMLButtonElement | null = null;
  private continueButton: HTMLButtonElement | null = null;
  private statusText: HTMLElement | null = null;
  private errorText: HTMLElement | null = null;
  private _selectedWalletType: WalletType = 'evm';

  // Connection state
  private evmConnected: boolean = false;
  private laceConnected: boolean = false;

  // Config from backend
  // Default to production mode (require both wallets) - safer default
  // If the config fetch fails, better to require both than skip Lace accidentally
  private config: AppConfig = {
    useMockedMidnight: false,
    requiresLaceWallet: true,
    requiresEvmWallet: true,
  };

  constructor(container: HTMLElement) {
    this.container = container;
  }

  async show() {
    // Fetch config from backend to determine which wallets are needed
    await this.fetchConfig();

    // Check existing connections
    this.evmConnected = EffectstreamBridge.isWalletConnected();
    this.laceConnected = LaceWalletBridge.isLaceConnected();

    // If all required wallets are already connected, proceed
    if (this.areAllRequiredWalletsConnected()) {
      console.log('All required wallets already connected, proceeding...');
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
      const response = await fetch('http://localhost:9999/api/config');
      if (response.ok) {
        this.config = await response.json();
        console.log('[WalletScreen] Config loaded:', this.config);
      }
    } catch (error) {
      console.warn('[WalletScreen] Could not fetch config, using defaults:', error);
      // Keep defaults (mock mode)
    }
  }

  private areAllRequiredWalletsConnected(): boolean {
    const evmOk = !this.config.requiresEvmWallet || this.evmConnected;
    const laceOk = !this.config.requiresLaceWallet || this.laceConnected;
    return evmOk && laceOk;
  }

  private render() {
    const isMockMode = this.config.useMockedMidnight;
    const modeLabel = isMockMode ? '(Development Mode)' : '(Production Mode)';

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
          margin: 0 0 8px 0;
        }

        .mode-label {
          font-size: 12px;
          color: #a0aec0;
          margin: 0 0 32px 0;
          text-transform: uppercase;
          letter-spacing: 1px;
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

        .btn-evm {
          background: #667eea;
          color: white;
        }

        .btn-evm:hover:not(:disabled) {
          transform: translateY(-2px);
          box-shadow: 0 8px 20px rgba(102, 126, 234, 0.4);
        }

        .btn-lace {
          background: linear-gradient(135deg, #1a472a 0%, #2d6b3f 100%);
          color: white;
        }

        .btn-lace:hover:not(:disabled) {
          transform: translateY(-2px);
          box-shadow: 0 8px 20px rgba(26, 71, 42, 0.4);
        }

        .btn-continue {
          background: #38a169;
          color: white;
          margin-top: 16px;
        }

        .btn-continue:hover:not(:disabled) {
          transform: translateY(-2px);
          box-shadow: 0 8px 20px rgba(56, 161, 105, 0.4);
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

        .btn-disabled-mock {
          background: #a0aec0 !important;
          cursor: not-allowed;
          position: relative;
        }

        .btn-disabled-mock:hover {
          transform: none !important;
          box-shadow: none !important;
        }

        .tooltip {
          visibility: hidden;
          position: absolute;
          bottom: 100%;
          left: 50%;
          transform: translateX(-50%);
          background: #2d3748;
          color: white;
          padding: 12px 16px;
          border-radius: 8px;
          font-size: 13px;
          font-weight: 400;
          white-space: normal;
          width: 280px;
          text-align: left;
          z-index: 100;
          margin-bottom: 8px;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
          line-height: 1.4;
        }

        .tooltip::after {
          content: '';
          position: absolute;
          top: 100%;
          left: 50%;
          transform: translateX(-50%);
          border: 8px solid transparent;
          border-top-color: #2d3748;
        }

        .tooltip-wrapper {
          position: relative;
          display: inline-block;
          width: 100%;
        }

        .tooltip-wrapper:hover .tooltip {
          visibility: visible;
        }

        .tooltip code {
          background: #4a5568;
          padding: 2px 6px;
          border-radius: 4px;
          font-family: monospace;
          font-size: 11px;
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

        .divider {
          display: flex;
          align-items: center;
          margin: 24px 0;
        }

        .divider-line {
          flex: 1;
          height: 1px;
          background: #e2e8f0;
        }

        .divider-text {
          padding: 0 16px;
          color: #a0aec0;
          font-size: 14px;
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

        .hidden {
          display: none !important;
        }
      </style>

      <div class="wallet-container">
        <div class="wallet-card">
          <h1>Go Fish</h1>
          <p class="subtitle">A blockchain card game</p>
          <p class="mode-label">${modeLabel}</p>

          <div class="wallet-info">
            <p>${isMockMode ? 'Connect your wallet to start playing' : 'Connect both wallets to start playing'}</p>
            <p class="wallet-status" id="wallet-status"></p>
          </div>

          <div class="wallet-buttons">
            <div class="wallet-section">
              <div class="wallet-section-title">Midnight Network (ZK Privacy)</div>
              ${isMockMode ? `
                <div class="tooltip-wrapper">
                  <button id="connect-lace-btn" class="btn-large btn-lace btn-disabled-mock" disabled>
                    Connect Lace Wallet
                  </button>
                  <div class="tooltip">
                    Midnight contract is being mocked in development mode.<br><br>
                    To use the real Midnight network, restart without the mock flag:<br>
                    <code>deno task dev</code>
                  </div>
                </div>
              ` : `
                <button id="connect-lace-btn" class="btn-large btn-lace ${this.laceConnected ? 'btn-connected' : ''}">
                  ${this.laceConnected ? 'Lace Connected' : 'Connect Lace Wallet'}
                </button>
              `}
              <div class="connection-status">
                <span class="status-dot ${isMockMode ? 'status-disconnected' : (this.laceConnected ? 'status-connected' : 'status-disconnected')}"></span>
                <span>${isMockMode ? 'Mocked (dev mode)' : (this.laceConnected ? 'Connected' : 'Not connected')}</span>
              </div>
            </div>

            <div class="divider">
              <div class="divider-line"></div>
              <span class="divider-text">${isMockMode ? 'then' : 'and'}</span>
              <div class="divider-line"></div>
            </div>

            <div class="wallet-section">
              <div class="wallet-section-title">EVM Network (Game State)</div>
              <button id="connect-evm-btn" class="btn-large btn-evm ${this.evmConnected ? 'btn-connected' : ''}">
                ${this.evmConnected ? 'MetaMask Connected' : 'Connect MetaMask'}
              </button>
              <div class="connection-status">
                <span class="status-dot ${this.evmConnected ? 'status-connected' : 'status-disconnected'}"></span>
                <span>${this.evmConnected ? 'Connected' : 'Not connected'}</span>
              </div>
            </div>

            <button id="continue-btn" class="btn-large btn-continue ${this.areAllRequiredWalletsConnected() ? '' : 'hidden'}">
              Continue to Game
            </button>
          </div>

          <p class="error-text" id="error-text"></p>

          <div class="wallet-details">
            <p class="small-text">Supported wallets:</p>
            <p class="small-text">• Lace (Midnight Network - ZK privacy)${isMockMode ? ' [mocked]' : ''}</p>
            <p class="small-text">• MetaMask (EVM - game state)</p>
          </div>
        </div>
      </div>
    `;
    this.attachEventListeners();
  }

  private attachEventListeners(): void {
    this.connectEvmButton = document.getElementById('connect-evm-btn') as HTMLButtonElement;
    this.connectLaceButton = document.getElementById('connect-lace-btn') as HTMLButtonElement;
    this.continueButton = document.getElementById('continue-btn') as HTMLButtonElement;
    this.statusText = document.getElementById('wallet-status');
    this.errorText = document.getElementById('error-text');

    this.connectEvmButton?.addEventListener('click', () => {
      if (!this.evmConnected) {
        this.handleConnectEvmWallet();
      }
    });

    this.connectLaceButton?.addEventListener('click', () => {
      if (!this.laceConnected) {
        this.handleConnectLaceWallet();
      }
    });

    this.continueButton?.addEventListener('click', () => {
      if (this.areAllRequiredWalletsConnected()) {
        this.dispatchNavigate('name-entry');
      }
    });
  }

  private async handleConnectEvmWallet(): Promise<void> {
    if (!this.connectEvmButton || !this.statusText || !this.errorText) return;

    this._selectedWalletType = 'evm';

    // Disable button and show loading state
    this.setButtonLoading(this.connectEvmButton, true, 'evm');
    this.errorText.textContent = '';
    this.statusText.textContent = 'Opening MetaMask...';

    try {
      // Attempt to connect wallet
      const result = await EffectstreamBridge.userWalletLogin({
        mode: 0, // WalletMode.EvmInjected
      });

      if (result.success) {
        const address = EffectstreamBridge.getWalletAddress();
        console.log('EVM wallet connected successfully:', address);

        this.evmConnected = true;

        // If all wallets connected, navigate immediately without re-rendering
        if (this.areAllRequiredWalletsConnected()) {
          this.statusText.textContent = `Connected! Proceeding...`;
          this.connectEvmButton.textContent = 'MetaMask Connected';
          this.connectEvmButton.classList.remove('connecting');
          this.connectEvmButton.classList.add('btn-connected');

          setTimeout(() => {
            this.dispatchNavigate('name-entry');
          }, 300);
        } else {
          // Need more wallets, re-render to show updated state
          this.statusText.textContent = `EVM: ${this.formatAddress(address || '')}`;
          this.render();
        }
      } else {
        // Connection failed
        this.handleConnectionError(result.errorMessage || 'Failed to connect wallet');
      }
    } catch (error) {
      console.error('Error connecting EVM wallet:', error);
      this.handleConnectionError(
        error instanceof Error ? error.message : 'Unknown error occurred'
      );
    }
  }

  private async handleConnectLaceWallet(): Promise<void> {
    if (!this.connectLaceButton || !this.statusText || !this.errorText) return;

    this._selectedWalletType = 'lace';

    // Disable button and show loading state
    this.setButtonLoading(this.connectLaceButton, true, 'lace');
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

        // If all wallets connected, navigate immediately without re-rendering
        if (this.areAllRequiredWalletsConnected()) {
          this.statusText.textContent = `Connected! Proceeding...`;
          this.connectLaceButton.textContent = 'Lace Connected';
          this.connectLaceButton.classList.remove('connecting');
          this.connectLaceButton.classList.add('btn-connected');

          setTimeout(() => {
            this.dispatchNavigate('name-entry');
          }, 300);
        } else {
          // Need more wallets, re-render to show updated state
          this.statusText.textContent = `Lace: ${this.formatAddress(address || '')}`;
          this.render();
        }
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

  private setButtonLoading(button: HTMLButtonElement, loading: boolean, type: WalletType): void {
    if (loading) {
      button.disabled = true;
      button.textContent = 'Connecting...';
      button.classList.add('connecting');
    } else {
      button.disabled = false;
      button.textContent = type === 'evm' ? 'Connect MetaMask' : 'Connect Lace Wallet';
      button.classList.remove('connecting');
    }
  }

  private handleConnectionError(message: string): void {
    if (!this.statusText || !this.errorText) return;

    // Re-render to reset button states
    this.render();

    this.errorText = document.getElementById('error-text');
    if (!this.errorText) return;

    this.errorText.textContent = `Error: ${message}`;

    // Show user-friendly error messages
    if (message.includes('user rejected') || message.includes('User rejected')) {
      this.errorText.textContent = 'Connection cancelled. Please try again.';
    } else if (message.includes('No injected')) {
      this.errorText.textContent = 'Please install MetaMask or another Web3 wallet.';
    } else if (message.includes('Lace wallet not found') || message.includes('extension installed')) {
      this.errorText.textContent = 'Please install the Lace wallet browser extension.';
    } else if (message.includes('No compatible Midnight wallet')) {
      this.errorText.textContent = 'Please update your Lace wallet to a compatible version.';
    } else if (message.includes('Network ID mismatch')) {
      this.errorText.textContent = 'Network mismatch. Please switch to the Preview network in Lace.';
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

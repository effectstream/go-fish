/**
 * WalletScreen - Initializes wallets and proceeds to the game.
 *
 * Both EVM and Midnight wallets are auto-created in the browser:
 * - EVM: Local ethers.js wallet connected to Hardhat (lobby operations)
 * - Midnight: In-browser ZswapSecretKeys wallet stored in localStorage (ZK operations)
 *
 * No wallet extension (Lace, MetaMask) is required. All Midnight transactions
 * are routed through the batcher for dust balancing and chain submission.
 */

import * as EffectstreamBridge from '../effectstreamBridge';
import { MidnightService } from '../services/MidnightService';
import { soundManager } from '../three/SoundManager';

// Config from backend
interface AppConfig {
  useMockedMidnight: boolean;
  requiresLaceWallet: boolean;
  requiresEvmWallet: boolean;
}

export class WalletScreen {
  private container: HTMLElement;

  // Config from backend
  private config: AppConfig = {
    useMockedMidnight: false,
    requiresLaceWallet: false,
    requiresEvmWallet: false,
  };

  constructor(container: HTMLElement) {
    this.container = container;
  }

  async show() {
    // Fetch config from backend to determine which wallets are needed
    await this.fetchConfig();

    // Initialize the local EVM wallet automatically (no user interaction needed)
    console.log('[WalletScreen] Initializing local EVM wallet...');
    try {
      await EffectstreamBridge.userWalletLogin();
      soundManager.playSuccess();
    } catch (err) {
      soundManager.playError();
      throw err;
    }
    console.log('[WalletScreen] Local EVM wallet ready');

    // In-browser Midnight wallet is auto-created (no Lace extension needed).
    // Always proceed — the in-browser wallet + batcher handles all Midnight operations.
    console.log('[WalletScreen] In-browser wallet ready, proceeding to game...');

    // Initialize on-chain service in the background (batcher mode with in-browser wallet)
    if (!this.config.useMockedMidnight) {
      console.log('[WalletScreen] Initializing on-chain service (in-browser wallet + batcher)...');
      MidnightService.tryInitializeOnChain().then((initialized) => {
        if (initialized) {
          console.log('[WalletScreen] On-chain service initialized');
        } else {
          console.log('[WalletScreen] On-chain service not ready yet');
        }
      }).catch((error) => {
        console.error('[WalletScreen] On-chain initialization error:', error);
      });
    }

    this.dispatchNavigate('name-entry');
  }

  hide() {
    // No cleanup needed
  }

  private async fetchConfig(): Promise<void> {
    // /api/config endpoint removed — use hardcoded defaults.
  }

  private dispatchNavigate(screen: string, data: any = {}) {
    const event = new CustomEvent('navigate', {
      detail: { screen, ...data },
      bubbles: true,
    });
    this.container.dispatchEvent(event);
  }
}

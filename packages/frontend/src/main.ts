import { GameManager } from './GameManager';
import { UIManager } from './UIManager';

/**
 * Main entry point for the Go Fish game frontend
 */

class App {
  private gameManager: GameManager;
  private uiManager: UIManager;

  constructor() {
    console.log('Initializing Go Fish Game...');

    // Initialize managers
    this.gameManager = new GameManager();
    this.uiManager = new UIManager(this.gameManager);

    // Start the application
    this.init();
  }

  private async init() {
    try {
      // Initialize game manager first
      await this.gameManager.init();

      console.log('Go Fish Game initialized successfully');

      // Try to initialize Midnight contract (optional, lazy-loaded)
      this.initializeMidnight();
    } catch (error) {
      console.error('Failed to initialize game:', error);
    }
  }

  private async initializeMidnight() {
    try {
      console.log('Initializing Midnight contract...');

      // Lazy load Midnight bridge to avoid blocking app startup
      const { MidnightBridge } = await import('./midnightBridge');

      const midnightResult = await MidnightBridge.initializeMidnightContract();
      if (midnightResult.success) {
        console.log('✓ Midnight contract initialized');
      } else {
        console.warn('⚠ Midnight contract initialization failed:', midnightResult.errorMessage);
        console.warn('  Game will continue, but Midnight features may not work');
      }
    } catch (error) {
      console.error('⚠ Failed to load Midnight SDK:', error);
      console.warn('  Game will continue without Midnight features');
      console.warn('  This is expected if Midnight dependencies are not fully configured');
    }
  }
}

// Start the application when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => new App());
} else {
  new App();
}

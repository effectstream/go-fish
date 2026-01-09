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
      // Initialize game manager
      await this.gameManager.init();

      console.log('Go Fish Game initialized successfully');
    } catch (error) {
      console.error('Failed to initialize game:', error);
    }
  }
}

// Start the application when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => new App());
} else {
  new App();
}

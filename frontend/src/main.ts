import { GameManager } from './GameManager';
import { UIManager } from './UIManager';
import { MidnightService } from './services/MidnightService';
import { ThreeApp } from './three/ThreeApp';
import { SceneManager } from './three/SceneManager';
import { backgroundNotifier } from './game/BackgroundNotifier';
import { GameSessionManager } from './game/GameSessionManager';

// IMPORTANT: Set Midnight network ID at top level before any other SDK imports
// This must happen before any Midnight SDK modules are used
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
setNetworkId("undeployed");
console.log('[Main] Midnight network ID set to undeployed');

/**
 * Main entry point for the Go Fish game frontend
 */

class App {
  private gameManager: GameManager;
  private _uiManager: UIManager;
  private threeApp: ThreeApp | null = null;
  private sceneManager: SceneManager | null = null;

  constructor() {
    console.log('Initializing Go Fish Game...');

    // Initialize Three.js background
    this.initThreeBackground();

    // Initialize managers
    this.gameManager = new GameManager();
    this._uiManager = new UIManager(this.gameManager);

    // Wire background notifier — surfaces "your turn" toasts for games
    // the user isn't currently watching on the 3D canvas. Must come
    // after the DOM is ready but before any game session is created.
    backgroundNotifier.start();

    // Dev inspector — `window.__sessions()` in the console dumps a table
    // of all live sessions with their inFlight state. Non-production
    // convenience; safe to ship since it only reads manager state.
    (window as unknown as { __sessions?: () => unknown }).__sessions = () =>
      GameSessionManager.instance.debugDump();

    // Test hook — exposes the live session manager so headless tests can
    // drive actions directly (askForCard, etc.) without going through the
    // 3D canvas input layer. Safe to ship: same methods already callable
    // via GameScene event paths; this just short-circuits the UI.
    (window as unknown as { __sessionManager?: unknown }).__sessionManager =
      GameSessionManager.instance;

    // Start the application
    this.init();
  }

  private initThreeBackground(): void {
    const container = document.getElementById('three-canvas-container');
    if (!container) {
      console.warn('Three.js container not found, skipping 3D background');
      return;
    }
    try {
      this.threeApp = new ThreeApp(container);
      this.threeApp.start();

      // Scene manager listens for navigation events and switches scenes
      this.sceneManager = new SceneManager(this.threeApp);
      this.sceneManager.attach();

      console.log('[Main] Three.js background initialized');
    } catch (error) {
      console.warn('[Main] Failed to initialize Three.js background:', error);
    }
  }

  private async init() {
    try {
      // Initialize MidnightService first (loads config)
      await MidnightService.initialize();

      // Initialize game manager
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

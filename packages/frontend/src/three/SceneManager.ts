import type { ThreeApp } from './ThreeApp';
import { GameScene } from './scenes/GameScene';
import { getWalletAddress } from '../effectstreamBridge';

type ActiveScene = 'menu' | 'game';

/**
 * Manages which Three.js scene is active based on navigation events.
 * Listens to the same 'navigate' CustomEvent dispatched by UIManager.
 *
 * When entering the game screen:
 * - Hides the DOM #app-container so the Three.js canvas + HUD take over
 * - Enables pointer events on the canvas for card interaction
 *
 * When leaving the game screen:
 * - Restores the DOM #app-container for lobby/menu screens
 * - Disables pointer events on the canvas
 */
export class SceneManager {
  private app: ThreeApp;
  private activeScene: ActiveScene = 'menu';
  private gameScene: GameScene;

  constructor(app: ThreeApp) {
    this.app = app;
    this.gameScene = new GameScene(app);
  }

  attach(): void {
    document.body.addEventListener('navigate', this.onNavigate as EventListener, true);
  }

  detach(): void {
    document.body.removeEventListener('navigate', this.onNavigate as EventListener, true);
    this.gameScene.stop();
  }

  private onNavigate = (event: CustomEvent): void => {
    const { screen, lobbyId, gameId } = event.detail || {};

    if (screen === 'game') {
      this.enterGame(lobbyId || gameId);
    } else {
      this.enterMenu();
    }
  };

  private enterGame(lobbyId: string): void {
    if (this.activeScene === 'game') return;
    this.activeScene = 'game';

    const walletAddress = getWalletAddress() || '';
    console.log(`[SceneManager] Entering game scene: lobby=${lobbyId}`);

    // Hide DOM overlay so Three.js scene is fully visible and interactive
    const appContainer = document.getElementById('app-container');
    if (appContainer) {
      appContainer.style.display = 'none';
    }

    // Enable pointer events on the Three.js canvas
    const canvasContainer = document.getElementById('three-canvas-container');
    if (canvasContainer) {
      canvasContainer.style.pointerEvents = 'auto';
    }

    this.gameScene.start(lobbyId, walletAddress);
  }

  private enterMenu(): void {
    if (this.activeScene === 'menu') return;
    this.activeScene = 'menu';

    console.log('[SceneManager] Entering menu scene');
    this.gameScene.stop();

    // Restore DOM overlay for non-game screens
    const appContainer = document.getElementById('app-container');
    if (appContainer) {
      appContainer.style.display = '';
    }

    // Disable pointer events on canvas so DOM UI is interactive
    const canvasContainer = document.getElementById('three-canvas-container');
    if (canvasContainer) {
      canvasContainer.style.pointerEvents = 'none';
    }

    // Restore demo scene for visual background
    this.app.setPlayerHand([
      { rank: 'A', suit: 'hearts' },
      { rank: '3', suit: 'diamonds' },
      { rank: '5', suit: 'clubs' },
      { rank: '7', suit: 'hearts' },
    ]);
    this.app.setOpponentCardCount(4);
    this.app.setOpponentName('Opponent');
    this.app.setDeckCount(13);
  }

  dispose(): void {
    this.detach();
    this.gameScene.dispose();
  }
}

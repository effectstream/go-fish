import type { ThreeApp } from './ThreeApp';
import { GameScene } from './scenes/GameScene';
import { getWalletAddress } from '../effectstreamBridge';
import { GameSessionManager } from '../game/GameSessionManager';
import { globalLoader } from './ui/GlobalLoader';

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
  /** Lobby currently attached to gameScene. Tracked so we can swap to a
   *  different session in-place without leaving game mode. */
  private currentLobbyId: string | null = null;

  constructor(app: ThreeApp) {
    this.app = app;
    this.gameScene = new GameScene(app);
  }

  attach(): void {
    document.body.addEventListener('navigate', this.onNavigate as EventListener, true);
    // `select-game` is dispatched when the user takes an action that
    // logically picks a game (Join, Rejoin, Create) without changing
    // the visible screen. The canvas swaps to that game's scene without
    // affecting which side-panel screen is showing.
    document.body.addEventListener('select-game', this.onSelectGame as EventListener, true);
    // If the foregrounded session gets force-destroyed (e.g. user clicks ×
    // on the Active Games card for the game currently on the canvas),
    // tear the scene down — otherwise we'd render stale state from a
    // session that no longer polls.
    GameSessionManager.instance.addEventListener('sessionRemoved', this.onSessionRemoved as EventListener);
  }

  detach(): void {
    document.body.removeEventListener('navigate', this.onNavigate as EventListener, true);
    document.body.removeEventListener('select-game', this.onSelectGame as EventListener, true);
    GameSessionManager.instance.removeEventListener('sessionRemoved', this.onSessionRemoved as EventListener);
    this.gameScene.stop();
  }

  private onSelectGame = (event: CustomEvent): void => {
    const { lobbyId } = event.detail || {};
    if (lobbyId) this.enterGame(lobbyId);
  };

  private onSessionRemoved = (event: CustomEvent): void => {
    const { lobbyId } = event.detail || {};
    if (lobbyId && lobbyId === this.currentLobbyId) {
      console.log(`[SceneManager] Foregrounded session ${lobbyId} was removed — leaving game scene`);
      this.leaveGame();
    }
  };

  private onNavigate = (event: CustomEvent): void => {
    const { screen, lobbyId, gameId } = event.detail || {};

    // The canvas is only swapped by EXPLICIT game navigation:
    //   - 'game'  → user clicked an Active Games card / Resume
    //   - 'lobby' → user just created a lobby (host-only pre-EVM-fill)
    //
    // Every other navigation (main menu, wallet, name-entry, results…)
    // leaves the canvas untouched. Bouncing to the menu after P2 joins
    // no longer resets the canvas to demo — whatever game the user was
    // working with stays visible in the background. Only changing to a
    // DIFFERENT game (or explicitly dismissing) changes the canvas.
    if (screen === 'game' || screen === 'lobby') {
      this.enterGame(lobbyId || gameId);
    }
  };

  private enterGame(lobbyId: string): void {
    // Same lobby, already in game → no-op. Different lobby while in game →
    // swap the session without tearing the scene down (multi-game support).
    if (this.activeScene === 'game' && this.currentLobbyId === lobbyId) return;

    const walletAddress = getWalletAddress() || '';
    const swapping = this.activeScene === 'game';
    console.log(
      `[SceneManager] ${swapping ? 'Swapping' : 'Entering'} game scene: lobby=${lobbyId}` +
      (swapping ? ` (was ${this.currentLobbyId})` : ''),
    );

    this.activeScene = 'game';
    this.currentLobbyId = lobbyId;

    // Enable pointer events on the Three.js canvas so cards/deck are
    // clickable. `#app-container` visibility is owned by UIManager now —
    // it toggles based on which screen is active (only wallet uses it).
    const canvasContainer = document.getElementById('three-canvas-container');
    if (canvasContainer) {
      canvasContainer.style.pointerEvents = 'auto';
    }

    // gameScene.start handles both first-mount and session swap — it only
    // mounts the HUD / wires input once, and resolves the session through
    // GameSessionManager so background sessions are reused.
    this.gameScene.start(lobbyId, walletAddress);

    // Tell the manager which session is now foreground. BackgroundNotifier
    // uses this to suppress toasts for the session the user is actively
    // watching (3D turn indicator already signals the same thing there).
    GameSessionManager.instance.setForeground(lobbyId);

    // Hide the "Go Fish" intro overlay now that a game is selected as
    // foreground. It reappears on leaveGame() or on a dismiss that
    // destroys the foregrounded session.
    document.body.classList.add('has-foreground-game');

    // Unmute the full-screen loader now that the user is on the game
    // scene. While on the menu, callDelegated-driven proving/sending
    // states are suppressed (muted loader) so the menu doesn't show
    // "Awaiting confirmation: …" for background-session txs.
    globalLoader.setMuted(false);
  }

  /**
   * Called externally (e.g. by a dismiss handler) when we want to stop
   * rendering the currently foregrounded game. Not wired to navigation —
   * the canvas only changes via explicit game entry. This is the exit
   * path when the user dismisses the game they were watching.
   */
  leaveGame(): void {
    if (this.activeScene === 'menu') return;
    this.activeScene = 'menu';
    this.currentLobbyId = null;
    GameSessionManager.instance.setForeground(null);

    console.log('[SceneManager] Leaving game scene');
    this.gameScene.stop();
    globalLoader.setMuted(true);

    // No foreground game → bring back the "Go Fish" intro overlay.
    document.body.classList.remove('has-foreground-game');

    const canvasContainer = document.getElementById('three-canvas-container');
    if (canvasContainer) {
      canvasContainer.style.pointerEvents = 'none';
    }

    // Demo scene as a fallback visual.
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

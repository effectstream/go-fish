/**
 * UIManager - Handles UI state transitions and user interactions
 */

import { GameManager } from './GameManager';
import { WalletScreen } from './screens/WalletScreen';
import { NameEntryScreen } from './screens/NameEntryScreen';
import { LobbyListScreen } from './screens/LobbyListScreen';
import { LobbyScreen } from './screens/LobbyScreen';
import { GameScreen } from './screens/GameScreen';
import { ResultsScreen } from './screens/ResultsScreen';
import { LeaderboardPanel } from './screens/LeaderboardPanel';
import { GoFishGameService } from './services/GoFishGameService';

/** When true, the old DOM GameScreen is used instead of the Three.js scene. */
const USE_LEGACY_GAME_UI = import.meta.env.VITE_USE_LEGACY_GAME_UI === 'true';

export class UIManager {
  private currentScreen: string = 'wallet';
  private _gameManager: GameManager;
  /** Main full-viewport container — wallet, name-entry, game HUD */
  private container: HTMLElement;
  /** Right-side collapsible panel — lobby list, waiting room, results */
  private sidePanel: HTMLElement;

  // Screen instances
  private walletScreen: WalletScreen;
  private nameEntryScreen: NameEntryScreen;
  private lobbyListScreen: LobbyListScreen;
  private lobbyScreen: LobbyScreen;
  private gameScreen: GameScreen | null = null;
  private resultsScreen: ResultsScreen;
  private leaderboardPanel: LeaderboardPanel;

  constructor(gameManager: GameManager) {
    this._gameManager = gameManager;

    // Create main container for dynamic screens
    this.container = document.createElement('div');
    this.container.id = 'app-container';
    document.body.appendChild(this.container);

    // Side panel container (declared in index.html). Lobby-related screens
    // render into this; the main container stays for wallet / name-entry / game.
    const sidePanel = document.getElementById('side-panel');
    if (!sidePanel) {
      throw new Error('#side-panel not found in index.html');
    }
    this.sidePanel = sidePanel;
    this.injectSidePanelBackground();

    // Get game service instance
    const gameService = GoFishGameService.getInstance();

    // Initialize screens. Name-entry, lobby screens, and results all live in
    // the side panel — the main area is always the 3D canvas. The wallet
    // screen still uses the full viewport (one-time setup gate while the
    // in-browser wallet initializes).
    this.walletScreen = new WalletScreen(this.container);
    this.nameEntryScreen = new NameEntryScreen(gameService, this.sidePanel);
    this.lobbyListScreen = new LobbyListScreen(this.sidePanel);
    this.lobbyScreen = new LobbyScreen(this.sidePanel);
    this.resultsScreen = new ResultsScreen(this.sidePanel);
    this.leaderboardPanel = new LeaderboardPanel();

    this.setupEventListeners();
    this.setupLeaderboardButton();
    this.setupSideToggle();
    this.showScreen('wallet');
  }

  /** Inject a layer of slowly drifting suit glyphs behind the sidebar content.
   *  Pure decoration — animations are staggered so the group never moves as a
   *  block. Lives as a sibling to the screen content and ignores pointer events.
   *
   *  Screens overwrite the sidebar's innerHTML on render, which also wipes this
   *  layer. A MutationObserver restores it automatically whenever it vanishes. */
  private injectSidePanelBackground(): void {
    const ensureLayer = (): void => {
      if (this.sidePanel.querySelector('.sp-bg-layer')) return;
      const layer = this.buildSidePanelBackgroundLayer();
      this.sidePanel.insertBefore(layer, this.sidePanel.firstChild);
    };
    ensureLayer();
    // Watch for child-list changes and re-inject if the layer gets removed
    // (e.g., by a screen re-rendering via innerHTML = ...).
    const observer = new MutationObserver(() => ensureLayer());
    observer.observe(this.sidePanel, { childList: true });
  }

  private buildSidePanelBackgroundLayer(): HTMLDivElement {
    const layer = document.createElement('div');
    layer.className = 'sp-bg-layer';

    // Seeded deterministic positions for consistency between reloads but
    // enough variation to look organic. Durations are doubled compared to
    // the keyframe pass because `animation-direction: alternate` adds the
    // reverse leg; the full A→B→A cycle lasts 2× `dur`.
    const glyphs = [
      { s: '♠', cls: '',    top: '8%',  left: '12%', size: 70, dur: 18, delay: 0,  variant: 1 },
      { s: '♥', cls: 'red', top: '22%', left: '68%', size: 56, dur: 14, delay: 2,  variant: 2 },
      { s: '♦', cls: 'red', top: '44%', left: '20%', size: 62, dur: 20, delay: 5,  variant: 1 },
      { s: '♣', cls: '',    top: '58%', left: '78%', size: 48, dur: 16, delay: 1,  variant: 2 },
      { s: '♠', cls: '',    top: '74%', left: '10%', size: 52, dur: 22, delay: 7,  variant: 2 },
      { s: '♥', cls: 'red', top: '86%', left: '60%', size: 66, dur: 15, delay: 3,  variant: 1 },
      { s: '♦', cls: 'red', top: '12%', left: '40%', size: 40, dur: 19, delay: 4,  variant: 2 },
      { s: '♣', cls: '',    top: '38%', left: '48%', size: 44, dur: 21, delay: 6,  variant: 1 },
    ];

    for (const g of glyphs) {
      const el = document.createElement('div');
      el.className = `sp-bg-glyph ${g.cls}`;
      el.textContent = g.s;
      el.style.top = g.top;
      el.style.left = g.left;
      el.style.fontSize = `${g.size}px`;
      // `alternate` makes the browser replay the keyframes in reverse on the
      // return leg, producing a seamless back-and-forth loop (no snap at the
      // wrap boundary). Each cycle is effectively 2 × dur seconds long.
      el.style.animation = `sp-drift-${g.variant} ${g.dur}s ease-in-out ${g.delay}s infinite alternate`;
      layer.appendChild(el);
    }

    return layer;
  }

  /** Wire the hamburger button (declared in index.html) to toggle the side panel. */
  private setupSideToggle(): void {
    const btn = document.getElementById('side-toggle');
    if (!btn) return;
    const isDesktop = () => window.matchMedia('(min-width: 1024px)').matches;
    btn.addEventListener('click', () => {
      if (isDesktop()) {
        // Desktop: toggle the collapsed class (default is open)
        document.body.classList.toggle('side-collapsed');
      } else {
        // Mobile: toggle the open class (default is closed)
        document.body.classList.toggle('side-open');
      }
      // Canvas container changed width → nudge ThreeApp to re-measure
      window.dispatchEvent(new Event('resize'));
    });

    // When the viewport crosses the breakpoint, reset the appropriate class
    // so we don't leave stale state (e.g. "open" on mobile then rotating to
    // desktop where "open" isn't used).
    window.matchMedia('(min-width: 1024px)').addEventListener('change', () => {
      document.body.classList.remove('side-open');
      window.dispatchEvent(new Event('resize'));
    });
  }

  /** Listen for the leaderboard-open event dispatched by the LobbyListScreen's
   *  top-right trophy icon. The LeaderboardPanel itself is owned here. */
  private setupLeaderboardButton(): void {
    document.addEventListener('open-leaderboard', () => {
      this.leaderboardPanel.toggle();
    });
  }

  private setupEventListeners() {
    // Listen on document (not just container) because lobby screens now
    // dispatch from the side-panel container. The CustomEvent bubbles.
    document.addEventListener('navigate', ((event: CustomEvent) => {
      const { screen, lobbyId, gameId } = event.detail;

      switch (screen) {
        case 'wallet':
          this.showScreen('wallet');
          break;
        case 'name-entry':
          this.showScreen('name-entry');
          break;
        case 'lobby-list':
          this.showScreen('lobby-list');
          break;
        case 'lobby':
          this.showScreen('lobby', lobbyId);
          break;
        case 'game':
          this.showScreen('game', lobbyId || gameId);
          break;
        case 'results':
          this.showScreen('results', lobbyId || gameId);
          break;
        default:
          console.warn(`Unknown screen: ${screen}`);
      }
    }) as EventListener);
  }

  showScreen(screenId: string, param?: string) {
    // Check for duplicate navigation to game screen (prevents infinite loop)
    if (screenId === 'game' && this.currentScreen === 'game' && this.gameScreen) {
      console.log('Already showing game screen, ignoring duplicate navigation');
      return;
    }

    // Hide current screen
    this.hideCurrentScreen();

    // Show new screen
    this.currentScreen = screenId;

    // Blur the 3D canvas (and run its idle-demo animation) whenever we're
    // NOT inside a live game — so the random table activity reads as
    // ambient background, not gameplay the player should react to.
    document.body.classList.toggle('canvas-idle', screenId !== 'game');

    switch (screenId) {
      case 'wallet':
        this.walletScreen.show();
        break;
      case 'name-entry':
        this.nameEntryScreen.show();
        break;
      case 'lobby-list':
        this.lobbyListScreen.show();
        break;
      case 'lobby':
        if (param) {
          this.lobbyScreen.show(param);
        }
        break;
      case 'game':
        if (param) {
          if (USE_LEGACY_GAME_UI) {
            // Legacy DOM game screen
            this.gameScreen = new GameScreen(this.container, param);
            this.gameScreen.show();
          }
          // When legacy is off, Three.js SceneManager handles game rendering
        }
        break;
      case 'results':
        if (param) {
          this.resultsScreen.show(param);
        }
        break;
      default:
        console.warn(`Unknown screen: ${screenId}`);
    }

    console.log(`Switched to screen: ${screenId}`);
  }

  private hideCurrentScreen() {
    // Call hide method on current screen
    switch (this.currentScreen) {
      case 'wallet':
        this.walletScreen.hide();
        break;
      case 'name-entry':
        this.nameEntryScreen.hide();
        break;
      case 'lobby-list':
        this.lobbyListScreen.hide();
        break;
      case 'lobby':
        this.lobbyScreen.hide();
        break;
      case 'game':
        if (this.gameScreen) {
          this.gameScreen.hide();
        }
        break;
      case 'results':
        this.resultsScreen.hide();
        break;
    }
  }
}

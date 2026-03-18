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
  private container: HTMLElement;

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

    // Get game service instance
    const gameService = GoFishGameService.getInstance();

    // Initialize screens (GameScreen is created on-demand with lobbyId)
    this.walletScreen = new WalletScreen(this.container);
    this.nameEntryScreen = new NameEntryScreen(gameService, this.container);
    this.lobbyListScreen = new LobbyListScreen(this.container);
    this.lobbyScreen = new LobbyScreen(this.container);
    this.resultsScreen = new ResultsScreen(this.container);
    this.leaderboardPanel = new LeaderboardPanel();

    this.setupEventListeners();
    this.setupLeaderboardButton();
    this.showScreen('wallet');
  }

  private setupLeaderboardButton(): void {
    const btn = document.createElement('button');
    btn.id = 'leaderboard-toggle-btn';
    btn.textContent = '🏆';
    btn.title = 'Global Leaderboard';
    btn.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 8000;
      width: 48px;
      height: 48px;
      border-radius: 50%;
      border: 2px solid #ffd700;
      background: rgba(26, 26, 46, 0.9);
      color: #ffd700;
      font-size: 1.4em;
      cursor: pointer;
      box-shadow: 0 2px 8px rgba(0,0,0,0.5);
      transition: transform 0.15s;
    `;
    btn.addEventListener('mouseenter', () => { btn.style.transform = 'scale(1.1)'; });
    btn.addEventListener('mouseleave', () => { btn.style.transform = 'scale(1.0)'; });
    btn.addEventListener('click', () => this.leaderboardPanel.toggle());
    document.body.appendChild(btn);
  }

  private setupEventListeners() {
    // Listen for navigation events from all screens
    this.container.addEventListener('navigate', ((event: CustomEvent) => {
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

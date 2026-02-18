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
import { GoFishGameService } from './services/GoFishGameService';

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

    this.setupEventListeners();
    this.showScreen('wallet');
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
          // Create GameScreen with lobbyId
          this.gameScreen = new GameScreen(this.container, param);
          this.gameScreen.show();
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

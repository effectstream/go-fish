/**
 * UIManager - Handles UI state transitions and user interactions
 */

import { GameManager } from './GameManager';
import { LobbyListScreen } from './screens/LobbyListScreen';
import { LobbyScreen } from './screens/LobbyScreen';
import { GameScreen } from './screens/GameScreen';
import { ResultsScreen } from './screens/ResultsScreen';

export class UIManager {
  private currentScreen: string = 'lobby-list';
  private gameManager: GameManager;
  private container: HTMLElement;

  // Screen instances
  private lobbyListScreen: LobbyListScreen;
  private lobbyScreen: LobbyScreen;
  private gameScreen: GameScreen;
  private resultsScreen: ResultsScreen;

  constructor(gameManager: GameManager) {
    this.gameManager = gameManager;

    // Create main container for dynamic screens
    this.container = document.createElement('div');
    this.container.id = 'app-container';
    document.body.appendChild(this.container);

    // Initialize all screens
    this.lobbyListScreen = new LobbyListScreen(this.container);
    this.lobbyScreen = new LobbyScreen(this.container);
    this.gameScreen = new GameScreen(this.container);
    this.resultsScreen = new ResultsScreen(this.container);

    this.setupEventListeners();
    this.showScreen('lobby-list');
  }

  private setupEventListeners() {
    // Listen for navigation events from all screens
    this.container.addEventListener('navigate', ((event: CustomEvent) => {
      const { screen, lobbyId, gameId } = event.detail;

      switch (screen) {
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
    // Hide current screen
    this.hideCurrentScreen();

    // Show new screen
    this.currentScreen = screenId;

    switch (screenId) {
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
          this.gameScreen.show(param);
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
      case 'lobby-list':
        this.lobbyListScreen.hide();
        break;
      case 'lobby':
        this.lobbyScreen.hide();
        break;
      case 'game':
        this.gameScreen.hide();
        break;
      case 'results':
        this.resultsScreen.hide();
        break;
    }
  }
}

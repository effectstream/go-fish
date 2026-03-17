import { soundManager } from '../SoundManager';

export interface HUDState {
  phase: string;
  isMyTurn: boolean;
  playerName: string;
  opponentName: string;
  myScore: number;
  opponentScore: number;
  myHandSize: number;
  opponentHandSize: number;
  deckCount: number;
  myBooks: string[];
  gameLog: string[];
  isGameOver: boolean;
  respondInProgress?: boolean;
}

/**
 * HTML overlay for in-game HUD: turn indicator, scores, game log, action buttons.
 * Styled with Balatro-inspired dark theme.
 */
export class GameHUD {
  private container: HTMLDivElement;
  private turnBar: HTMLDivElement;
  private scorePanel: HTMLDivElement;
  private actionPanel: HTMLDivElement;
  private logPanel: HTMLDivElement;
  private notificationEl: HTMLDivElement;
  private opponentSelectPanel: HTMLDivElement;
  private waitingBanner: HTMLDivElement;
  private muteBtn: HTMLButtonElement;
  private notificationTimeout: number | null = null;

  // Action callbacks
  onRespondClick: (() => void) | null = null;
  onGoFishClick: (() => void) | null = null;
  onSkipDrawClick: (() => void) | null = null;
  onBackToLobby: (() => void) | null = null;

  // Opponent selection callback
  onOpponentSelected: ((opponentId: number) => void) | null = null;
  onCancelOpponentSelect: (() => void) | null = null;

  constructor() {
    this.container = document.createElement('div');
    this.container.id = 'game-hud';
    this.container.style.cssText = `
      position: fixed; top: 0; left: 0; width: 100%; height: 100%;
      z-index: 10; pointer-events: none;
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      color: #e0e0e0;
    `;

    // Turn indicator bar (top)
    this.turnBar = document.createElement('div');
    this.turnBar.style.cssText = `
      position: absolute; top: 0; left: 0; width: 100%;
      padding: 10px 20px; text-align: center;
      background: rgba(0, 0, 0, 0.6);
      backdrop-filter: blur(4px);
      font-size: 18px; font-weight: bold;
      pointer-events: none;
      border-bottom: 2px solid rgba(255, 170, 0, 0.3);
    `;
    this.container.appendChild(this.turnBar);

    // Score panel (top-left)
    this.scorePanel = document.createElement('div');
    this.scorePanel.style.cssText = `
      position: absolute; top: 50px; left: 20px;
      background: rgba(0, 0, 0, 0.5);
      backdrop-filter: blur(4px);
      border-radius: 12px; padding: 14px 18px;
      font-size: 14px; line-height: 1.6;
      border: 1px solid rgba(255, 170, 0, 0.2);
      pointer-events: none;
    `;
    this.container.appendChild(this.scorePanel);

    // Action panel (bottom-center)
    this.actionPanel = document.createElement('div');
    this.actionPanel.style.cssText = `
      position: absolute; bottom: 20px; left: 50%; transform: translateX(-50%);
      display: flex; gap: 12px;
      pointer-events: auto;
    `;
    this.container.appendChild(this.actionPanel);

    // Game log (right side)
    this.logPanel = document.createElement('div');
    this.logPanel.style.cssText = `
      position: absolute; top: 50px; right: 20px; width: 280px; max-height: 50vh;
      overflow-y: auto; background: rgba(0, 0, 0, 0.5);
      backdrop-filter: blur(4px);
      border-radius: 12px; padding: 14px;
      font-size: 12px; line-height: 1.5;
      border: 1px solid rgba(255, 170, 0, 0.2);
      pointer-events: auto;
    `;
    this.container.appendChild(this.logPanel);

    // Opponent selection panel (bottom-center, hidden by default)
    this.opponentSelectPanel = document.createElement('div');
    this.opponentSelectPanel.style.cssText = `
      position: absolute; bottom: 80px; left: 50%; transform: translateX(-50%);
      background: rgba(0, 0, 0, 0.85);
      backdrop-filter: blur(8px);
      border-radius: 16px; padding: 20px 28px;
      text-align: center;
      border: 2px solid rgba(255, 170, 0, 0.4);
      pointer-events: auto;
      display: none;
    `;
    this.container.appendChild(this.opponentSelectPanel);

    // Waiting-for-opponent persistent banner (below turn bar)
    this.waitingBanner = document.createElement('div');
    this.waitingBanner.style.cssText = `
      position: absolute; top: 52px; left: 50%; transform: translateX(-50%);
      background: rgba(0, 0, 0, 0.75);
      backdrop-filter: blur(6px);
      border-radius: 10px; padding: 10px 28px;
      text-align: center; font-size: 15px; font-weight: 600;
      border: 1px solid rgba(255, 170, 0, 0.5);
      color: #ffaa00;
      pointer-events: none;
      display: none;
    `;
    this.container.appendChild(this.waitingBanner);

    // Notification overlay (center)
    this.notificationEl = document.createElement('div');
    this.notificationEl.style.cssText = `
      position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
      background: rgba(0, 0, 0, 0.8);
      backdrop-filter: blur(8px);
      border-radius: 16px; padding: 24px 40px;
      text-align: center; font-size: 20px;
      border: 2px solid rgba(255, 170, 0, 0.4);
      pointer-events: none; opacity: 0;
      transition: opacity 0.3s ease;
    `;
    this.container.appendChild(this.notificationEl);

    // Sound mute toggle (bottom-right)
    this.muteBtn = document.createElement('button');
    this.muteBtn.textContent = '🔊';
    this.muteBtn.style.cssText = `
      position: absolute; bottom: 20px; right: 20px;
      width: 44px; height: 44px;
      background: rgba(0, 0, 0, 0.5);
      border: 1px solid rgba(255, 170, 0, 0.3);
      border-radius: 50%; font-size: 20px;
      cursor: pointer; pointer-events: auto;
      color: #e0e0e0;
      transition: background 0.2s;
    `;
    this.muteBtn.addEventListener('click', () => {
      const muted = !soundManager.muted;
      soundManager.setMuted(muted);
      this.muteBtn.textContent = muted ? '🔇' : '🔊';
    });
    this.container.appendChild(this.muteBtn);
  }

  show(): void {
    document.body.appendChild(this.container);
  }

  hide(): void {
    this.container.remove();
  }

  update(state: HUDState): void {
    this.updateTurnBar(state);
    this.updateScorePanel(state);
    this.updateActionPanel(state);
    this.updateLogPanel(state);
  }

  private updateTurnBar(state: HUDState): void {
    if (state.isGameOver) {
      this.turnBar.innerHTML = '<span style="color: #ffaa00;">Game Over!</span>';
      return;
    }

    if (state.phase === 'dealing') {
      this.turnBar.innerHTML = '<span style="color: #88ccff;">Setting Up Game...</span>';
      return;
    }

    const turnColor = state.isMyTurn ? '#ffaa00' : '#88ccff';
    const turnText = state.isMyTurn ? 'Your Turn' : `${state.opponentName}'s Turn`;
    const phaseText = this.getPhaseDescription(state.phase, state.isMyTurn, state.deckCount);

    this.turnBar.innerHTML = `
      <span style="color: ${turnColor};">${turnText}</span>
      <span style="opacity: 0.6; margin-left: 12px;">${phaseText}</span>
    `;
  }

  private getPhaseDescription(phase: string, isMyTurn: boolean, deckCount: number): string {
    switch (phase) {
      case 'turn_start': return isMyTurn ? 'Click a card to ask for its rank' : 'Opponent is choosing...';
      case 'wait_response': return isMyTurn ? 'Waiting for response...' : 'Check your hand';
      case 'wait_transfer': return 'Transferring cards...';
      case 'wait_draw': return isMyTurn
        ? (deckCount > 0 ? 'Click the deck to draw a card' : 'Deck is empty')
        : 'Opponent drawing...';
      case 'wait_draw_check': return 'Checking drawn card...';
      default: return phase;
    }
  }

  private updateScorePanel(state: HUDState): void {
    const booksHtml = state.myBooks.length > 0
      ? `<div style="margin-top: 8px; font-size: 12px; opacity: 0.7;">Books: ${state.myBooks.join(', ')}</div>`
      : '';

    this.scorePanel.innerHTML = `
      <div style="font-weight: bold; color: #ffaa00; margin-bottom: 6px;">Score</div>
      <div>${state.playerName}: <strong>${state.myScore}</strong></div>
      <div>${state.opponentName}: <strong>${state.opponentScore}</strong></div>
      <div style="margin-top: 8px; opacity: 0.6; font-size: 12px;">
        Deck: ${state.deckCount} | Your hand: ${state.myHandSize} | Their hand: ${state.opponentHandSize}
      </div>
      ${booksHtml}
    `;
  }

  private updateActionPanel(state: HUDState): void {
    this.actionPanel.innerHTML = '';

    if (state.isGameOver) {
      this.actionPanel.appendChild(
        this.createButton('Back to Lobbies', () => this.onBackToLobby?.(), '#ff9800'),
      );
      return;
    }

    // Respond button (when it's opponent's turn and we need to respond)
    // Hidden while a response is already in-flight to prevent double-submission.
    if (state.phase === 'wait_response' && !state.isMyTurn && !state.respondInProgress) {
      this.actionPanel.appendChild(
        this.createButton('Check Hand & Respond', () => {
          this.actionPanel.innerHTML = ''; // Immediately remove to prevent double-click
          this.onRespondClick?.();
        }, '#4caf50'),
      );
    } else if (state.phase === 'wait_response' && !state.isMyTurn && state.respondInProgress) {
      const btn = this.createButton('Responding...', () => {}, '#888888');
      btn.disabled = true;
      btn.style.opacity = '0.6';
      btn.style.cursor = 'not-allowed';
      this.actionPanel.appendChild(btn);
    }

    // Draw phase: deck empty → show skip button; otherwise deck click handles it
    if (state.phase === 'wait_draw' && state.isMyTurn) {
      if (state.deckCount <= 0) {
        this.actionPanel.appendChild(
          this.createButton('End Turn (Deck Empty)', () => {
            this.actionPanel.innerHTML = '';
            this.onSkipDrawClick?.();
          }, '#ff9800'),
        );
      }
      // When deck has cards, clicking the 3D deck handles drawing — no button needed
    }
  }

  private createButton(text: string, onClick: () => void, color: string): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.textContent = text;
    btn.style.cssText = `
      padding: 12px 28px;
      background: ${color};
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      transition: transform 0.15s, box-shadow 0.15s;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    `;
    btn.addEventListener('mouseenter', () => {
      btn.style.transform = 'translateY(-2px)';
      btn.style.boxShadow = '0 6px 16px rgba(0,0,0,0.4)';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.transform = '';
      btn.style.boxShadow = '0 4px 12px rgba(0,0,0,0.3)';
    });
    btn.addEventListener('click', onClick);
    return btn;
  }

  private updateLogPanel(state: HUDState): void {
    const totalEntries = state.gameLog.length;
    // Show last 20 entries, reversed so newest is on top
    const logEntries = state.gameLog.slice(-20).reverse();

    this.logPanel.innerHTML = `
      <div style="font-weight: bold; color: #ffaa00; margin-bottom: 8px;">Game Log</div>
      ${logEntries.map((entry, reverseIdx) => {
        const entryNumber = totalEntries - reverseIdx;
        const isNewest = reverseIdx === 0;
        return `<div style="opacity: ${isNewest ? '1' : '0.7'}; margin-bottom: 4px; display: flex; gap: 6px;">
          <span style="color: #ffaa00; font-weight: bold; min-width: 24px; text-align: right;">${entryNumber}.</span>
          <span>${entry}</span>
        </div>`;
      }).join('')}
    `;
    // Scroll to top since newest is on top
    this.logPanel.scrollTop = 0;
  }

  /** Show opponent selection prompt (for multi-opponent games or confirming target). */
  showOpponentSelect(rankLabel: string, opponents: Array<{ id: number; name: string }>): void {
    if (opponents.length === 0) return;

    // If only one opponent, auto-select immediately
    if (opponents.length === 1) {
      this.onOpponentSelected?.(opponents[0].id);
      return;
    }

    this.opponentSelectPanel.style.display = 'block';
    this.opponentSelectPanel.innerHTML = `
      <div style="font-weight: bold; color: #ffaa00; font-size: 18px; margin-bottom: 12px;">
        Ask who for ${rankLabel}s?
      </div>
      <div style="display: flex; gap: 10px; justify-content: center; flex-wrap: wrap;">
        ${opponents.map(opp => `
          <button data-opponent-id="${opp.id}" style="
            padding: 10px 24px; background: #4caf50; color: white;
            border: none; border-radius: 8px; font-size: 15px; font-weight: 600;
            cursor: pointer; transition: transform 0.15s, box-shadow 0.15s;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
          ">${opp.name}</button>
        `).join('')}
      </div>
      <button id="cancel-opponent-select" style="
        margin-top: 12px; padding: 8px 20px; background: transparent;
        color: #aaa; border: 1px solid #555; border-radius: 8px;
        font-size: 13px; cursor: pointer;
      ">Cancel</button>
    `;

    // Wire click handlers
    this.opponentSelectPanel.querySelectorAll('[data-opponent-id]').forEach(btn => {
      (btn as HTMLElement).onclick = () => {
        const id = parseInt((btn as HTMLElement).dataset.opponentId!, 10);
        this.hideOpponentSelect();
        this.onOpponentSelected?.(id);
      };
      (btn as HTMLElement).onmouseenter = () => {
        (btn as HTMLElement).style.transform = 'translateY(-2px)';
      };
      (btn as HTMLElement).onmouseleave = () => {
        (btn as HTMLElement).style.transform = '';
      };
    });

    const cancelBtn = this.opponentSelectPanel.querySelector('#cancel-opponent-select');
    if (cancelBtn) {
      (cancelBtn as HTMLElement).onclick = () => {
        this.hideOpponentSelect();
        this.onCancelOpponentSelect?.();
      };
    }
  }

  hideOpponentSelect(): void {
    this.opponentSelectPanel.style.display = 'none';
  }

  /** Show a prompt telling the player to click on an opponent to ask for a rank. */
  showOpponentSelectPrompt(rankLabel: string, opponentName: string): void {
    this.opponentSelectPanel.style.display = 'block';
    this.opponentSelectPanel.innerHTML = `
      <div style="font-weight: bold; color: #ffaa00; font-size: 20px; margin-bottom: 8px;">
        Ask for ${rankLabel}s
      </div>
      <div style="opacity: 0.8; font-size: 15px; margin-bottom: 14px;">
        Click on <strong style="color: #ffaa00;">${opponentName}</strong> to ask
      </div>
      <button id="cancel-opponent-select" style="
        padding: 8px 24px; background: transparent;
        color: #aaa; border: 1px solid #555; border-radius: 8px;
        font-size: 13px; cursor: pointer;
        transition: background 0.15s;
      ">Cancel</button>
    `;

    const cancelBtn = this.opponentSelectPanel.querySelector('#cancel-opponent-select');
    if (cancelBtn) {
      (cancelBtn as HTMLElement).onclick = () => {
        this.hideOpponentSelectPrompt();
        this.onCancelOpponentSelect?.();
      };
      (cancelBtn as HTMLElement).onmouseenter = () => {
        (cancelBtn as HTMLElement).style.background = 'rgba(255,255,255,0.1)';
      };
      (cancelBtn as HTMLElement).onmouseleave = () => {
        (cancelBtn as HTMLElement).style.background = 'transparent';
      };
    }
  }

  hideOpponentSelectPrompt(): void {
    this.opponentSelectPanel.style.display = 'none';
  }

  /** Show a persistent banner below the turn bar (no auto-dismiss). Use hideWaitingBanner() to clear it. */
  showWaitingBanner(message: string): void {
    this.waitingBanner.textContent = message;
    this.waitingBanner.style.display = 'block';
  }

  hideWaitingBanner(): void {
    this.waitingBanner.style.display = 'none';
  }

  showNotification(title: string, message: string, durationMs: number = 5000): void {
    if (this.notificationTimeout) {
      clearTimeout(this.notificationTimeout);
    }

    this.notificationEl.innerHTML = `
      <div style="font-weight: bold; color: #ffaa00; font-size: 24px; margin-bottom: 8px;">${title}</div>
      <div style="opacity: 0.8;">${message}</div>
    `;
    this.notificationEl.style.opacity = '1';

    this.notificationTimeout = window.setTimeout(() => {
      this.notificationEl.style.opacity = '0';
    }, durationMs);
  }

  dispose(): void {
    this.hide();
    if (this.notificationTimeout) clearTimeout(this.notificationTimeout);
  }
}

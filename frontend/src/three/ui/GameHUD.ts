import { soundManager } from '../SoundManager';
import type { GameLogEntry, GameLogSource } from '../../services/GameLogStore';

export interface HUDState {
  phase: string;
  isMyTurn: boolean;
  playerName: string;
  opponentName: string;
  /** Human-readable lobby name resolved from /lobby_state. Rendered in the
   *  top-left slot of the turn bar. Undefined while still resolving. */
  lobbyName?: string;
  /** Which player slot the viewer occupies (1 or 2). Used by the GameOver
   *  result panel to pick the right you-won / you-lost copy. */
  playerId?: 1 | 2;
  myScore: number;
  opponentScore: number;
  myHandSize: number;
  opponentHandSize: number;
  deckCount: number;
  myBooks: string[];
  opponentBooks: string[];
  gameLog: GameLogEntry[];
  isGameOver: boolean;
  /** Resolved winner from the contract. 0 = draw (legitimate, e.g.
   *  Setup-concede); 1 or 2 = that player won; undefined = not yet
   *  fetched. Only consulted when isGameOver is true. */
  winner?: 0 | 1 | 2;
  respondInProgress?: boolean;
  askInProgress?: boolean;
}

const LOG_SOURCE_COLOR: Record<GameLogSource, string> = {
  status: '#88ccff',
  action: '#ffd88a',
  response: '#b3e8a0',
  system: '#ffaa00',
};

/**
 * Render a list of booked card ranks as a possessive-plural phrase:
 *   ['4']            → "4's"
 *   ['4', 'A']       → "4's and A's"
 *   ['4', 'A', '2']  → "4's, A's and 2's"
 */
function formatBookRanks(ranks: string[]): string {
  const plurals = ranks.map(r => `${r}'s`);
  if (plurals.length === 0) return '';
  if (plurals.length === 1) return plurals[0];
  if (plurals.length === 2) return `${plurals[0]} and ${plurals[1]}`;
  const head = plurals.slice(0, -1).join(', ');
  return `${head} and ${plurals[plurals.length - 1]}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
  private volumeSlider: HTMLInputElement;
  private menuBtn: HTMLButtonElement;
  private menuPopover: HTMLDivElement;
  private modalOverlay: HTMLDivElement;
  private menuOpen = false;
  private notificationTimeout: number | null = null;
  /** Last phase seen by updateActionPanel — the 3-dots menu's label copy
   *  ("Concede" vs "Close Game") depends on this. */
  private lastPhase: string = '';

  // Action callbacks
  onRespondClick: (() => void) | null = null;
  onGoFishClick: (() => void) | null = null;
  onSkipDrawClick: (() => void) | null = null;
  onBackToLobby: (() => void) | null = null;
  /** Fires when the user confirms Concede / Close Game from the 3-dots menu. */
  onConcedeClick: (() => void) | null = null;

  // Opponent selection callback
  onOpponentSelected: ((opponentId: number) => void) | null = null;
  onCancelOpponentSelect: (() => void) | null = null;

  constructor() {
    this.container = document.createElement('div');
    this.container.id = 'game-hud';
    // Constrain to the canvas region (not the side panel) by anchoring with
    // top/left/right/bottom instead of width:100%. On desktop --side-panel-width
    // is 340px, so the HUD stops at the sidebar; on mobile it's 0 and the HUD
    // still spans the full viewport (sidebar overlays on top when opened).
    this.container.style.cssText = `
      position: fixed; top: 0; left: 0; right: var(--side-panel-width, 0px); bottom: 0;
      z-index: 10; pointer-events: none;
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      color: #e0e0e0;
    `;

    // Turn indicator bar (top) — 3-slot grid: [player name] [turn status] [phase]
    this.turnBar = document.createElement('div');
    this.turnBar.style.cssText = `
      position: absolute; top: 0; left: 0; width: 100%;
      padding: 10px 20px;
      display: grid;
      grid-template-columns: 1fr auto 1fr;
      align-items: center;
      gap: 12px;
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

    // Game log (under the Score panel, left column)
    this.logPanel = document.createElement('div');
    this.logPanel.style.cssText = `
      position: absolute; top: 210px; left: 20px; width: 280px; max-height: calc(100vh - 280px);
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

    // Sound controls (bottom-right): mute toggle + volume slider.
    const audioGroup = document.createElement('div');
    audioGroup.style.cssText = `
      position: absolute; bottom: 20px; right: 20px;
      display: flex; align-items: center; gap: 10px;
      background: rgba(0, 0, 0, 0.5);
      border: 1px solid rgba(255, 170, 0, 0.3);
      border-radius: 22px;
      padding: 4px 12px 4px 4px;
      pointer-events: auto;
    `;

    this.muteBtn = document.createElement('button');
    this.muteBtn.textContent = soundManager.muted ? '🔇' : '🔊';
    this.muteBtn.dataset.sfx = 'none'; // don't self-trigger a UI click sound
    this.muteBtn.style.cssText = `
      width: 36px; height: 36px;
      background: transparent;
      border: none;
      border-radius: 50%; font-size: 18px;
      cursor: pointer; color: #e0e0e0;
      display: flex; align-items: center; justify-content: center;
    `;
    this.muteBtn.addEventListener('click', () => {
      const muted = !soundManager.muted;
      soundManager.setMuted(muted);
      this.muteBtn.textContent = muted ? '🔇' : '🔊';
    });
    audioGroup.appendChild(this.muteBtn);

    this.volumeSlider = document.createElement('input');
    this.volumeSlider.type = 'range';
    this.volumeSlider.min = '0';
    this.volumeSlider.max = '1';
    this.volumeSlider.step = '0.05';
    this.volumeSlider.value = String(soundManager.volume);
    this.volumeSlider.style.cssText = `
      width: 80px; accent-color: #ffaa00; cursor: pointer;
    `;
    this.volumeSlider.addEventListener('input', () => {
      soundManager.setVolume(parseFloat(this.volumeSlider.value));
    });
    audioGroup.appendChild(this.volumeSlider);

    this.container.appendChild(audioGroup);

    // Three-dots `⋮` menu — top-right of the canvas. Holds destructive /
    // rare actions (Concede, Close Game) so we don't pile more buttons
    // onto the main HUD. Phase-dependent label handled in updateMenu().
    this.menuBtn = document.createElement('button');
    this.menuBtn.className = 'hud-menu-btn';
    this.menuBtn.textContent = '⋮';
    this.menuBtn.title = 'More actions';
    this.menuBtn.setAttribute('aria-label', 'More actions');
    this.menuBtn.dataset.sfx = 'none';
    this.menuBtn.style.cssText = `
      position: absolute; top: 10px; right: 18px;
      width: 36px; height: 36px;
      z-index: 20;
      background: rgba(0, 0, 0, 0.55);
      color: #ffcc66;
      border: 1px solid rgba(255, 170, 0, 0.45);
      border-radius: 10px;
      font-size: 22px;
      font-weight: 700;
      line-height: 1;
      cursor: pointer;
      pointer-events: auto;
      display: flex; align-items: center; justify-content: center;
      transition: background 0.15s ease, border-color 0.15s ease;
    `;
    this.menuBtn.addEventListener('mouseenter', () => {
      this.menuBtn.style.background = 'rgba(0, 0, 0, 0.75)';
      this.menuBtn.style.borderColor = '#ffaa00';
    });
    this.menuBtn.addEventListener('mouseleave', () => {
      this.menuBtn.style.background = 'rgba(0, 0, 0, 0.55)';
      this.menuBtn.style.borderColor = 'rgba(255, 170, 0, 0.45)';
    });
    this.menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleMenu();
    });
    this.container.appendChild(this.menuBtn);

    // Popover that drops down from the 3-dots button.
    this.menuPopover = document.createElement('div');
    this.menuPopover.className = 'hud-menu-popover';
    this.menuPopover.style.cssText = `
      position: absolute; top: 52px; right: 18px;
      z-index: 21;
      min-width: 180px;
      background: rgba(20, 10, 20, 0.94);
      backdrop-filter: blur(6px);
      border: 1px solid rgba(255, 170, 0, 0.45);
      border-radius: 10px;
      padding: 6px;
      box-shadow: 0 6px 22px rgba(0, 0, 0, 0.55);
      pointer-events: auto;
      display: none;
    `;
    this.container.appendChild(this.menuPopover);

    // Click outside → close popover. Attached to the container's parent
    // (document) because the HUD itself has pointer-events: none on
    // non-interactive areas; the capture-phase listener sees clicks before
    // any other handler.
    document.addEventListener('click', (e) => {
      if (!this.menuOpen) return;
      const target = e.target as Node | null;
      if (target && (this.menuBtn.contains(target) || this.menuPopover.contains(target))) return;
      this.closeMenu();
    });

    // Modal overlay — owned by the HUD so confirmations stay on top of the
    // canvas. Hidden until showConfirmModal() populates it.
    this.modalOverlay = document.createElement('div');
    this.modalOverlay.className = 'hud-modal-overlay';
    this.modalOverlay.style.cssText = `
      position: fixed; inset: 0;
      z-index: 50;
      background: rgba(0, 0, 0, 0.55);
      backdrop-filter: blur(3px);
      display: none;
      align-items: center;
      justify-content: center;
      pointer-events: auto;
    `;
    this.modalOverlay.addEventListener('click', (e) => {
      if (e.target === this.modalOverlay) this.hideConfirmModal();
    });
    this.container.appendChild(this.modalOverlay);
  }

  show(): void {
    document.body.appendChild(this.container);
    this.renderInitialPlaceholders();
  }

  /**
   * Paint title + "Loading…" placeholders in the turn bar, score panel, and
   * log panel the moment the HUD mounts. Without this, the backing boxes sit
   * empty until the first `update()` call (which only fires after the first
   * game-state poll settles), which reads as a broken render.
   */
  private renderInitialPlaceholders(): void {
    this.turnBar.innerHTML = `
      <span class="hud-name-slot loading-placeholder">Loading…</span>
      <span class="hud-turn-slot loading-placeholder">Loading…</span>
      <span class="hud-phase-slot"></span>
    `;
    this.scorePanel.innerHTML = `
      <div style="font-weight: bold; color: #ffaa00; margin-bottom: 6px;">Score</div>
      <div>Player: <span class="loading-placeholder">Loading…</span></div>
      <div style="margin-top: 6px;">Opponent: <span class="loading-placeholder">Loading…</span></div>
      <div style="margin-top: 8px; opacity: 0.6; font-size: 12px;">
        <span class="loading-placeholder">Loading…</span>
      </div>
    `;
    this.logPanel.innerHTML = `
      <div style="font-weight: bold; color: #ffaa00; margin-bottom: 8px;">Game Log</div>
      <div class="loading-placeholder">Loading…</div>
    `;
  }

  hide(): void {
    this.container.remove();
  }

  update(state: HUDState): void {
    this.lastPhase = state.phase;
    this.updateTurnBar(state);
    this.updateScorePanel(state);
    this.updateActionPanel(state);
    this.updateLogPanel(state);
    this.updateMenu(state);
  }

  /**
   * Toggle 3-dots button visibility + popover contents based on game phase.
   * - GameOver: hide the button entirely (nothing to do).
   * - Setup (phase === 'dealing'): label = "Close Game" (draw outcome).
   * - Active: label = "Concede" (opponent wins).
   */
  private updateMenu(state: HUDState): void {
    if (state.isGameOver) {
      this.menuBtn.style.display = 'none';
      this.closeMenu();
      return;
    }
    this.menuBtn.style.display = 'flex';

    const isSetup = state.phase === 'dealing';
    const label = isSetup ? 'Close Game' : 'Concede';
    this.menuPopover.innerHTML = `
      <button class="hud-menu-item tx-guarded" data-action="concede" style="
        display: block;
        width: 100%;
        background: transparent;
        color: #ffcccc;
        border: none;
        padding: 10px 14px;
        text-align: left;
        font-size: 14px;
        font-weight: 600;
        border-radius: 6px;
        cursor: pointer;
        transition: background 0.12s ease;
      ">${label}</button>
    `;
    const itemBtn = this.menuPopover.querySelector('[data-action="concede"]') as HTMLButtonElement | null;
    if (itemBtn) {
      itemBtn.addEventListener('mouseenter', () => {
        itemBtn.style.background = 'rgba(255, 60, 60, 0.18)';
      });
      itemBtn.addEventListener('mouseleave', () => {
        itemBtn.style.background = 'transparent';
      });
      itemBtn.addEventListener('click', () => {
        this.closeMenu();
        this.promptConcede(isSetup);
      });
    }
  }

  private toggleMenu(): void {
    if (this.menuOpen) this.closeMenu();
    else this.openMenu();
  }

  private openMenu(): void {
    this.menuPopover.style.display = 'block';
    this.menuOpen = true;
  }

  private closeMenu(): void {
    this.menuPopover.style.display = 'none';
    this.menuOpen = false;
  }

  /** Build and show the Concede / Close Game confirmation modal. */
  private promptConcede(isSetup: boolean): void {
    const title = isSetup ? 'Close this game?' : 'Concede this game?';
    const body = isSetup
      ? 'Both players will be marked a draw. No winner, no loser.'
      : 'Your opponent will win. This cannot be undone.';
    const confirmLabel = isSetup ? 'Close Game' : 'Concede';
    this.showConfirmModal({
      title,
      body,
      confirmLabel,
      danger: true,
      onConfirm: () => {
        this.hideConfirmModal();
        this.onConcedeClick?.();
      },
    });
  }

  private showConfirmModal(opts: {
    title: string;
    body: string;
    confirmLabel: string;
    cancelLabel?: string;
    danger?: boolean;
    onConfirm: () => void;
  }): void {
    const confirmBg = opts.danger ? '#b5322c' : '#4caf50';
    this.modalOverlay.innerHTML = `
      <div class="hud-modal" style="
        background: rgba(25, 15, 20, 0.96);
        border: 1px solid rgba(255, 170, 0, 0.4);
        border-radius: 14px;
        padding: 22px 24px;
        max-width: 420px;
        color: #f0e6d0;
        font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
        box-shadow: 0 10px 36px rgba(0, 0, 0, 0.55);
      ">
        <h3 style="margin: 0 0 10px; color: #ffaa00; font-size: 20px;">${escapeHtml(opts.title)}</h3>
        <p style="margin: 0 0 18px; line-height: 1.45; opacity: 0.9;">${escapeHtml(opts.body)}</p>
        <div style="display: flex; gap: 10px; justify-content: flex-end;">
          <button class="hud-modal-cancel tx-guarded" style="
            padding: 10px 18px;
            background: transparent;
            color: #ccc;
            border: 1px solid #555;
            border-radius: 8px;
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
          ">${escapeHtml(opts.cancelLabel ?? 'Cancel')}</button>
          <button class="hud-modal-confirm tx-guarded" style="
            padding: 10px 20px;
            background: ${confirmBg};
            color: white;
            border: none;
            border-radius: 8px;
            font-size: 14px;
            font-weight: 700;
            cursor: pointer;
          ">${escapeHtml(opts.confirmLabel)}</button>
        </div>
      </div>
    `;
    const confirmBtn = this.modalOverlay.querySelector('.hud-modal-confirm') as HTMLButtonElement | null;
    const cancelBtn = this.modalOverlay.querySelector('.hud-modal-cancel') as HTMLButtonElement | null;
    if (confirmBtn) confirmBtn.addEventListener('click', opts.onConfirm);
    if (cancelBtn) cancelBtn.addEventListener('click', () => this.hideConfirmModal());
    this.modalOverlay.style.display = 'flex';
  }

  private hideConfirmModal(): void {
    this.modalOverlay.style.display = 'none';
    this.modalOverlay.innerHTML = '';
  }

  private updateTurnBar(state: HUDState): void {
    // Left slot: the lobby name — visible at all times so users managing
    // multiple games can tell at a glance which game they're looking at.
    const nameSlot = state.lobbyName
      ? `<span class="hud-name-slot" style="
           justify-self: start;
           color: #e0e0e0;
           font-size: 14px;
           font-weight: 600;
           opacity: 0.85;
           max-width: 260px;
           overflow: hidden;
           text-overflow: ellipsis;
           white-space: nowrap;
         ">${escapeHtml(state.lobbyName)}</span>`
      : `<span class="hud-name-slot loading-placeholder" style="justify-self: start; font-size: 14px;">Loading…</span>`;

    // Choose the centre turn-status content + right-slot phase text.
    let turnHtml: string;
    let phaseHtml: string = '';

    if (state.isGameOver) {
      // Winner-specific copy once getWinner resolves. While it's still
      // loading (GameScene kicks off the read on the isGameOver edge),
      // fall back to the generic "Game Over!" so the user sees something.
      if (state.winner === 0) {
        turnHtml = '<span style="color: #88ccff;">🤝 It\'s a Draw</span>';
      } else if (state.winner !== undefined && state.playerId !== undefined) {
        const won = state.winner === state.playerId;
        turnHtml = won
          ? '<span style="color: #b3e8a0;">🎉 You Won!</span>'
          : '<span style="color: #ff9e9e;">😔 You Lost</span>';
      } else {
        turnHtml = '<span style="color: #ffaa00;">Game Over!</span>';
      }
    } else if (state.phase === 'dealing' || (state.phase === 'turn_start' && state.myHandSize === 0)) {
      // Indexer lag: phase may flip to turn_start before cards arrive in the
      // player's hand. Keep showing "Setting Up" until the local hand is
      // non-empty so the player doesn't see "Click a card to ask" with zero
      // cards visible.
      turnHtml = '<span style="color: #88ccff;">Setting Up Game...</span>';
    } else if (state.askInProgress && state.isMyTurn) {
      // While our ask is in flight (batcher queued, waiting for on-chain
      // confirmation), keep showing "Waiting for response" even if the chain
      // state still reports turn_start. This prevents the brief flicker back
      // to "Click a card to ask" between submission and the phase advancing
      // to wait_response on-chain.
      turnHtml = '<span style="color: #ffaa00;">Your Turn</span>';
      phaseHtml = 'Waiting for opponent\'s response...';
    } else {
      const turnColor = state.isMyTurn ? '#ffaa00' : '#88ccff';
      const turnText = state.isMyTurn ? 'Your Turn' : `${state.opponentName}'s Turn`;
      turnHtml = `<span style="color: ${turnColor};">${turnText}</span>`;
      phaseHtml = this.getPhaseDescription(state.phase, state.isMyTurn, state.deckCount);
    }

    this.turnBar.innerHTML = `
      ${nameSlot}
      <span class="hud-turn-slot">${turnHtml}</span>
      <span class="hud-phase-slot" style="
        justify-self: end;
        opacity: 0.6;
        font-size: 14px;
        font-weight: normal;
        max-width: 320px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      ">${phaseHtml}</span>
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
    const myBooksLine = state.myBooks.length > 0
      ? `<div style="margin-top: 2px; font-size: 12px; opacity: 0.75;">Books: ${formatBookRanks(state.myBooks)}</div>`
      : '';
    const oppBooksLine = state.opponentBooks.length > 0
      ? `<div style="margin-top: 2px; font-size: 12px; opacity: 0.75;">Books: ${formatBookRanks(state.opponentBooks)}</div>`
      : '';

    this.scorePanel.innerHTML = `
      <div style="font-weight: bold; color: #ffaa00; margin-bottom: 6px;">Score</div>
      <div>${state.playerName}: <strong>${state.myScore}</strong></div>
      ${myBooksLine}
      <div style="margin-top: 6px;">${state.opponentName}: <strong>${state.opponentScore}</strong></div>
      ${oppBooksLine}
      <div style="margin-top: 8px; opacity: 0.6; font-size: 12px;">
        Deck: ${state.deckCount} | Your hand: ${state.myHandSize} | Their hand: ${state.opponentHandSize}
      </div>
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

    // Respond is fully automatic — status is communicated via the bottom-left
    // loader (proving ♥ → sending ♦). No action panel UI needed here.

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
        const sourceColor = LOG_SOURCE_COLOR[entry.source] ?? '#ffaa00';
        return `<div style="opacity: ${isNewest ? '1' : '0.7'}; margin-bottom: 4px; display: flex; gap: 6px;">
          <span style="color: #ffaa00; font-weight: bold; min-width: 24px; text-align: right;">${entryNumber}.</span>
          <span style="color: ${sourceColor};">${escapeHtml(entry.message)}</span>
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

/**
 * LeaderboardPanel — floating modal showing global Go Fish leaderboard.
 *
 * Usage:
 *   const panel = new LeaderboardPanel();
 *   panel.toggle(); // show/hide
 */

import { API_BASE_URL } from '../apiConfig';

interface LeaderboardEntry {
  midnight_address: string;
  total_points: number;
  games_played: number;
  games_won: number;
}

export class LeaderboardPanel {
  private overlay: HTMLElement;
  private tableBody: HTMLElement;
  private refreshInterval: number | null = null;
  private visible = false;

  constructor() {
    this.overlay = this.createOverlay();
    document.body.appendChild(this.overlay);
    this.tableBody = this.overlay.querySelector('.leaderboard-tbody')!;
  }

  private createOverlay(): HTMLElement {
    const overlay = document.createElement('div');
    overlay.id = 'leaderboard-overlay';
    overlay.style.cssText = `
      display: none;
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.75);
      z-index: 9000;
      align-items: center;
      justify-content: center;
    `;

    overlay.innerHTML = `
      <div class="leaderboard-panel" style="
        background: #1a1a2e;
        border: 1px solid #4a4a8a;
        border-radius: 12px;
        padding: 24px;
        min-width: 560px;
        max-width: 90vw;
        max-height: 80vh;
        overflow-y: auto;
        color: #e0e0e0;
        font-family: monospace;
      ">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
          <h2 style="margin:0; font-size:1.4em;">🏆 Global Leaderboard</h2>
          <button id="leaderboard-close-btn" style="
            background: none; border: none; color: #aaa;
            font-size: 1.6em; cursor: pointer; padding: 0 4px;
          ">&times;</button>
        </div>
        <table style="width:100%; border-collapse: collapse; font-size: 0.9em;">
          <thead>
            <tr style="border-bottom: 1px solid #4a4a8a; color: #aaa; text-align:left;">
              <th style="padding: 6px 8px;">#</th>
              <th style="padding: 6px 8px;">Address</th>
              <th style="padding: 6px 8px; text-align:right;">Points</th>
              <th style="padding: 6px 8px; text-align:right;">Wins</th>
              <th style="padding: 6px 8px; text-align:right;">Played</th>
            </tr>
          </thead>
          <tbody class="leaderboard-tbody"></tbody>
        </table>
        <div class="leaderboard-empty" style="display:none; text-align:center; padding:20px; color:#888;">
          No entries yet — play a game to get on the board!
        </div>
      </div>
    `;

    overlay.querySelector('#leaderboard-close-btn')!.addEventListener('click', () => this.hide());
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this.hide();
    });

    return overlay;
  }

  show(): void {
    if (this.visible) return;
    this.visible = true;
    this.overlay.style.display = 'flex';
    this.fetchAndRender();
    this.refreshInterval = window.setInterval(() => this.fetchAndRender(), 10_000);
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.overlay.style.display = 'none';
    if (this.refreshInterval !== null) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
  }

  toggle(): void {
    this.visible ? this.hide() : this.show();
  }

  private async fetchAndRender(): Promise<void> {
    try {
      const response = await fetch(`${API_BASE_URL}/api/leaderboard?limit=50&offset=0`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const entries: LeaderboardEntry[] = await response.json();
      this.render(entries);
    } catch (err) {
      console.warn('[LeaderboardPanel] Fetch failed:', err);
      this.tableBody.innerHTML = `
        <tr><td colspan="5" style="text-align:center; padding:16px; color:#e88;">
          Failed to load leaderboard. Please try again.
        </td></tr>
      `;
    }
  }

  private render(entries: LeaderboardEntry[]): void {
    const emptyEl = this.overlay.querySelector('.leaderboard-empty') as HTMLElement;
    if (entries.length === 0) {
      this.tableBody.innerHTML = '';
      emptyEl.style.display = 'block';
      return;
    }
    emptyEl.style.display = 'none';
    this.tableBody.innerHTML = entries.map((entry, i) => {
      const addr = entry.midnight_address;
      const shortAddr = addr.length > 20
        ? `${addr.slice(0, 10)}…${addr.slice(-6)}`
        : addr;
      const rowBg = i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.03)';
      return `
        <tr style="background:${rowBg};">
          <td style="padding:6px 8px; color:#aaa;">${i + 1}</td>
          <td style="padding:6px 8px; font-family:monospace; font-size:0.85em;" title="${addr}">${shortAddr}</td>
          <td style="padding:6px 8px; text-align:right; color:#ffd700; font-weight:bold;">${entry.total_points}</td>
          <td style="padding:6px 8px; text-align:right;">${entry.games_won}</td>
          <td style="padding:6px 8px; text-align:right; color:#aaa;">${entry.games_played}</td>
        </tr>
      `;
    }).join('');
  }
}

import { GameSessionManager } from './GameSessionManager';
import type { GameSession } from './GameSession';
import type { NeedsAttentionDetail } from './types';
import { soundManager } from '../three/SoundManager';

const TOAST_ID = 'bg-notifier-toast';
const TOAST_STYLE_ID = 'bg-notifier-style';
const TOAST_DURATION_MS = 6000;

/**
 * Surfaces background-session "your turn" transitions as a toast + sound.
 *
 * Foreground sessions are ignored — the 3D turn indicator already handles
 * them. Only session transitions into `YOUR TURN` that happen while the
 * user is viewing a *different* game (or the lobby) are surfaced here.
 *
 * Lives as a singleton wired at app boot (see `main.ts`). Subscribes to
 * the manager's add/remove events so sessions created later are picked up
 * automatically; no explicit registration needed.
 */
class BackgroundNotifierImpl {
  private started = false;
  /** Per-session listener teardowns, keyed by lobbyId. */
  private sessionUnsubs = new Map<string, () => void>();
  /** Last toast lobbyId (for focus / coalescing). */
  private lastToastLobbyId: string | null = null;
  /** Pending timeout for auto-dismissing the current toast. */
  private dismissTimer: number | null = null;

  start(): void {
    if (this.started) return;
    this.started = true;

    const manager = GameSessionManager.instance;

    // Wire any sessions already in the manager at boot.
    for (const session of manager.list()) {
      this.attachToSession(session);
    }

    manager.addEventListener('sessionAdded', ((ev: Event) => {
      const { session } = (ev as CustomEvent).detail as { session: GameSession };
      this.attachToSession(session);
    }) as EventListener);

    manager.addEventListener('sessionRemoved', ((ev: Event) => {
      const { lobbyId } = (ev as CustomEvent).detail as { lobbyId: string };
      this.detachFromSession(lobbyId);
    }) as EventListener);

    this.ensureStyles();
  }

  private attachToSession(session: GameSession): void {
    if (this.sessionUnsubs.has(session.lobbyId)) return;
    const listener = (ev: Event) => {
      const detail = (ev as CustomEvent).detail as NeedsAttentionDetail;
      this.handleNeedsAttention(session, detail);
    };
    session.addEventListener('needsAttention', listener);
    this.sessionUnsubs.set(session.lobbyId, () =>
      session.removeEventListener('needsAttention', listener),
    );
  }

  private detachFromSession(lobbyId: string): void {
    const unsub = this.sessionUnsubs.get(lobbyId);
    if (unsub) {
      unsub();
      this.sessionUnsubs.delete(lobbyId);
    }
  }

  private handleNeedsAttention(session: GameSession, detail: NeedsAttentionDetail): void {
    // Ignore the session currently attached to the 3D canvas — the user
    // is already seeing the turn indicator there.
    const fg = GameSessionManager.instance.foregroundLobbyId;
    if (fg === session.lobbyId) return;

    const state = detail.snapshot.state;
    const opponentName = state?.opponentName ?? 'Opponent';
    const lobbyLabel = this.formatLobbyLabel(session.lobbyId, opponentName);

    this.showToast(
      session.lobbyId,
      `Your turn — ${lobbyLabel}`,
      `Tap to switch games`,
    );
    soundManager.playNotification();
  }

  /** Compose a short label for the toast — prefer the opponent name if
   *  we have it, else a lobby-id suffix. */
  private formatLobbyLabel(lobbyId: string, opponentName: string): string {
    if (opponentName && opponentName !== 'Opponent') return `vs ${opponentName}`;
    return `game ${lobbyId.slice(0, 8)}`;
  }

  private showToast(lobbyId: string, title: string, body: string): void {
    const el = this.ensureToastEl();
    this.lastToastLobbyId = lobbyId;
    el.innerHTML = `
      <div class="bg-toast-title">${this.escapeHtml(title)}</div>
      <div class="bg-toast-body">${this.escapeHtml(body)}</div>
    `;
    el.classList.add('visible');

    if (this.dismissTimer !== null) {
      clearTimeout(this.dismissTimer);
    }
    this.dismissTimer = window.setTimeout(() => {
      el.classList.remove('visible');
      this.dismissTimer = null;
    }, TOAST_DURATION_MS);
  }

  /** Click the toast to switch foreground to that game. */
  private onToastClick = (): void => {
    if (!this.lastToastLobbyId) return;
    // Dispatch the same navigate event the sidebar uses — SceneManager
    // will swap the canvas, GameSessionManager will update foreground.
    document.dispatchEvent(
      new CustomEvent('navigate', {
        detail: { screen: 'game', lobbyId: this.lastToastLobbyId },
        bubbles: true,
      }),
    );
    const el = document.getElementById(TOAST_ID);
    el?.classList.remove('visible');
  };

  private ensureToastEl(): HTMLElement {
    let el = document.getElementById(TOAST_ID);
    if (el) return el;
    el = document.createElement('div');
    el.id = TOAST_ID;
    el.addEventListener('click', this.onToastClick);
    document.body.appendChild(el);
    return el;
  }

  private ensureStyles(): void {
    if (document.getElementById(TOAST_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = TOAST_STYLE_ID;
    style.textContent = `
      #${TOAST_ID} {
        position: fixed;
        /* Top-right, below the hamburger / above everything else. Respects
           the desktop sidebar width so the toast stays inside the canvas
           region, not under the panel. */
        top: 14px;
        right: calc(var(--side-panel-width, 0px) + 14px);
        z-index: 9500;
        min-width: 240px;
        max-width: 360px;
        padding: 12px 18px;
        background: linear-gradient(180deg, rgba(30, 24, 8, 0.92) 0%, rgba(14, 10, 4, 0.92) 100%);
        border: 1px solid rgba(250, 204, 21, 0.5);
        border-radius: 10px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.55), 0 0 22px rgba(250, 204, 21, 0.25);
        color: #fde68a;
        font-family: 'Inter', 'Segoe UI', system-ui, sans-serif;
        opacity: 0;
        transform: translateY(-12px);
        transition: opacity 0.22s ease, transform 0.22s ease;
        pointer-events: none;
        cursor: pointer;
      }
      #${TOAST_ID}.visible {
        opacity: 1;
        transform: translateY(0);
        pointer-events: auto;
      }
      #${TOAST_ID} .bg-toast-title {
        font-family: 'Cinzel', 'Georgia', serif;
        font-weight: 700;
        font-size: 14px;
        letter-spacing: 0.08em;
        color: #facc15;
        margin-bottom: 2px;
      }
      #${TOAST_ID} .bg-toast-body {
        font-size: 12px;
        letter-spacing: 0.02em;
        opacity: 0.85;
      }
    `;
    document.head.appendChild(style);
  }

  private escapeHtml(s: string): string {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}

export const backgroundNotifier = new BackgroundNotifierImpl();

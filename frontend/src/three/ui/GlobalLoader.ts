/**
 * GlobalLoader — animated status indicator at the bottom-left of the screen.
 *
 * Two visual states:
 *   - 'proving'  → floating hearts (♥), red   — WASM proof generation
 *   - 'sending'  → floating diamonds (♦), blue — posting to batcher / waiting for chain
 *
 * Symbols randomly rotate, scale, and fade on staggered loops so the motion
 * looks organic even though everything is pure CSS.
 *
 * Usage:
 *   globalLoader.show('proving', 'Proving — generating ZK circuit...');
 *   globalLoader.show('sending', 'Submitting to chain...');
 *   globalLoader.hide();
 *
 * Idempotent: show() with the same (state, message) is a no-op; changing
 * either updates in place without destroying the DOM node.
 */

export type LoaderState = 'proving' | 'sending' | 'waiting';

const STYLE_ID = 'global-loader-style';
const ROOT_ID = 'global-loader-root';

const SYMBOLS: Record<LoaderState, string> = {
  proving: '♥',
  sending: '♦',
  waiting: '♠',
};

const COLORS: Record<LoaderState, string> = {
  proving: '#e53935',
  sending: '#42a5f5',
  waiting: '#9e9e9e',
};

/** Per-state animation duration. Slower for 'waiting' so it reads as idle/ambient. */
const DURATION_BASE: Record<LoaderState, number> = {
  proving: 1.4,
  sending: 1.4,
  waiting: 3.0,
};

const DURATION_JITTER: Record<LoaderState, number> = {
  proving: 0.8,
  sending: 0.8,
  waiting: 1.4,
};

const SYMBOL_COUNT = 6;

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #${ROOT_ID} {
      position: fixed;
      bottom: 20px;
      left: 20px;
      z-index: 9000;
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 16px 10px 12px;
      background: rgba(20, 20, 30, 0.82);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 12px;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.4);
      backdrop-filter: blur(4px);
      font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
      opacity: 0;
      transform: translateY(8px);
      transition: opacity 0.25s ease, transform 0.25s ease;
      pointer-events: none;
    }
    #${ROOT_ID}.visible {
      opacity: 1;
      transform: translateY(0);
    }
    #${ROOT_ID} .gl-symbols {
      display: flex;
      align-items: center;
      gap: 2px;
      height: 32px;
    }
    #${ROOT_ID} .gl-symbol {
      font-size: 22px;
      line-height: 1;
      display: inline-block;
      animation-name: gl-dance;
      animation-duration: 1.8s;
      animation-iteration-count: infinite;
      animation-timing-function: ease-in-out;
      will-change: transform, opacity;
    }
    #${ROOT_ID} .gl-message {
      color: #e8e8ee;
      font-size: 13px;
      font-weight: 500;
      white-space: nowrap;
      letter-spacing: 0.2px;
    }
    @keyframes gl-dance {
      0%   { transform: rotate(0deg)   scale(1.0); opacity: 0.55; }
      20%  { transform: rotate(-18deg) scale(1.25); opacity: 1.0; }
      45%  { transform: rotate(14deg)  scale(0.85); opacity: 0.65; }
      70%  { transform: rotate(-6deg)  scale(1.15); opacity: 0.9; }
      100% { transform: rotate(0deg)   scale(1.0); opacity: 0.55; }
    }
  `;
  document.head.appendChild(style);
}

function ensureRoot(): HTMLDivElement {
  let el = document.getElementById(ROOT_ID) as HTMLDivElement | null;
  if (el) return el;
  el = document.createElement('div');
  el.id = ROOT_ID;
  el.innerHTML = `
    <div class="gl-symbols"></div>
    <div class="gl-message"></div>
  `;
  document.body.appendChild(el);
  return el;
}

class GlobalLoaderImpl {
  private currentState: LoaderState | null = null;
  private currentMessage = '';
  private visible = false;

  /** Foreground intent — proving/sending (high priority, short-lived). */
  private foreground: { state: LoaderState; message: string } | null = null;
  /** Background intent — waiting for opponent (low priority, long-lived). */
  private background: { state: LoaderState; message: string } | null = null;

  /** Show a high-priority state. Masks any background waiting state. */
  show(state: LoaderState, message: string): void {
    this.foreground = { state, message };
    this.render();
  }

  /** Hide the foreground intent. If a background intent is active,
   *  it takes over; otherwise the loader hides. */
  hide(): void {
    this.foreground = null;
    this.render();
  }

  /** Set a persistent background state (e.g., waiting for opponent).
   *  Only visible when no foreground state is active. Call with null
   *  state to clear. */
  setBackground(state: LoaderState | null, message = ''): void {
    this.background = state ? { state, message } : null;
    this.render();
  }

  private render(): void {
    const intent = this.foreground ?? this.background;
    if (!intent) {
      this.applyHidden();
      return;
    }
    this.applyVisible(intent.state, intent.message);
  }

  private applyVisible(state: LoaderState, message: string): void {
    ensureStyles();
    const root = ensureRoot();

    // Update symbols only when the state changes (different suit / color)
    if (state !== this.currentState) {
      const symbolsEl = root.querySelector('.gl-symbols') as HTMLDivElement;
      symbolsEl.innerHTML = '';
      const base = DURATION_BASE[state];
      const jitter = DURATION_JITTER[state];
      for (let i = 0; i < SYMBOL_COUNT; i++) {
        const span = document.createElement('span');
        span.className = 'gl-symbol';
        span.textContent = SYMBOLS[state];
        span.style.color = COLORS[state];
        // Stagger: each symbol starts at a random phase of the animation so
        // the group pulses organically instead of marching in lock-step.
        const delay = -Math.random() * base;
        span.style.animationDelay = `${delay.toFixed(2)}s`;
        const dur = base + Math.random() * jitter;
        span.style.animationDuration = `${dur.toFixed(2)}s`;
        symbolsEl.appendChild(span);
      }
      this.currentState = state;
    }

    if (message !== this.currentMessage) {
      const msgEl = root.querySelector('.gl-message') as HTMLDivElement;
      msgEl.textContent = message;
      this.currentMessage = message;
    }

    if (!this.visible) {
      // Double rAF ensures the initial styles have committed before the
      // transition class flips visibility (avoids snapping in).
      requestAnimationFrame(() => {
        requestAnimationFrame(() => root.classList.add('visible'));
      });
      this.visible = true;
    }
  }

  private applyHidden(): void {
    const root = document.getElementById(ROOT_ID);
    if (!root) return;
    root.classList.remove('visible');
    this.visible = false;
    // Keep DOM around for the next show() — cheap and avoids re-flashing styles
  }
}

export const globalLoader = new GlobalLoaderImpl();

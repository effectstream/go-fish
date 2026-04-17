/**
 * TurnIndicator — bottom-center "your turn" prompt.
 *
 * Yellow/gold club (♣) with a pulsing glow + "Select a card" text.
 * Designed to grab attention during turn_start while it's your turn.
 *
 * Usage:
 *   turnIndicator.show();
 *   turnIndicator.hide();
 *
 * Idempotent — repeated show() / hide() calls are cheap and don't retrigger
 * animations unless the state actually changes.
 */

const STYLE_ID = 'turn-indicator-style';
const ROOT_ID = 'turn-indicator-root';

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #${ROOT_ID} {
      position: fixed;
      bottom: 28px;
      left: 50%;
      transform: translateX(-50%) translateY(12px);
      z-index: 9000;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      padding: 14px 32px 12px 32px;
      background: rgba(30, 24, 8, 0.85);
      border: 2px solid #facc15;
      border-radius: 14px;
      box-shadow:
        0 4px 18px rgba(0, 0, 0, 0.5),
        0 0 24px rgba(250, 204, 21, 0.25);
      backdrop-filter: blur(4px);
      font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
      opacity: 0;
      transition: opacity 0.28s ease, transform 0.28s ease, box-shadow 0.28s ease;
      pointer-events: none;
      user-select: none;
    }
    #${ROOT_ID}.visible {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }
    #${ROOT_ID} .ti-symbol {
      font-size: 44px;
      line-height: 1;
      color: #facc15;
      text-shadow:
        0 0 12px rgba(250, 204, 21, 0.7),
        0 0 28px rgba(250, 204, 21, 0.35);
      animation: ti-beat 1.4s ease-in-out infinite;
      will-change: transform, text-shadow;
    }
    #${ROOT_ID} .ti-label {
      font-size: 14px;
      font-weight: 700;
      letter-spacing: 1.5px;
      color: #fde68a;
      text-transform: uppercase;
      animation: ti-shimmer 2.2s ease-in-out infinite;
      will-change: opacity;
    }
    @keyframes ti-beat {
      0%, 100% {
        transform: scale(1.0) rotate(0deg);
        text-shadow: 0 0 10px rgba(250, 204, 21, 0.55), 0 0 22px rgba(250, 204, 21, 0.25);
      }
      25% {
        transform: scale(1.15) rotate(-6deg);
        text-shadow: 0 0 18px rgba(250, 204, 21, 0.95), 0 0 36px rgba(250, 204, 21, 0.55);
      }
      50% {
        transform: scale(1.05) rotate(4deg);
        text-shadow: 0 0 14px rgba(250, 204, 21, 0.75), 0 0 30px rgba(250, 204, 21, 0.4);
      }
      75% {
        transform: scale(1.12) rotate(-2deg);
        text-shadow: 0 0 16px rgba(250, 204, 21, 0.85), 0 0 32px rgba(250, 204, 21, 0.5);
      }
    }
    @keyframes ti-shimmer {
      0%, 100% { opacity: 0.75; }
      50%      { opacity: 1.0; }
    }
    #${ROOT_ID}.visible {
      animation: ti-glow 2.5s ease-in-out infinite;
    }
    @keyframes ti-glow {
      0%, 100% { box-shadow: 0 4px 18px rgba(0, 0, 0, 0.5), 0 0 24px rgba(250, 204, 21, 0.25); }
      50%      { box-shadow: 0 4px 24px rgba(0, 0, 0, 0.55), 0 0 40px rgba(250, 204, 21, 0.55); }
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
    <div class="ti-symbol">♣</div>
    <div class="ti-label">Select a Card</div>
  `;
  document.body.appendChild(el);
  return el;
}

class TurnIndicatorImpl {
  private visible = false;
  private currentMessage = 'Select a Card';

  /** Show the indicator with a message. Default message when omitted. */
  show(message = 'Select a Card'): void {
    ensureStyles();
    const root = ensureRoot();
    this.setMessage(root, message);
    if (this.visible) return;
    this.visible = true;
    // Double rAF so initial styles commit before the transition class flips.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => root.classList.add('visible'));
    });
  }

  private setMessage(root: HTMLDivElement, message: string): void {
    if (message === this.currentMessage) return;
    const label = root.querySelector('.ti-label') as HTMLDivElement | null;
    if (label) label.textContent = message;
    this.currentMessage = message;
  }

  hide(): void {
    const root = document.getElementById(ROOT_ID);
    if (!root || !this.visible) return;
    this.visible = false;
    root.classList.remove('visible');
  }
}

export const turnIndicator = new TurnIndicatorImpl();

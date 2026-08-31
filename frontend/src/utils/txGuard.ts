import { globalLoader } from '../three/ui/GlobalLoader';

/**
 * Tx-in-flight UI guard.
 *
 * While a proof is generating or a tx is posting, creating or joining a
 * second on-chain operation races the first and usually either silently
 * errors or orphans one of the txs. This module exposes two tiny helpers
 * (`ensureNotBusy`, `guardedClick`) that callers use at the top of their
 * click handlers, plus a floating toast that explains the block to the
 * user.
 *
 * The "busy" signal comes from {@link GlobalLoader.isTxInFlight} — 'proving'
 * or 'sending' state. 'waiting' (opponent's turn) is passive and does NOT
 * block user interaction.
 *
 * A separate body-class toggler in `main.ts` subscribes to
 * `onTxInFlightChange` and flips `body.tx-in-flight`, which the `.tx-guarded`
 * CSS rule uses to dim guarded controls so the disabled state is visible.
 */

const TOAST_STYLE_ID = 'tx-guard-toast-style';
const TOAST_ID = 'tx-guard-toast';
const DEFAULT_MESSAGE = 'Blockchain operation in progress — please wait.';

function ensureToastStyles(): void {
  if (document.getElementById(TOAST_STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = TOAST_STYLE_ID;
  s.textContent = `
    #${TOAST_ID} {
      position: fixed;
      top: 80px;
      left: 50%;
      transform: translate(-50%, -10px);
      z-index: 10000;
      padding: 12px 22px;
      background: rgba(30, 20, 25, 0.92);
      border: 1px solid rgba(255, 170, 0, 0.55);
      color: #ffaa00;
      border-radius: 10px;
      font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
      font-size: 14px;
      font-weight: 600;
      letter-spacing: 0.2px;
      box-shadow: 0 6px 18px rgba(0,0,0,0.45);
      opacity: 0;
      transition: opacity 0.18s ease, transform 0.18s ease;
      pointer-events: none;
      backdrop-filter: blur(4px);
    }
    #${TOAST_ID}.visible {
      opacity: 1;
      transform: translate(-50%, 0);
    }
  `;
  document.head.appendChild(s);
}

let toastTimer: number | null = null;

function showToast(message: string, durationMs = 2500): void {
  ensureToastStyles();
  let el = document.getElementById(TOAST_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = TOAST_ID;
    document.body.appendChild(el);
  }
  el.textContent = message;
  requestAnimationFrame(() => el!.classList.add('visible'));
  if (toastTimer !== null) clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    el?.classList.remove('visible');
    toastTimer = null;
  }, durationMs);
}

/**
 * If a tx is in flight, show an explainer toast and return false so the
 * caller can short-circuit. Returns true when the caller may proceed.
 *
 * Call at the top of any click handler that could create / join / leave
 * a game while the loader is busy.
 */
export function ensureNotBusy(message: string = DEFAULT_MESSAGE): boolean {
  if (!globalLoader.isTxInFlight()) return true;
  showToast(message);
  return false;
}

/**
 * Wrap a click handler so it no-ops (with toast) while a tx is in flight.
 * Preserves the caller's signature for easy drop-in over existing handlers.
 */
export function guardedClick<A extends unknown[], R>(
  fn: (...args: A) => R,
  message?: string,
): (...args: A) => R | undefined {
  return (...args: A) => {
    if (!ensureNotBusy(message)) return undefined;
    return fn(...args);
  };
}

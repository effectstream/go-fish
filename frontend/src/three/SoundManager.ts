/**
 * Synthesized sound effects using Web Audio API.
 * No external audio files needed — all sounds are generated programmatically.
 *
 * Exposes:
 *   - Gameplay cues: cardFlip, cardDeal, goFish, bookComplete, cardsGained,
 *     cardsTaken, notification, yourTurn.
 *   - UI cues: uiClick, uiClickSecondary, uiHover, uiDisabled, modalOpen,
 *     modalClose, screenTransition, success, error, playerJoined, gameStart,
 *     win, lose.
 *   - Master controls: muted + volume, persisted in localStorage.
 *
 * Auto-resumes the AudioContext on first gesture (browser autoplay policy)
 * and suspends it when the tab becomes hidden to avoid background ticks.
 */

const STORAGE_MUTED = 'gofish_sound_muted';
const STORAGE_VOLUME = 'gofish_sound_volume';

type SfxName =
  | 'cardFlip'
  | 'cardDeal'
  | 'goFish'
  | 'bookComplete'
  | 'cardsGained'
  | 'cardsTaken'
  | 'notification'
  | 'yourTurn'
  | 'uiClick'
  | 'uiClickSecondary'
  | 'uiHover'
  | 'uiDisabled'
  | 'modalOpen'
  | 'modalClose'
  | 'screenTransition'
  | 'success'
  | 'error'
  | 'playerJoined'
  | 'gameStart'
  | 'win'
  | 'lose';

export class SoundManager {
  private ctx: AudioContext | null = null;
  private _muted: boolean;
  private _volume: number;
  private lastHoverAt = 0;

  constructor() {
    this._muted = localStorage.getItem(STORAGE_MUTED) === '1';
    const rawVol = parseFloat(localStorage.getItem(STORAGE_VOLUME) ?? '1');
    this._volume = Number.isFinite(rawVol) ? Math.max(0, Math.min(1, rawVol)) : 1;

    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      if (document.visibilityState === 'hidden') void this.ctx.suspend();
      else void this.ctx.resume();
    });
  }

  private getContext(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext();
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  /** Apply the master volume multiplier to a target gain level. */
  private g(level: number): number {
    return level * this._volume;
  }

  get muted(): boolean { return this._muted; }
  get volume(): number { return this._volume; }

  setMuted(muted: boolean): void {
    this._muted = muted;
    localStorage.setItem(STORAGE_MUTED, muted ? '1' : '0');
  }

  setVolume(volume: number): void {
    this._volume = Math.max(0, Math.min(1, volume));
    localStorage.setItem(STORAGE_VOLUME, String(this._volume));
  }

  /** Dispatch by name — useful for data-sfx delegation in UIManager. */
  play(name: SfxName): void {
    const fn = this[`play${name.charAt(0).toUpperCase()}${name.slice(1)}` as keyof this];
    if (typeof fn === 'function') (fn as () => void).call(this);
  }

  // ────────────────────────────────────────────────────────────────────────
  // Gameplay cues
  // ────────────────────────────────────────────────────────────────────────

  /** Short click/flip sound for card interactions. */
  playCardFlip(): void {
    if (this._muted) return;
    const ctx = this.getContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(800, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(400, ctx.currentTime + 0.08);

    gain.gain.setValueAtTime(this.g(0.15), ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.1);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.1);
  }

  /** Card dealing sound — rapid staccato tick. */
  playCardDeal(): void {
    if (this._muted) return;
    const ctx = this.getContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'square';
    osc.frequency.setValueAtTime(1200, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(600, ctx.currentTime + 0.04);

    gain.gain.setValueAtTime(this.g(0.08), ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.06);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.06);
  }

  /** "Go Fish!" splash — descending wobble. */
  playGoFish(): void {
    if (this._muted) return;
    const ctx = this.getContext();
    const now = ctx.currentTime;

    for (const detune of [0, 7]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(600 + detune, now);
      osc.frequency.exponentialRampToValueAtTime(200, now + 0.4);

      gain.gain.setValueAtTime(this.g(0.12), now);
      gain.gain.linearRampToValueAtTime(this.g(0.08), now + 0.15);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.5);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.5);
    }
  }

  /** Book completion chime — ascending arpeggio. */
  playBookComplete(): void {
    if (this._muted) return;
    const ctx = this.getContext();
    const now = ctx.currentTime;

    const notes = [523.25, 659.25, 783.99, 1046.50]; // C5, E5, G5, C6
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now);

      const noteStart = now + i * 0.1;
      gain.gain.setValueAtTime(0, noteStart);
      gain.gain.linearRampToValueAtTime(this.g(0.15), noteStart + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.001, noteStart + 0.4);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(noteStart);
      osc.stop(noteStart + 0.4);
    });
  }

  /** Generic notification/alert ping. */
  playNotification(): void {
    if (this._muted) return;
    const ctx = this.getContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    gain.gain.setValueAtTime(this.g(0.1), ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.3);
  }

  /** Warmer, more distinctive bell — used for "your turn" background alerts. */
  playYourTurn(): void {
    if (this._muted) return;
    const ctx = this.getContext();
    const now = ctx.currentTime;
    for (const freq of [660, 880]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now);
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(this.g(freq === 660 ? 0.14 : 0.08), now + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.32);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.34);
    }
  }

  /** Cards taken — low thud. */
  playCardsTaken(): void {
    if (this._muted) return;
    const ctx = this.getContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(150, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(60, ctx.currentTime + 0.2);
    gain.gain.setValueAtTime(this.g(0.2), ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.3);
  }

  /** Cards gained — rising chime. */
  playCardsGained(): void {
    if (this._muted) return;
    const ctx = this.getContext();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(400, now);
    osc.frequency.exponentialRampToValueAtTime(800, now + 0.2);
    gain.gain.setValueAtTime(this.g(0.12), now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.3);
  }

  // ────────────────────────────────────────────────────────────────────────
  // UI cues
  // ────────────────────────────────────────────────────────────────────────

  /** Primary button click — short tick. */
  playUiClick(): void {
    if (this._muted) return;
    const ctx = this.getContext();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(600, now);
    osc.frequency.exponentialRampToValueAtTime(500, now + 0.04);
    gain.gain.setValueAtTime(this.g(0.08), now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.05);
  }

  /** Secondary / icon button click — softer and lower than primary. */
  playUiClickSecondary(): void {
    if (this._muted) return;
    const ctx = this.getContext();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(300, now);
    gain.gain.setValueAtTime(this.g(0.06), now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.04);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.04);
  }

  /** Optional hover pip — throttled to 150 ms to avoid spam. */
  playUiHover(): void {
    if (this._muted) return;
    const nowMs = performance.now();
    if (nowMs - this.lastHoverAt < 150) return;
    this.lastHoverAt = nowMs;

    const ctx = this.getContext();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1000, now);
    gain.gain.setValueAtTime(this.g(0.03), now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.03);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.03);
  }

  /** Dull thunk played when the user clicks a disabled control. */
  playUiDisabled(): void {
    if (this._muted) return;
    const ctx = this.getContext();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(120, now);
    gain.gain.setValueAtTime(this.g(0.08), now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.08);
  }

  /** Modal opening — short upward sweep. */
  playModalOpen(): void {
    if (this._muted) return;
    const ctx = this.getContext();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(400, now);
    osc.frequency.exponentialRampToValueAtTime(600, now + 0.12);
    gain.gain.setValueAtTime(this.g(0.08), now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.14);
  }

  /** Modal closing — short downward sweep. */
  playModalClose(): void {
    if (this._muted) return;
    const ctx = this.getContext();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(600, now);
    osc.frequency.exponentialRampToValueAtTime(400, now + 0.1);
    gain.gain.setValueAtTime(this.g(0.07), now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.12);
  }

  /** Screen transition — soft two-sine whoosh. */
  playScreenTransition(): void {
    if (this._muted) return;
    const ctx = this.getContext();
    const now = ctx.currentTime;
    for (const base of [200, 140]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(base, now);
      osc.frequency.exponentialRampToValueAtTime(base * 0.6, now + 0.25);
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(this.g(0.05), now + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.26);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.28);
    }
  }

  /** Success cue — two-note rising chime (E5 → A5). */
  playSuccess(): void {
    if (this._muted) return;
    const ctx = this.getContext();
    const now = ctx.currentTime;
    const notes = [659.25, 880];
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now);
      const start = now + i * 0.08;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(this.g(0.12), start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.22);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.24);
    });
  }

  /** Error cue — descending minor third buzz. */
  playError(): void {
    if (this._muted) return;
    const ctx = this.getContext();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(300, now);
    osc.frequency.exponentialRampToValueAtTime(200, now + 0.22);
    gain.gain.setValueAtTime(this.g(0.1), now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.25);
  }

  /** Opponent joined the lobby — friendly two-note ping (G5 → C6). */
  playPlayerJoined(): void {
    if (this._muted) return;
    const ctx = this.getContext();
    const now = ctx.currentTime;
    const notes = [783.99, 1046.50];
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now);
      const start = now + i * 0.12;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(this.g(0.13), start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.26);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.28);
    });
  }

  /** Game starting fanfare — C major arpeggio. */
  playGameStart(): void {
    if (this._muted) return;
    const ctx = this.getContext();
    const now = ctx.currentTime;
    const notes = [523.25, 659.25, 783.99]; // C5, E5, G5
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, now);
      const start = now + i * 0.1;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(this.g(0.14), start + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.36);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.38);
    });
  }

  /** Victory arpeggio — ascending C major run. */
  playWin(): void {
    if (this._muted) return;
    const ctx = this.getContext();
    const now = ctx.currentTime;
    const notes = [523.25, 659.25, 783.99, 1046.50, 1318.51]; // C5..E6
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, now);
      const start = now + i * 0.1;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(this.g(0.15), start + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.45);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.48);
    });
  }

  /** Defeat sigh — descending three-note sequence. */
  playLose(): void {
    if (this._muted) return;
    const ctx = this.getContext();
    const now = ctx.currentTime;
    const notes = [440, 349.23, 293.66]; // A4, F4, D4
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now);
      const start = now + i * 0.15;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(this.g(0.12), start + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.4);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.42);
    });
  }

  dispose(): void {
    this.ctx?.close();
    this.ctx = null;
  }
}

/** Singleton sound manager instance. */
export const soundManager = new SoundManager();

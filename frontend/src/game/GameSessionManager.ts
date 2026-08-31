import { GameSession } from './GameSession';
import type { EndedDetail } from './types';
import { clearCachedGame } from '../services/HandCache';

/**
 * Events dispatched by {@link GameSessionManager}.
 * - `sessionAdded`      — a new session was created and stored
 * - `sessionRemoved`    — a session was destroyed (via `destroy()`)
 * - `anyChange`         — any registered session emitted a `stateChange`
 *                         (bubbled so sidebar UI can re-render cheaply)
 * - `foregroundChanged` — which session is currently attached to the
 *                         3D canvas changed (or went to null = not in game)
 */
export interface SessionManagerEventMap {
  sessionAdded: { lobbyId: string; session: GameSession };
  sessionRemoved: { lobbyId: string };
  anyChange: { lobbyId: string };
  foregroundChanged: { lobbyId: string | null };
}

/**
 * Maximum number of sessions allowed in the registry at once. Hit the cap →
 * getOrCreate throws. Keep it small: each session has an open poller, a WS
 * subscription, and potentially a proof in flight.
 */
const MAX_SESSIONS = 5;

/**
 * How long to keep a session alive after its `ended` event fires, so the
 * user has time to see the results screen before we tear down. After this
 * grace period the session is force-destroyed even if foregrounded.
 */
const ENDED_CLEANUP_DELAY_MS = 60_000;

/**
 * How long `destroy()` is willing to wait for an in-flight proof/tx to
 * drain before giving up (and the caller must decide whether to force).
 */
const DRAIN_TIMEOUT_MS = 30_000;

/**
 * Registry of live {@link GameSession} instances. Sessions outlive the view —
 * detaching `GameScene` does NOT destroy them. Use `destroy(lobbyId)` to
 * explicitly tear one down.
 *
 * Singleton: always access via `GameSessionManager.instance`.
 */
export class GameSessionManager extends EventTarget {
  private static _instance: GameSessionManager | null = null;

  static get instance(): GameSessionManager {
    if (!this._instance) this._instance = new GameSessionManager();
    return this._instance;
  }

  private sessions = new Map<string, GameSession>();
  /** Per-session teardown for the bubbled `anyChange` forwarders. */
  private bubbleUnsubs = new Map<string, () => void>();
  /** Per-session teardown for the `ended`-triggered auto-cleanup timer. */
  private endedUnsubs = new Map<string, () => void>();
  /** Pending `setTimeout` handles for ended-sessions' grace-period
   *  destruction — tracked so we can cancel if the session is explicitly
   *  destroyed first. */
  private endedTimers = new Map<string, number>();
  /** Lobby id currently attached to the 3D canvas; null when the user is
   *  on any non-game screen. Set by SceneManager via `setForeground()`. */
  private _foregroundLobbyId: string | null = null;

  private constructor() {
    super();
  }

  /** The lobby id currently foregrounded on the 3D canvas, or null. Read
   *  by BackgroundNotifier and other consumers that need to know whether
   *  to surface a given session's events to the user directly or via
   *  a sidebar/toast. */
  get foregroundLobbyId(): string | null {
    return this._foregroundLobbyId;
  }

  setForeground(lobbyId: string | null): void {
    if (this._foregroundLobbyId === lobbyId) return;
    this._foregroundLobbyId = lobbyId;
    this.emit('foregroundChanged', { lobbyId });
  }

  /**
   * Return the existing session for `lobbyId`, creating (and starting) one if
   * missing. Subsequent calls with the same lobbyId return the same instance.
   *
   * `session.start()` is idempotent, so callers may always follow this with
   * `session.start()` — the manager also calls it internally on creation.
   */
  getOrCreate(lobbyId: string, walletAddress: string): GameSession {
    const existing = this.sessions.get(lobbyId);
    if (existing) return existing;

    if (this.sessions.size >= MAX_SESSIONS) {
      throw new Error(
        `[GameSessionManager] cannot create session: at ${MAX_SESSIONS} concurrent sessions. ` +
        `Leave a game before joining another.`,
      );
    }

    const session = new GameSession(lobbyId, walletAddress);
    this.sessions.set(lobbyId, session);

    // Bubble stateChange events up as anyChange so the sidebar (and any
    // future dashboard) can re-render without subscribing to every session.
    const listener = () => this.emit('anyChange', { lobbyId });
    session.addEventListener('stateChange', listener);
    this.bubbleUnsubs.set(lobbyId, () => session.removeEventListener('stateChange', listener));

    // Auto-cleanup: when the game ends, schedule the session for
    // destruction after a grace period so the user can view results, then
    // drop it so long-running tabs don't leak finished games.
    const endedListener = (ev: Event) => {
      const detail = (ev as CustomEvent).detail as EndedDetail;
      this.scheduleEndedCleanup(lobbyId, detail);
    };
    session.addEventListener('ended', endedListener);
    this.endedUnsubs.set(lobbyId, () => session.removeEventListener('ended', endedListener));

    session.start();
    this.emit('sessionAdded', { lobbyId, session });
    return session;
  }

  get(lobbyId: string): GameSession | undefined {
    return this.sessions.get(lobbyId);
  }

  list(): GameSession[] {
    return [...this.sessions.values()];
  }

  /**
   * Stop and remove the session. Waits for any in-flight proof/tx to drain
   * first so we don't kill a session mid-action and lose the user's work.
   *
   * If the drain doesn't complete within {@link DRAIN_TIMEOUT_MS}, resolves
   * `false` without tearing down — caller can decide to force via
   * {@link forceDestroy}. If the session is idle (or unknown), resolves
   * `true` after teardown.
   */
  async destroy(lobbyId: string): Promise<boolean> {
    const session = this.sessions.get(lobbyId);
    if (!session) return true;

    const snapshot = session.getSnapshot();
    if (snapshot.inFlight !== null) {
      const drained = await this.waitForDrain(session, DRAIN_TIMEOUT_MS);
      if (!drained) {
        console.warn(
          `[GameSessionManager] destroy(${lobbyId}) refused — proof still in flight after ${DRAIN_TIMEOUT_MS}ms. Use forceDestroy() to override.`,
        );
        return false;
      }
    }
    this.forceDestroy(lobbyId);
    return true;
  }

  /**
   * Tear down a session unconditionally, even if a proof is mid-flight.
   * Only use when the user has explicitly dismissed the in-progress work
   * (e.g., confirming "Leave anyway?"). Idempotent on unknown ids.
   */
  forceDestroy(lobbyId: string): void {
    const session = this.sessions.get(lobbyId);
    if (!session) return;
    this.bubbleUnsubs.get(lobbyId)?.();
    this.bubbleUnsubs.delete(lobbyId);
    this.endedUnsubs.get(lobbyId)?.();
    this.endedUnsubs.delete(lobbyId);
    const pendingTimer = this.endedTimers.get(lobbyId);
    if (pendingTimer !== undefined) {
      clearTimeout(pendingTimer);
      this.endedTimers.delete(lobbyId);
    }
    try {
      session.stop();
    } catch (err) {
      console.warn(`[GameSessionManager] forceDestroy(${lobbyId}) stop() threw:`, err);
    }
    // Drop the sidebar's cache so finished games don't linger with stale
    // previews.
    clearCachedGame(lobbyId);
    this.sessions.delete(lobbyId);
    if (this._foregroundLobbyId === lobbyId) {
      this._foregroundLobbyId = null;
    }
    this.emit('sessionRemoved', { lobbyId });
  }

  /**
   * Resolve when the session's inFlight returns to null, or timeout.
   * Resolves `true` on drain, `false` on timeout. No-op if already idle.
   */
  private waitForDrain(session: GameSession, timeoutMs: number): Promise<boolean> {
    if (session.getSnapshot().inFlight === null) return Promise.resolve(true);
    return new Promise<boolean>(resolve => {
      let done = false;
      const timer = window.setTimeout(() => {
        if (done) return;
        done = true;
        session.removeEventListener('inFlightChange', listener);
        resolve(false);
      }, timeoutMs);
      const listener = (ev: Event) => {
        const detail = (ev as CustomEvent).detail as { to: unknown };
        if (detail.to === null && !done) {
          done = true;
          clearTimeout(timer);
          session.removeEventListener('inFlightChange', listener);
          resolve(true);
        }
      };
      session.addEventListener('inFlightChange', listener);
    });
  }

  /** Schedule a session for cleanup after its game ends. Cancelled if the
   *  user explicitly destroys it first or the session is somehow restarted
   *  (which shouldn't happen post-ended but be defensive). */
  private scheduleEndedCleanup(lobbyId: string, _detail: EndedDetail): void {
    if (this.endedTimers.has(lobbyId)) return; // already scheduled
    const handle = window.setTimeout(() => {
      this.endedTimers.delete(lobbyId);
      // After the grace window, the user has had time to see results.
      // Force-destroy so lingering polls stop even if the user never
      // navigated away.
      this.forceDestroy(lobbyId);
    }, ENDED_CLEANUP_DELAY_MS);
    this.endedTimers.set(lobbyId, handle);
  }

  /** Dev inspector — returns a plain object summary of all sessions.
   *  Also logs to console in a table. Call from the devtools: any of
   *  `GameSessionManager.instance.debugDump()` or `window.__sessions` work. */
  debugDump(): Array<Record<string, unknown>> {
    const rows = this.list().map(s => {
      const snap = s.getSnapshot();
      const st = snap.state;
      return {
        lobbyId: s.lobbyId,
        playerId: snap.playerId,
        setupPhase: snap.setupPhase,
        phase: st?.phase ?? '—',
        isMyTurn: st ? st.currentTurn === st.playerId : false,
        scores: st ? st.scores.join(' / ') : '—',
        inFlight: snap.inFlight ?? '—',
        askInProgress: snap.askInProgress,
        respondInProgress: snap.respondInProgress,
        drawInProgress: snap.drawInProgress,
        foreground: this._foregroundLobbyId === s.lobbyId,
      };
    });
    // eslint-disable-next-line no-console
    console.table(rows);
    return rows;
  }

  private emit<K extends keyof SessionManagerEventMap>(
    name: K,
    detail: SessionManagerEventMap[K],
  ): void {
    this.dispatchEvent(new CustomEvent(name, { detail }));
  }
}

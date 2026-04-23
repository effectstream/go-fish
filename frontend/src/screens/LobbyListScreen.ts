/**
 * Lobby List Screen - Shows available lobbies and create lobby option
 */

import { GoFishGameService } from '../services/GoFishGameService';
import type { Lobby } from '../../../packages/shared/data-types/src/go-fish-types';
import { getWalletAddress, switchAccount, getLobbyState } from '../effectstreamBridge';
import { GameSessionManager } from '../game/GameSessionManager';
import type { GameSession } from '../game/GameSession';
import type { InFlightState } from '../game/types';
import { getCachedGame, listCachedGames, clearCachedGame } from '../services/HandCache';
import { soundManager } from '../three/SoundManager';
import { ensureNotBusy } from '../utils/txGuard';

export class LobbyListScreen {
  private container: HTMLElement;
  private gameService: GoFishGameService;
  private refreshInterval?: number;
  private pendingJoinLobbyId: string | null = null; // Track which lobby we're joining
  /** Debounce guard for re-renders driven by session events. */
  private renderScheduled = false;
  /** Teardown for the always-on foreground subscription. Same pattern as
   *  the session-manager subs: run in the constructor so updates delivered
   *  while the user is on the game screen can still mutate the stale
   *  sidebar DOM when the LobbyListScreen's HTML is still mounted. */
  private foregroundUnsub: (() => void) | null = null;
  /** Teardown for always-on session-manager subscriptions (anyChange,
   *  sessionAdded, sessionRemoved). Lives for the lifetime of the instance
   *  so score/turn updates propagate to the menu regardless of which
   *  screen is currently active. Re-renders are gated by a DOM-ownership
   *  check so we don't clobber a different screen's side-panel content. */
  private managerUnsub: (() => void) | null = null;
  /** Teardown for the window 'storage' event — triggers a re-render when
   *  another tab writes to HandCache. */
  private storageUnsub: (() => void) | null = null;
  /** True after the first show() completes. Used to gate the background
   *  backfill so it only runs once per tab session (plus on manual
   *  refresh). */
  private backfilled = false;

  constructor(container: HTMLElement) {
    this.container = container;
    this.gameService = GoFishGameService.getInstance();
    this.foregroundUnsub = this.subscribeToForegroundChanges();
    this.managerUnsub = this.subscribeToSessionManager();
    this.storageUnsub = this.subscribeToStorageEvents();
  }

  /** Listen for foreground session changes even when the screen is "hidden".
   *  LobbyListScreen's DOM stays in the side panel while the user is on the
   *  game screen, so a live DOM tweak (not a full re-render) is the safest
   *  way to toggle the Resume button without clobbering whatever other
   *  screen may currently own the side panel. */
  private subscribeToForegroundChanges(): () => void {
    const manager = GameSessionManager.instance;
    const onForegroundChange = () => this.applyForegroundToResumeButtons();
    manager.addEventListener('foregroundChanged', onForegroundChange);
    return () => manager.removeEventListener('foregroundChanged', onForegroundChange);
  }

  /** Hide/show each `.resume-btn` based on whether its lobby is the current
   *  foreground. Uses `display: none` so layout collapses cleanly. Also
   *  toggles `.active` on the parent `.resume-card` so the golden border
   *  highlight tracks the foreground session without a full re-render. */
  private applyForegroundToResumeButtons(): void {
    const fg = GameSessionManager.instance.foregroundLobbyId;

    // Active Games section
    const buttons = document.querySelectorAll<HTMLElement>('.resume-btn');
    buttons.forEach(btn => {
      const lobbyId = btn.dataset.lobbyId;
      const isOutcome = btn.classList.contains('btn-success') || btn.classList.contains('btn-danger');
      btn.style.display = !isOutcome && lobbyId && lobbyId === fg ? 'none' : '';
    });
    const cards = document.querySelectorAll<HTMLElement>('.resume-card');
    cards.forEach(card => {
      const lobbyId = card.dataset.lobbyId;
      card.classList.toggle('active', !!lobbyId && lobbyId === fg);
    });

    // Available Lobbies section
    document.querySelectorAll<HTMLElement>('.join-btn').forEach(btn => {
      const lobbyId = btn.dataset.lobbyId;
      btn.style.display = lobbyId && lobbyId === fg ? 'none' : '';
    });
    document.querySelectorAll<HTMLElement>('.lobby-card:not(.resume-card)').forEach(card => {
      const lobbyId = card.dataset.lobbyId;
      card.classList.toggle('active', !!lobbyId && lobbyId === fg);
    });
  }

  async show() {
    // Clear out whatever the previous screen rendered into the side panel
    // so the first render's DOM-ownership guard lets us through. Without
    // this, render() sees a non-empty container whose first child isn't
    // `.lobby-list-screen` (it's whatever name-entry / lobby / results
    // left behind) and skips, leaving the sidebar stuck on the previous
    // screen's content.
    this.container.innerHTML = '';
    await this.render();
    // 30s heartbeat — safety net in case an event is missed. The primary
    // drivers are the constructor-scope subscriptions (manager events +
    // storage). 4s polling used to paper over the old chain-query render;
    // cache-primary reads make that pressure unnecessary.
    this.refreshInterval = window.setInterval(() => this.render(), 30_000);
    // Kick off a background backfill on first show: populates the cache
    // from findResumableGames for games this device has no live session
    // for (e.g., played on another tab/browser). Writes go through
    // setCachedGame → storage event → next render picks them up.
    if (!this.backfilled) {
      this.backfilled = true;
      void this.backfillInBackground();
    }
  }

  hide() {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
    }
    // Subscriptions stay live — see constructor comment.
  }

  /** Listen for session lifecycle + state changes; re-render (debounced) so
   *  per-card badges stay live. Returns a teardown closure. */
  private subscribeToSessionManager(): () => void {
    const manager = GameSessionManager.instance;
    const schedule = () => {
      if (this.renderScheduled) return;
      this.renderScheduled = true;
      setTimeout(() => {
        this.renderScheduled = false;
        this.render();
      }, 300);
    };
    const onAny = () => schedule();
    manager.addEventListener('anyChange', onAny);
    manager.addEventListener('sessionAdded', onAny);
    manager.addEventListener('sessionRemoved', onAny);
    return () => {
      manager.removeEventListener('anyChange', onAny);
      manager.removeEventListener('sessionAdded', onAny);
      manager.removeEventListener('sessionRemoved', onAny);
    };
  }

  /** Listen for HandCache writes made by OTHER tabs. The 'storage' event
   *  fires on every window except the one that wrote, so this is the
   *  cheapest cross-tab propagation. */
  private subscribeToStorageEvents(): () => void {
    const onStorage = (e: StorageEvent) => {
      if (!e.key || !e.key.startsWith('gofish_game_v2_')) return;
      // Debounce via the same schedule() path as session events.
      if (this.renderScheduled) return;
      this.renderScheduled = true;
      setTimeout(() => {
        this.renderScheduled = false;
        this.render();
      }, 300);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }

  /** Kick off findResumableGames and write its output into the cache.
   *  Non-blocking — the initial render already painted whatever was in the
   *  cache; when the backfill completes, the next render pass picks up the
   *  refreshed data. */
  private async backfillInBackground(): Promise<void> {
    try {
      await this.gameService.refreshResumableCache();
      void this.render();
    } catch (err) {
      console.warn('[LobbyListScreen] backfill failed:', err);
    }
  }

  private async render() {
    // Don't re-render if we're in the middle of joining a lobby
    if (this.pendingJoinLobbyId) {
      return;
    }

    // Guard: if another screen now owns the side panel, skip. Subscriptions
    // stay alive for the lifetime of this instance, so events could fire
    // while a different screen is rendered. Without this check, a menu
    // re-render triggered by a background session update would clobber the
    // currently-visible screen (LobbyScreen, ResultsScreen, …).
    const ownsPanel =
      this.container.firstElementChild === null ||
      this.container.querySelector('.lobby-list-screen') !== null;
    if (!ownsPanel) return;

    // Open lobbies are always fetched live (cheap REST call, not a chain
    // query). They drive the "Available Lobbies" section and the
    // preparing-badge logic.
    const lobbies = await this.gameService.fetchOpenLobbies();

    // Lobbies still in 'open' (waiting) status belong in "Available Lobbies"
    // — NOT Active Games. Drop any stale HandCache entry so we don't
    // double-render. Keep cache for in_progress lobbies — they need it for
    // the mini-hand preview.
    const openLobbyIds = new Set(lobbies.map(l => l.id));
    for (const l of lobbies) {
      if (l.status === 'waiting') clearCachedGame(l.id);
    }

    // Active Games section is now cache-primary:
    //   - HandCache provides the base snapshot (scores, phase, turn, hand,
    //     inFlight, names).
    //   - Live GameSessions overlay in-memory state on top (handles the
    //     window between a state update landing and the cache being
    //     written by the session's adapter).
    // Chain queries (findResumableGames) run ONLY via backfillInBackground
    // — not on the render path — so the sidebar renders instantly.
    const liveSessions = GameSessionManager.instance.list();
    const sessionsByLobby = new Map<string, GameSession>(
      liveSessions.map(s => [s.lobbyId, s]),
    );
    const enrichedGames = this.buildActiveGamesFromCacheAndSessions(
      sessionsByLobby,
      openLobbyIds,
    );

    // Check if modal is open - if so, don't re-render
    const existingModal = document.getElementById('create-lobby-modal') as HTMLElement;
    const isModalOpen = existingModal && existingModal.style.display !== 'none';
    if (isModalOpen) {
      // Just update the lobby list without full re-render
      const lobbyListEl = document.querySelector('.lobby-list');
      if (lobbyListEl) {
        const modalVisible = lobbies.filter(l => l.playerCount < 2 || l.isPlayerInLobby);
        lobbyListEl.innerHTML = modalVisible.length === 0
          ? '<div class="empty-state">No lobbies available. Create one!</div>'
          : modalVisible.map(lobby => this.renderLobby(lobby)).join('');

        this.attachJoinButtonListeners();
      }
      return;
    }

    const playerName = this.gameService.getPlayerName() || 'Player';

    // Compute a default lobby name that doesn't collide with existing lobby
    // names (open lobbies + my active games). Starts with "{name}'s game"
    // and appends " #2", " #3", … until unique. Pure UI — avoids showing
    // duplicates in the sidebar list; the contract doesn't care.
    const existingNames = new Set<string>([
      ...lobbies.map(l => l.name),
      ...enrichedGames.map(g => g.lobbyName),
    ]);
    const defaultLobbyName = this.nextAvailableLobbyName(`${playerName}'s game`, existingNames);

    const visibleLobbies = lobbies.filter(l => l.playerCount < 2 || l.isPlayerInLobby);

    this.container.innerHTML = `
      <div class="lobby-list-screen">
        <header class="side-header">
          <div class="top-actions">
            <button id="leaderboard-btn" class="icon-btn" title="Leaderboard" aria-label="Leaderboard">🏆</button>
            <button id="refresh-btn" class="icon-btn" title="Refresh" aria-label="Refresh">↻</button>
            <button id="help-btn" class="icon-btn" title="How to play" aria-label="Help">?</button>
            <button id="about-btn" class="icon-btn" title="About / Report" aria-label="About">ⓘ</button>
          </div>
          <h1 class="title">Go Fish</h1>
          <div class="welcome">Welcome<span class="name">${playerName}</span></div>
        </header>

        <div class="side-content">
          ${enrichedGames.length > 0 ? `
            <h2>My Active Games (${enrichedGames.length})</h2>
            <div class="resume-list">
              ${enrichedGames.map(g => this.renderResumableGame(g)).join('')}
            </div>
          ` : ''}

          <h2>Available Lobbies (${visibleLobbies.length})</h2>
          <div class="lobby-list">
            ${visibleLobbies.length === 0
              ? '<div class="empty-state">No lobbies available yet.</div>'
              : visibleLobbies.map(lobby => this.renderLobby(lobby)).join('')
            }
          </div>
        </div>

        <footer class="side-footer">
          <button id="create-lobby-btn" class="btn btn-primary tx-guarded">Create New Lobby</button>
        </footer>

        <!-- About Modal -->
        <div id="about-modal" class="info-modal-overlay" style="display: none;">
          <div class="info-modal">
            <button class="modal-close-btn" id="about-close-btn">&times;</button>
            <h2 class="info-modal-title">Go Fish</h2>
            <p class="info-modal-desc">
              A privacy-preserving card game built on the
              <strong>Midnight</strong> blockchain. Cards are shuffled and dealt
              using zero-knowledge proofs — no one can peek at your hand, not
              even the server.
            </p>
            <a href="https://github.com/effectstream/mnf-game-issues/issues"
               target="_blank" rel="noopener noreferrer"
               class="btn btn-primary info-modal-link">Report Issues</a>
            <a href="https://github.com/effectstream/go-fish"
               target="_blank" rel="noopener noreferrer"
               class="btn btn-secondary info-modal-link">Source Code</a>
          </div>
        </div>

        <!-- Create Lobby Modal (with overlay) -->
        <div id="create-lobby-modal" class="create-lobby-modal-overlay" style="display: none;">
          <div class="create-lobby-modal">
            <div class="modal-header">
              <h2>Create New Lobby</h2>
              <button class="modal-close-btn" id="modal-close-btn" data-sfx="modalClose">&times;</button>
            </div>
            <div class="form-group">
              <label>Lobby Name:</label>
              <input type="text" id="lobby-name" placeholder="Enter lobby name" maxlength="30" value="${defaultLobbyName}"/>
            </div>
            <div class="form-group">
              <span class="form-hint">Go Fish is a 2-player game. Your game will start automatically when someone joins.</span>
            </div>
            <div class="modal-actions">
              <button id="confirm-create-btn" class="btn btn-primary tx-guarded">Create</button>
              <button id="cancel-create-btn" class="btn btn-secondary" data-sfx="modalClose">Cancel</button>
            </div>
          </div>
        </div>
      </div>
    `;

    this.attachEventListeners();
  }

  private renderResumableGame(game: EnrichedResumable): string {
    // Hide the Resume button when this game is already the foregrounded
    // session on the 3D canvas — clicking Resume there would be a no-op
    // (you're already "in" the game). The card itself still renders so the
    // player can see live scores / turn / hand from the sidebar.
    const isForeground =
      GameSessionManager.instance.foregroundLobbyId === game.lobbyId;
    // Phase → user-facing status. 0=dealing, 1=turn_start, 2=wait_response,
    // 3=wait_transfer, 4=wait_draw, 5=wait_draw_check, 6=game_over
    const inSetup = game.phase === 0;
    const finished = game.phase === 6;

    // Live session inFlight takes precedence over the phase-based pill —
    // even in a "your turn" state, a proving/sending spinner is more
    // informative while the player has a tx queued.
    const inFlightPill = this.inFlightBadge(game.inFlight);

    // Turn states use the in-row dealer chip; only setup/finished show a
    // phase-based pill (when no inFlight override wins).
    const showStatusPill = !inFlightPill && (inSetup || finished);
    const statusText = inSetup ? 'Setup' : 'Finished';
    const statusClass = inSetup ? 'in_progress' : 'finished';

    // Turn chip — small gold disc marking whose turn it is. Uses a play
    // arrow (▶) rather than the poker "D" dealer-button convention.
    const chip = `<span class="dealer-chip" title="Current turn">▶</span>`;
    const meActive = !inSetup && !finished && game.isMyTurn;
    const themActive = !inSetup && !finished && !game.isMyTurn;

    // Mini-hand preview: prefer the real hand from the HandCache (written
    // by each live GameSession after every poll) — falls back to a seeded
    // mock only when no cache exists yet (e.g., a resumable game from a
    // prior tab that hasn't been foregrounded in this session).
    //
    // Real hands can range from 0 (all booked or drained) up to ~7+ mid-
    // game. We render up to MINI_HAND_FAN_CAP as a fanned preview, with a
    // `+N` chip when the full hand exceeds the cap.
    const miniHand = this.miniHandFor(game.lobbyId);
    const MINI_HAND_FAN_CAP = 5;
    const visibleCards = miniHand.cards.slice(0, MINI_HAND_FAN_CAP);
    const hiddenCount = Math.max(0, miniHand.total - visibleCards.length);
    // Only render the mini-hand strip when we have authoritative data. If the
    // real hand is unknown (no cache yet) we render NOTHING rather than
    // fabricating placeholder cards — the strip must always match the true
    // game state.
    const hasMiniHand = visibleCards.length > 0 || hiddenCount > 0;

    return `
      <div class="lobby-card resume-card ${isForeground ? 'active' : ''}" data-lobby-id="${game.lobbyId}">
        <button class="resume-dismiss-btn tx-guarded" data-lobby-id="${game.lobbyId}" title="Remove from Active Games" aria-label="Dismiss">&times;</button>
        <div class="lobby-header">
          <h3>${game.lobbyName}</h3>
          ${inFlightPill ?? (showStatusPill ? `<span class="lobby-status ${statusClass}">${statusText}</span>` : '')}
        </div>
        ${hasMiniHand ? `
          <div class="mini-hand">
            ${visibleCards.map(c => `
              <div class="mini-card ${c.red ? 'red' : ''}">
                <span class="mc-rank">${c.rank}</span>
                <span class="mc-suit">${c.suit}</span>
              </div>
            `).join('')}
            ${hiddenCount > 0 ? `<div class="mini-card-more">+${hiddenCount}</div>` : ''}
          </div>
        ` : ''}
        <div class="score-row">
          <div class="score-side me ${meActive ? 'active' : ''}">
            <span class="name">${meActive ? chip : ''} You</span>
            <span class="books">${game.myScore}</span>
          </div>
          <span class="divider">♣</span>
          <div class="score-side them ${themActive ? 'active' : ''}">
            <span class="name">${game.opponentName} ${themActive ? chip : ''}</span>
            <span class="books">${game.opponentScore}</span>
          </div>
        </div>
        ${finished ? `
          <button class="btn ${game.winner === game.playerId ? 'btn-success' : 'btn-danger'} resume-btn" data-lobby-id="${game.lobbyId}">
            ${game.winner === game.playerId ? 'You Win!' : game.winner === 0 ? 'Draw' : 'You Lost'}
          </button>
        ` : (isForeground ? '' : `
          <button class="btn btn-primary resume-btn tx-guarded" data-lobby-id="${game.lobbyId}">
            ${meActive ? 'Play Turn' : 'Resume'}
          </button>
        `)}
      </div>
    `;
  }

  /**
   * Build the Active Games list from HandCache + live sessions, with no
   * chain queries on the render path. Live session state overlays the
   * cached snapshot (the cache may lag the session by a poll cycle), and
   * sessions whose state is still null are skipped — those are mid-mask
   * prep and already rendered under "Available Lobbies".
   */
  private buildActiveGamesFromCacheAndSessions(
    sessions: Map<string, GameSession>,
    openLobbyIds: Set<string>,
  ): EnrichedResumable[] {
    const out: EnrichedResumable[] = [];
    const seen = new Set<string>();

    // Union of all lobby ids we know about (cache + live sessions).
    const ids = new Set<string>(listCachedGames().keys());
    for (const id of sessions.keys()) ids.add(id);

    for (const lobbyId of ids) {
      if (openLobbyIds.has(lobbyId)) continue; // → rendered in "Available Lobbies"
      if (seen.has(lobbyId)) continue;
      seen.add(lobbyId);

      const cached = getCachedGame(lobbyId);
      const session = sessions.get(lobbyId);
      const snap = session?.getSnapshot();
      const state = snap?.state;

      // Prefer session state for "live" fields — BUT only when the
      // wallet has resolved to a real player id. state.playerId === 0 is
      // the "wallet not yet in players list" sentinel (common for a
      // freshly-joined game before the state machine indexes the
      // joinedLobby tx). Using state.scores[-1] in that window would
      // yield undefined and render a broken card.
      if (state && snap && (state.playerId === 1 || state.playerId === 2)) {
        const myIdx = state.playerId - 1;
        const oppIdx = state.playerId === 1 ? 1 : 0;
        out.push({
          lobbyId,
          playerId: (snap.playerId || cached?.playerId || 1) as 1 | 2,
          lobbyName: session?.name || cached?.lobbyName || lobbyId.slice(0, 12),
          opponentName: state.opponentName || cached?.opponentName || 'Opponent',
          myScore: state.scores[myIdx],
          opponentScore: state.scores[oppIdx],
          isMyTurn: state.currentTurn === state.playerId,
          phase: PHASE_STRING_TO_NUMBER[state.phase] ?? cached?.phase ?? 0,
          inFlight: snap.inFlight,
          winner: state.winner ?? cached?.winner ?? 0,
        });
        continue;
      }

      // Session with no state yet (e.g., just-joined — state poll hasn't
      // completed, no cache entry). Render a minimal placeholder using
      // the session's resolved display name so the user sees their
      // newly-picked game appear on the menu right away. Fields default
      // to "preparing" semantics.
      if (session) {
        out.push({
          lobbyId,
          playerId: (snap?.playerId || 1) as 1 | 2,
          lobbyName: session.name || cached?.lobbyName || lobbyId.slice(0, 12),
          opponentName: cached?.opponentName || 'Opponent',
          myScore: cached?.myScore ?? 0,
          opponentScore: cached?.opponentScore ?? 0,
          isMyTurn: cached?.isMyTurn ?? false,
          phase: cached?.phase ?? 0,
          inFlight: snap?.inFlight ?? null,
          winner: cached?.winner ?? 0,
        });
        continue;
      }

      // No session state — render from cache alone.
      if (cached) {
        out.push({
          lobbyId,
          playerId: cached.playerId,
          lobbyName: cached.lobbyName || lobbyId.slice(0, 12),
          opponentName: cached.opponentName,
          myScore: cached.myScore,
          opponentScore: cached.opponentScore,
          isMyTurn: cached.isMyTurn,
          phase: cached.phase,
          inFlight: cached.inFlight,
          winner: cached.winner ?? 0,
        });
      }
    }

    return out;
  }

  /** Render the live-status badge (PROVING / SENDING / WAITING) if the
   *  session has a tx or proof in flight. Returns null when idle so the
   *  caller can fall back to the phase-based pill. */
  private inFlightBadge(inFlight: InFlightState): string | null {
    if (!inFlight) return null;
    const label =
      inFlight === 'proving' ? '♥ PROVING…' :
      inFlight === 'sending' ? '♦ SENDING…' :
      '♠ WAITING';
    return `<span class="lobby-status in_progress">${label}</span>`;
  }

  /** Find the first name in the sequence "base", "base #2", "base #3", … that
   *  isn't already taken by an existing lobby. Comparison is case-insensitive
   *  and trim-insensitive so we don't accept near-duplicates. */
  private nextAvailableLobbyName(base: string, taken: Set<string>): string {
    const norm = (s: string) => s.trim().toLowerCase();
    const takenLower = new Set<string>();
    for (const n of taken) takenLower.add(norm(n));

    if (!takenLower.has(norm(base))) return base;
    for (let i = 2; i < 100; i++) {
      const candidate = `${base} #${i}`;
      if (!takenLower.has(norm(candidate))) return candidate;
    }
    // Fallback — extremely unlikely to hit, but keep it stable.
    return `${base} #${Date.now().toString().slice(-4)}`;
  }

  /** Result of {@link miniHandFor} — the rendered mini-cards plus the
   *  total count, so the sidebar can show `5 cards` next to a fan of just
   *  the first few. When the real hand is unknown (no cache entry yet),
   *  returns an empty array — callers must render NO placeholders in that
   *  case, because faking cards misleads users about the true game state. */
  private miniHandFor(lobbyId: string): {
    cards: Array<{ rank: string; suit: string; red: boolean }>;
    total: number;
    /** True when the data is from the real-time cache. False means we have
     *  no authoritative data yet — cards will be empty and the caller must
     *  NOT invent placeholders. */
    live: boolean;
  } {
    const cached = getCachedGame(lobbyId);
    if (cached && cached.cards.length > 0) {
      const cards = cached.cards.map(c => {
        // Contract stores suits as names — map back to display glyphs.
        const suitGlyph =
          c.suit === 'hearts'   ? '♥' :
          c.suit === 'diamonds' ? '♦' :
          c.suit === 'clubs'    ? '♣' :
          /* spades */            '♠';
        const red = c.suit === 'hearts' || c.suit === 'diamonds';
        return { rank: c.rank, suit: suitGlyph, red };
      });
      return { cards, total: cached.cards.length, live: true };
    }
    return { cards: [], total: 0, live: false };
  }

  private renderLobby(lobby: Lobby): string {
    const isFull = lobby.playerCount >= 2;
    const isPreparing = lobby.hostMaskApplied === false;
    const isMember = lobby.isPlayerInLobby === true;
    const isForeground =
      GameSessionManager.instance.foregroundLobbyId === lobby.id;

    // Check cache/session for game outcome
    const cached = isMember ? getCachedGame(lobby.id) : null;
    const session = isMember ? GameSessionManager.instance.get(lobby.id) : undefined;
    const snap = session?.getSnapshot();
    const winner = snap?.state?.winner ?? cached?.winner ?? 0;
    const playerId = snap?.playerId ?? cached?.playerId ?? 0;
    const phase = snap?.state ? (PHASE_STRING_TO_NUMBER[snap.state.phase] ?? 0) : (cached?.phase ?? 0);
    const finished = phase === 6;

    const statusLabel = finished ? 'finished' : isPreparing ? 'preparing' : lobby.status;
    const statusClass = finished ? 'finished' : isPreparing ? 'preparing' : lobby.status;

    let buttonLabel: string;
    let buttonDisabled: boolean;
    let buttonAction: string;
    let buttonClass = 'btn-primary';

    if (isMember && finished) {
      buttonLabel = winner === playerId ? 'You Win!' : winner === 0 ? 'Draw' : 'You Lost';
      buttonClass = winner === playerId ? 'btn-success' : 'btn-danger';
      buttonDisabled = false;
      buttonAction = 'rejoin-game';
    } else if (isMember) {
      buttonLabel = 'Rejoin';
      buttonDisabled = false;
      buttonAction = isFull ? 'rejoin-game' : 'rejoin-lobby';
    } else if (isPreparing) {
      buttonLabel = 'Preparing…';
      buttonDisabled = true;
      buttonAction = 'join';
    } else {
      buttonLabel = 'Join Game';
      buttonDisabled = false;
      buttonAction = 'join';
    }

    const miniHand = isMember ? this.miniHandFor(lobby.id) : null;
    const MINI_HAND_FAN_CAP = 5;
    const visibleCards = miniHand?.cards.slice(0, MINI_HAND_FAN_CAP) ?? [];
    const hiddenCount = Math.max(0, (miniHand?.total ?? 0) - visibleCards.length);
    const hasMiniHand = visibleCards.length > 0 || hiddenCount > 0;

    return `
      <div class="lobby-card ${isForeground ? 'active' : ''}" data-lobby-id="${lobby.id}">
        <div class="lobby-header">
          <h3>${lobby.name}</h3>
          <span class="lobby-status ${statusClass}">${statusLabel}</span>
        </div>
        <div class="lobby-info">
          ${isFull && lobby.guestName
            ? `<div class="info-item">
                 <span class="value">${lobby.hostName.slice(0, 16)} <span class="label">vs</span> ${lobby.guestName.slice(0, 16)}</span>
               </div>`
            : `<div class="info-item">
                 <span class="label">Host:</span>
                 <span class="value">${lobby.hostName.slice(0, 16)}</span>
               </div>
               <div class="info-item">
                 <span class="label">Players:</span>
                 <span class="value">${lobby.playerCount} / 2</span>
               </div>`
          }
        </div>
        ${hasMiniHand ? `
          <div class="mini-hand">
            ${visibleCards.map(c => `
              <div class="mini-card ${c.red ? 'red' : ''}">
                <span class="mc-rank">${c.rank}</span>
                <span class="mc-suit">${c.suit}</span>
              </div>
            `).join('')}
            ${hiddenCount > 0 ? `<div class="mini-card-more">+${hiddenCount}</div>` : ''}
          </div>
        ` : ''}
        ${isForeground ? '' : `
          <button
            class="btn ${buttonClass} join-btn tx-guarded"
            data-lobby-id="${lobby.id}"
            data-action="${buttonAction}"
            ${buttonDisabled ? 'disabled' : ''}
            ${isPreparing ? 'title="Host is still preparing their deck"' : ''}
          >
            ${buttonLabel}
          </button>
        `}
      </div>
    `;
  }

  private attachEventListeners() {
    // Create lobby button (sticky footer)
    document.getElementById('create-lobby-btn')?.addEventListener('click', () => {
      this.showCreateLobbyModal();
    });

    // Refresh icon (top-right of sidebar header)
    document.getElementById('refresh-btn')?.addEventListener('click', () => {
      this.render();
    });

    // Leaderboard icon — dispatch a custom event so UIManager can toggle the
    // LeaderboardPanel (which is owned by UIManager, not this screen).
    document.getElementById('leaderboard-btn')?.addEventListener('click', () => {
      document.dispatchEvent(new CustomEvent('open-leaderboard', { bubbles: true }));
    });

    // Help modal — appended to document.body so it covers the full viewport
    let helpModal = document.getElementById('help-modal');
    if (!helpModal) {
      helpModal = document.createElement('div');
      helpModal.id = 'help-modal';
      helpModal.className = 'info-modal-overlay';
      helpModal.style.display = 'none';
      helpModal.innerHTML = `
        <div class="info-modal info-modal--wide">
          <button class="modal-close-btn" id="help-close-btn">&times;</button>
          <h2 class="info-modal-title">How to Play</h2>
          <div class="help-steps">
            <div class="help-step">
              <div class="help-visual">
                <div class="mini-hand help-hand">
                  <div class="mini-card red"><span class="mc-rank">A</span><span class="mc-suit">&hearts;</span></div>
                  <div class="mini-card red"><span class="mc-rank">2</span><span class="mc-suit">&diams;</span></div>
                  <div class="mini-card"><span class="mc-rank">3</span><span class="mc-suit">&clubs;</span></div>
                  <div class="mini-card red"><span class="mc-rank">4</span><span class="mc-suit">&hearts;</span></div>
                  <div class="mini-card"><span class="mc-rank">5</span><span class="mc-suit">&clubs;</span></div>
                  <div class="mini-card red"><span class="mc-rank">6</span><span class="mc-suit">&diams;</span></div>
                  <div class="mini-card"><span class="mc-rank">7</span><span class="mc-suit">&clubs;</span></div>
                </div>
              </div>
              <div class="help-text">
                <strong>The Deck</strong>
                <span>21 cards &mdash; 7 ranks (A, 2&ndash;7), each in &hearts; &diams; &clubs;</span>
              </div>
            </div>
            <div class="help-step">
              <div class="help-visual">
                <div class="mini-hand help-hand">
                  <div class="mini-card red"><span class="mc-rank">A</span><span class="mc-suit">&hearts;</span></div>
                  <div class="mini-card"><span class="mc-rank">3</span><span class="mc-suit">&clubs;</span></div>
                  <div class="mini-card red"><span class="mc-rank">5</span><span class="mc-suit">&diams;</span></div>
                  <div class="mini-card"><span class="mc-rank">7</span><span class="mc-suit">&clubs;</span></div>
                </div>
              </div>
              <div class="help-text">
                <strong>Deal</strong>
                <span>Each player is dealt 4 cards</span>
              </div>
            </div>
            <div class="help-step">
              <div class="help-visual">
                <div class="help-ask-example">
                  <div class="mini-card red help-card-highlight"><span class="mc-rank">A</span><span class="mc-suit">&hearts;</span></div>
                  <span class="help-arrow">&rarr;</span>
                  <span class="help-speech">Got any Aces?</span>
                </div>
              </div>
              <div class="help-text">
                <strong>Your Turn</strong>
                <span>Pick a rank you hold and ask your opponent for it. They must hand over all matching cards.</span>
              </div>
            </div>
            <div class="help-step">
              <div class="help-visual">
                <div class="help-ask-example">
                  <span class="help-speech">Nope!</span>
                  <span class="help-arrow">&rarr;</span>
                  <div class="mini-card help-card-facedown"><span class="mc-suit">?</span></div>
                </div>
              </div>
              <div class="help-text">
                <strong>Go Fish!</strong>
                <span>No match? Draw a card from the deck. Your turn ends.</span>
              </div>
            </div>
            <div class="help-step">
              <div class="help-visual">
                <div class="help-book-example">
                  <div class="mini-card red"><span class="mc-rank">A</span><span class="mc-suit">&hearts;</span></div>
                  <div class="mini-card red"><span class="mc-rank">A</span><span class="mc-suit">&diams;</span></div>
                  <div class="mini-card"><span class="mc-rank">A</span><span class="mc-suit">&clubs;</span></div>
                  <span class="help-book-label">= 1 Book</span>
                </div>
              </div>
              <div class="help-text">
                <strong>Books</strong>
                <span>Collect all 3 suits of a rank to score a Book (1 point). Books are scored automatically.</span>
              </div>
            </div>
            <div class="help-step">
              <div class="help-visual">
                <span class="help-trophy">&#x1f3c6;</span>
              </div>
              <div class="help-text">
                <strong>Winning</strong>
                <span>The player with the most Books when the game ends wins!</span>
              </div>
            </div>
          </div>
        </div>`;
      document.body.appendChild(helpModal);
      helpModal.querySelector('#help-close-btn')!.addEventListener('click', () => {
        helpModal!.style.display = 'none';
      });
      helpModal.addEventListener('click', (e) => {
        if (e.target === helpModal) helpModal!.style.display = 'none';
      });
    }
    document.getElementById('help-btn')?.addEventListener('click', () => {
      helpModal!.style.display = 'flex';
    });

    // About modal
    const aboutModal = document.getElementById('about-modal');
    const aboutClose = document.getElementById('about-close-btn');
    document.getElementById('about-btn')?.addEventListener('click', () => {
      if (aboutModal) aboutModal.style.display = 'flex';
    });
    aboutClose?.addEventListener('click', () => {
      if (aboutModal) aboutModal.style.display = 'none';
    });
    aboutModal?.addEventListener('click', (e) => {
      if (e.target === aboutModal) aboutModal.style.display = 'none';
    });

    // Resume buttons — jump straight into the game screen
    document.querySelectorAll('.resume-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        // Tx-in-flight guard: swapping games while a proof is running for
        // the current session leaves the proof orphaned and the loader
        // state pointing at a game the user is no longer viewing.
        if (!ensureNotBusy()) return;
        const target = e.target as HTMLElement;
        const lobbyId = target.dataset.lobbyId;
        if (lobbyId) {
          console.log('[LobbyListScreen] Resuming game (selecting on canvas):', lobbyId);
          // Stay on the menu sidebar; just swap the canvas to this game.
          // The user can still see Active Games / Available Lobbies while
          // their picked game plays in the background of the canvas.
          this.dispatchEvent('navigate', { screen: 'lobby-list' });
          this.dispatchEvent('select-game', { lobbyId });
        }
      });
    });

    // Dismiss buttons — remove the card from Active Games. Clears the
    // HandCache entry and force-destroys the session (stops its polling).
    // The game state on-chain is untouched; the user can still find it
    // via Available Lobbies or by rejoining if it re-opens.
    document.querySelectorAll('.resume-dismiss-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        // Tx-in-flight guard: dismissing mid-tx force-destroys the session,
        // which would orphan the in-flight proof/send.
        if (!ensureNotBusy()) return;
        // Don't let the click bubble up to the card itself (prevents
        // accidental Resume navigation).
        e.stopPropagation();
        const target = e.currentTarget as HTMLElement;
        const lobbyId = target.dataset.lobbyId;
        if (!lobbyId) return;
        console.log('[LobbyListScreen] Dismissing Active Games card:', lobbyId);
        GameSessionManager.instance.forceDestroy(lobbyId);
        clearCachedGame(lobbyId);
        void this.render();
      });
    });

    this.attachJoinButtonListeners();
  }

  private attachJoinButtonListeners(): void {
    document.querySelectorAll('.join-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        if (!ensureNotBusy()) return;
        const target = e.target as HTMLElement;
        const lobbyId = target.dataset.lobbyId;
        const action = target.dataset.action;
        if (!lobbyId) return;

        if (action === 'rejoin-game') {
          console.log('[LobbyListScreen] Rejoining game (selecting on canvas):', lobbyId);
          this.dispatchEvent('navigate', { screen: 'lobby-list' });
          this.dispatchEvent('select-game', { lobbyId });
        } else if (action === 'rejoin-lobby') {
          console.log('[LobbyListScreen] Returning to lobby screen:', lobbyId);
          this.dispatchEvent('navigate', { screen: 'lobby', lobbyId });
        } else {
          this.joinLobby(lobbyId);
        }
      });
    });
  }

  private showCreateLobbyModal() {
    const modal = document.getElementById('create-lobby-modal');
    if (!modal) return;

    modal.style.display = 'flex';
    soundManager.playModalOpen();

    // Close button (X) — sound is driven by the delegated handler via data-sfx.
    document.getElementById('modal-close-btn')?.addEventListener('click', () => {
      modal.style.display = 'none';
    });

    // Close on overlay click — not a button, so play the sound explicitly.
    modal.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).id === 'create-lobby-modal') {
        modal.style.display = 'none';
        soundManager.playModalClose();
      }
    });

    // Cancel button — sound via data-sfx delegation.
    document.getElementById('cancel-create-btn')?.addEventListener('click', () => {
      modal.style.display = 'none';
    });

    // Confirm button
    document.getElementById('confirm-create-btn')?.addEventListener('click', async () => {
      // Tx-in-flight guard: block creating a second game while a proof or
      // tx for an existing game is still running. Surfaces a toast.
      if (!ensureNotBusy()) return;

      const nameInput = document.getElementById('lobby-name') as HTMLInputElement;
      const confirmBtn = document.getElementById('confirm-create-btn') as HTMLButtonElement;

      const lobbyName = nameInput.value.trim() || `${this.gameService.getPlayerName()}'s Lobby`;

      if (!this.gameService.getPlayerName()) {
        soundManager.playError();
        alert('Please enter your name first!');
        return;
      }

      // Disable button while creating
      if (confirmBtn) {
        confirmBtn.disabled = true;
        confirmBtn.textContent = 'Creating...';
      }

      try {
        // Create lobby on-chain
        const lobby = await this.gameService.createLobby(lobbyName);

        if (!lobby) {
          soundManager.playError();
          alert('Failed to create lobby. Please try again.');
          return;
        }

        soundManager.playSuccess();

        // Join the lobby
        this.gameService.joinLobby(lobby.id);

        modal.style.display = 'none';

        // Navigate to lobby screen
        this.dispatchEvent('navigate', { screen: 'lobby', lobbyId: lobby.id });
      } catch (error) {
        console.error('Error creating lobby:', error);
        soundManager.playError();
        alert('Error creating lobby. Please check your wallet and try again.');
      } finally {
        // Re-enable button
        if (confirmBtn) {
          confirmBtn.disabled = false;
          confirmBtn.textContent = 'Create';
        }
      }
    });
  }

  private async joinLobby(lobbyId: string) {
    // Tx-in-flight guard: joining a second lobby mid-proof races the first.
    if (!ensureNotBusy()) return;

    if (!this.gameService.getPlayerName()) {
      soundManager.playError();
      alert('Please enter your name first!');
      return;
    }

    // Find and disable the join button
    const joinBtn = document.querySelector(`.join-btn[data-lobby-id="${lobbyId}"]`) as HTMLButtonElement;
    if (joinBtn) {
      joinBtn.disabled = true;
      joinBtn.textContent = 'Joining...';
    }

    // Track that we're joining to prevent render from re-enabling the button
    this.pendingJoinLobbyId = lobbyId;

    try {
      // Check for wallet collision with existing lobby players before joining.
      // Two browsers can randomly pick the same Hardhat account index (1-9),
      // causing both players to have the same wallet address and both getting playerId=1.
      const lobbyResult = await getLobbyState(lobbyId);
      if (lobbyResult.success && lobbyResult.lobby?.players) {
        const myAddress = getWalletAddress()?.toLowerCase();
        const existingAddresses = (lobbyResult.lobby.players as any[])
          .map((p) => p.wallet_address as string | null)
          .filter((a): a is string => a != null);
        const hasCollision = myAddress != null && existingAddresses.some(
          (addr) => addr.toLowerCase() === myAddress
        );

        if (hasCollision) {
          console.warn('[LobbyListScreen] Wallet collision detected with lobby host, switching account...');
          const switched = await switchAccount(existingAddresses);
          if (!switched) {
            soundManager.playError();
            alert('Could not find a unique wallet. Please try again.');
            if (joinBtn) { joinBtn.disabled = false; joinBtn.textContent = 'Join'; }
            this.pendingJoinLobbyId = null;
            return;
          }
          // Re-initialize game service with the new wallet address
          await this.gameService.initializeWithWallet();
          console.log('[LobbyListScreen] Switched to new wallet:', getWalletAddress());
        }
      }

      const success = await this.gameService.joinLobby(lobbyId);
      if (success) {
        soundManager.playSuccess();
        const wallet = getWalletAddress() || '';

        // Wait for the Paima node to process the join tx before creating
        // the GameSession. The EVM tx confirms instantly (Hardhat automine)
        // but the state machine processes the block asynchronously — if we
        // create the session immediately, its first poll hits /lobby_state
        // before the lobby_players insert and gets playerId=0.
        if (wallet) {
          await this.waitForJoinConfirmation(lobbyId, wallet);
          try {
            GameSessionManager.instance.getOrCreate(lobbyId, wallet);
          } catch (err) {
            console.warn('[LobbyListScreen] getOrCreate after join failed:', err);
          }
        }
        // IMPORTANT: clear the pending-join flag BEFORE dispatching
        // navigate. `dispatchEvent` is synchronous and UIManager's
        // listener will call `show()` → `render()` before this function
        // returns. If pendingJoinLobbyId is still set, render bails early
        // (guard meant to prevent re-enabling the Join button during a
        // join). Since show() clears container.innerHTML first, bailing
        // would leave the sidebar blank until the next event-driven
        // re-render.
        this.pendingJoinLobbyId = null;
        // Stay on the lobby list. The guest's LobbyScreen used to be where
        // applyMask(P2) ran — that now lives inside GameSession, so the
        // screen has no job on the guest side. The Active Games card will
        // show progress (Preparing → Dealing → Starting → Ready).
        this.dispatchEvent('navigate', { screen: 'lobby-list' });
        // Joining a game = selecting it. Swap the canvas to this lobby's
        // game scene (and hide the "Go Fish" intro overlay) without
        // changing the side-panel screen — the user stays on the menu but
        // the canvas reflects their picked game.
        this.dispatchEvent('select-game', { lobbyId });
      } else {
        soundManager.playError();
        alert('Failed to join lobby. It may be full.');
        // Re-enable button on failure
        if (joinBtn) {
          joinBtn.disabled = false;
          joinBtn.textContent = 'Join';
        }
      }
    } catch (error) {
      console.error('Error joining lobby:', error);
      soundManager.playError();
      alert('Error joining lobby. Please check your wallet and try again.');
      // Re-enable button on error
      if (joinBtn) {
        joinBtn.disabled = false;
        joinBtn.textContent = 'Join';
      }
    } finally {
      this.pendingJoinLobbyId = null;
    }
  }

  /**
   * Poll /lobby_state until our wallet appears in the players list, or
   * timeout. This bridges the gap between the EVM tx confirming and the
   * Paima node processing the block + inserting into lobby_players.
   */
  private async waitForJoinConfirmation(lobbyId: string, wallet: string, timeoutMs = 15000): Promise<void> {
    const t0 = Date.now();
    const walletLower = wallet.toLowerCase();
    while (Date.now() - t0 < timeoutMs) {
      const result = await getLobbyState(lobbyId);
      if (result.success && result.lobby?.players) {
        const found = (result.lobby.players as any[]).some(
          (p: any) => p.wallet_address?.toLowerCase() === walletLower,
        );
        if (found) {
          console.log(`[LobbyListScreen] Join confirmed in ${Date.now() - t0}ms`);
          return;
        }
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    console.warn(`[LobbyListScreen] waitForJoinConfirmation timed out after ${timeoutMs}ms — proceeding anyway`);
  }

  private dispatchEvent(type: string, detail: any) {
    this.container.dispatchEvent(new CustomEvent(type, { detail, bubbles: true }));
  }
}

/** Shape consumed by `renderResumableGame`. Union of the chain-snapshot
 *  fields and live-session overrides (inFlight). */
interface EnrichedResumable {
  lobbyId: string;
  playerId: 1 | 2;
  lobbyName: string;
  opponentName: string;
  myScore: number;
  opponentScore: number;
  isMyTurn: boolean;
  phase: number;
  inFlight: InFlightState;
  winner: 0 | 1 | 2;
}

/** Phase string (from session.state) → numeric phase used by sidebar UI.
 *  Mirrors the mapping baked into findResumableGames so both sources agree. */
const PHASE_STRING_TO_NUMBER: Record<string, number> = {
  dealing:         0,
  turn_start:      1,
  wait_response:   2,
  wait_transfer:   3,
  wait_draw:       4,
  wait_draw_check: 5,
  game_over:       6,
};

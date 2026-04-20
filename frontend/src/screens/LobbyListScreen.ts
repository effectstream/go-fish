/**
 * Lobby List Screen - Shows available lobbies and create lobby option
 */

import { GoFishGameService } from '../services/GoFishGameService';
import type { Lobby } from '../../../packages/shared/data-types/src/go-fish-types';
import { getWalletAddress, switchAccount, getLobbyState } from '../effectstreamBridge';
import { GameSessionManager } from '../game/GameSessionManager';
import type { GameSession } from '../game/GameSession';
import type { InFlightState, SessionSnapshot } from '../game/types';
import { getCachedGame, listCachedGames, type CachedGame } from '../services/HandCache';

export class LobbyListScreen {
  private container: HTMLElement;
  private gameService: GoFishGameService;
  private refreshInterval?: number;
  private pendingJoinLobbyId: string | null = null; // Track which lobby we're joining
  /** Teardown for manager event listeners wired in show(). */
  private managerUnsub: (() => void) | null = null;
  /** Debounce guard for re-renders driven by session events. */
  private renderScheduled = false;

  constructor(container: HTMLElement) {
    this.container = container;
    this.gameService = GoFishGameService.getInstance();
  }

  async show() {
    await this.render();
    // Refresh lobby list every 4 seconds to reduce database pressure
    // The lobby list doesn't need to be super responsive
    this.refreshInterval = window.setInterval(() => this.render(), 4000);
    // Re-render whenever a live game session updates — keeps the Active
    // Games badges (PROVING / SENDING / YOUR TURN) fresh without waiting
    // for the 4-second interval.
    this.managerUnsub = this.subscribeToSessionManager();
  }

  hide() {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
    }
    this.managerUnsub?.();
    this.managerUnsub = null;
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

  private async render() {
    // Don't re-render if we're in the middle of joining a lobby
    if (this.pendingJoinLobbyId) {
      return;
    }

    // Fetch open lobbies and the player's resumable games in parallel
    const [lobbies, resumableGames] = await Promise.all([
      this.gameService.fetchOpenLobbies(),
      this.gameService.findResumableGames().catch(err => {
        console.warn('[LobbyListScreen] findResumableGames failed:', err);
        return [] as Array<{ lobbyId: string; playerId: 1 | 2; lobbyName: string; opponentName: string }>;
      }),
    ]);

    // Live sessions take precedence over the point-in-time resumable-games
    // snapshot — scores, turn, phase, and inFlight state all come from the
    // session when it exists so the sidebar reflects proofs / txs in real
    // time. Sessions not yet in findResumableGames (just-created games)
    // still show up via the sessions-only tail below.
    const liveSessions = GameSessionManager.instance.list();
    const sessionsByLobby = new Map<string, GameSession>(
      liveSessions.map(s => [s.lobbyId, s]),
    );
    const enrichedGames = this.mergeWithLiveSessions(resumableGames, sessionsByLobby);

    // Check if modal is open - if so, don't re-render
    const existingModal = document.getElementById('create-lobby-modal') as HTMLElement;
    const isModalOpen = existingModal && existingModal.style.display !== 'none';
    if (isModalOpen) {
      // Just update the lobby list without full re-render
      const lobbyListEl = document.querySelector('.lobby-list');
      if (lobbyListEl) {
        lobbyListEl.innerHTML = lobbies.length === 0
          ? '<div class="empty-state">No lobbies available. Create one!</div>'
          : lobbies.map(lobby => this.renderLobby(lobby)).join('');

        // Reattach join button listeners
        document.querySelectorAll('.join-btn').forEach(btn => {
          btn.addEventListener('click', (e) => {
            const target = e.target as HTMLElement;
            const lobbyId = target.dataset.lobbyId;
            const isRejoin = target.dataset.isRejoin === 'true';
            if (lobbyId) {
              if (isRejoin) {
                console.log('[LobbyListScreen] Rejoining lobby (already a member):', lobbyId);
                this.dispatchEvent('navigate', { screen: 'lobby', lobbyId });
              } else {
                this.joinLobby(lobbyId);
              }
            }
          });
        });
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

          <h2>Available Lobbies (${lobbies.length})</h2>
          <div class="lobby-list">
            ${lobbies.length === 0
              ? '<div class="empty-state">No lobbies available yet.</div>'
              : lobbies.map(lobby => this.renderLobby(lobby)).join('')
            }
          </div>
        </div>

        <footer class="side-footer">
          <button id="create-lobby-btn" class="btn btn-primary">Create New Lobby</button>
        </footer>

        <!-- Create Lobby Modal (with overlay) -->
        <div id="create-lobby-modal" class="create-lobby-modal-overlay" style="display: none;">
          <div class="create-lobby-modal">
            <div class="modal-header">
              <h2>Create New Lobby</h2>
              <button class="modal-close-btn" id="modal-close-btn">&times;</button>
            </div>
            <div class="form-group">
              <label>Lobby Name:</label>
              <input type="text" id="lobby-name" placeholder="Enter lobby name" maxlength="30" value="${defaultLobbyName}"/>
            </div>
            <div class="form-group">
              <span class="form-hint">Go Fish is a 2-player game. Your game will start automatically when someone joins.</span>
            </div>
            <div class="modal-actions">
              <button id="confirm-create-btn" class="btn btn-primary">Create</button>
              <button id="cancel-create-btn" class="btn btn-secondary">Cancel</button>
            </div>
          </div>
        </div>
      </div>
    `;

    this.attachEventListeners();
  }

  private renderResumableGame(game: EnrichedResumable): string {
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

    return `
      <div class="lobby-card resume-card" data-lobby-id="${game.lobbyId}">
        <div class="lobby-header">
          <h3>${game.lobbyName}</h3>
          ${inFlightPill ?? (showStatusPill ? `<span class="lobby-status ${statusClass}">${statusText}</span>` : '')}
        </div>
        <div class="mini-hand">
          ${visibleCards.map(c => `
            <div class="mini-card ${c.red ? 'red' : ''}">
              <span class="mc-rank">${c.rank}</span>
              <span class="mc-suit">${c.suit}</span>
            </div>
          `).join('')}
          ${hiddenCount > 0 ? `<div class="mini-card-more">+${hiddenCount}</div>` : ''}
        </div>
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
        <button class="btn btn-primary resume-btn" data-lobby-id="${game.lobbyId}">
          ${meActive ? 'Play Turn' : 'Resume'}
        </button>
      </div>
    `;
  }

  /** Overlay live session state (score, turn, phase, inFlight) onto the
   *  chain-snapshot resumable-games list. Sessions not in the resumable
   *  list (e.g., freshly created this tab) are appended as synthetic
   *  entries so they still appear in the sidebar. */
  private mergeWithLiveSessions(
    resumableGames: Array<{
      lobbyId: string;
      playerId: 1 | 2;
      lobbyName: string;
      opponentName: string;
      myScore: number;
      opponentScore: number;
      isMyTurn: boolean;
      phase: number;
    }>,
    sessions: Map<string, GameSession>,
  ): EnrichedResumable[] {
    const enriched: EnrichedResumable[] = resumableGames.map(g => {
      const s = sessions.get(g.lobbyId);
      if (s) return this.overlaySessionOntoGame(g, s);
      // No live session — try the localStorage cache next. Written on every
      // poll of any session, so even after the user navigates away and
      // back (or reloads the tab) the sidebar can show accurate scores /
      // inFlight without reaching the contract.
      const cached = getCachedGame(g.lobbyId);
      if (cached) return this.overlayCacheOntoGame(g, cached);
      return { ...g, inFlight: null };
    });

    // Sessions that aren't yet reflected in findResumableGames — keep them
    // visible rather than making the user wait for the next chain fetch.
    const seen = new Set(resumableGames.map(g => g.lobbyId));
    for (const session of sessions.values()) {
      if (seen.has(session.lobbyId)) continue;
      const snap = session.getSnapshot();
      const state = snap.state;
      const synthetic: EnrichedResumable = {
        lobbyId: session.lobbyId,
        playerId: (snap.playerId || 1) as 1 | 2,
        lobbyName: session.lobbyId.slice(0, 12),
        opponentName: state?.opponentName ?? 'Opponent',
        myScore: state ? state.scores[state.playerId - 1] : 0,
        opponentScore: state ? state.scores[state.playerId === 1 ? 1 : 0] : 0,
        isMyTurn: state ? state.currentTurn === state.playerId : false,
        phase: PHASE_STRING_TO_NUMBER[state?.phase ?? 'dealing'] ?? 0,
        inFlight: snap.inFlight,
      };
      enriched.push(synthetic);
      seen.add(session.lobbyId);
    }

    // Cached games that are neither in findResumableGames nor in active
    // sessions — typically happens on a fresh tab load before the chain
    // fetch completes, or after a transient backend hiccup. Hydrate from
    // cache so the sidebar doesn't briefly go empty.
    for (const [lobbyId, cached] of listCachedGames()) {
      if (seen.has(lobbyId)) continue;
      enriched.push({
        lobbyId,
        playerId: cached.playerId,
        lobbyName: cached.lobbyName || lobbyId.slice(0, 12),
        opponentName: cached.opponentName,
        myScore: cached.myScore,
        opponentScore: cached.opponentScore,
        isMyTurn: cached.isMyTurn,
        phase: cached.phase,
        inFlight: cached.inFlight,
      });
    }
    return enriched;
  }

  /** Overlay cached sidebar data on the chain-snapshot row. Preserves the
   *  `lobbyName` from findResumableGames (which comes from the Paima lobby
   *  table — more canonical than whatever the session may have stored).
   *  Everything else comes from the cache. */
  private overlayCacheOntoGame(
    g: {
      lobbyId: string;
      playerId: 1 | 2;
      lobbyName: string;
      opponentName: string;
      myScore: number;
      opponentScore: number;
      isMyTurn: boolean;
      phase: number;
    },
    cached: CachedGame,
  ): EnrichedResumable {
    return {
      ...g,
      opponentName: cached.opponentName || g.opponentName,
      myScore: cached.myScore,
      opponentScore: cached.opponentScore,
      isMyTurn: cached.isMyTurn,
      phase: cached.phase,
      inFlight: cached.inFlight,
    };
  }

  /** Compose one row from (chain snapshot, live session). Session fields
   *  win where present — they reflect the latest poll + local inFlight. */
  private overlaySessionOntoGame(
    g: {
      lobbyId: string;
      playerId: 1 | 2;
      lobbyName: string;
      opponentName: string;
      myScore: number;
      opponentScore: number;
      isMyTurn: boolean;
      phase: number;
    },
    session: GameSession,
  ): EnrichedResumable {
    const snap: SessionSnapshot = session.getSnapshot();
    const state = snap.state;
    if (!state) {
      return { ...g, inFlight: snap.inFlight };
    }
    const myIdx = state.playerId - 1;
    const oppIdx = state.playerId === 1 ? 1 : 0;
    return {
      ...g,
      opponentName: state.opponentName || g.opponentName,
      myScore: state.scores[myIdx],
      opponentScore: state.scores[oppIdx],
      isMyTurn: state.currentTurn === state.playerId,
      phase: PHASE_STRING_TO_NUMBER[state.phase] ?? g.phase,
      inFlight: snap.inFlight,
    };
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
   *  the first few. */
  private miniHandFor(lobbyId: string): {
    cards: Array<{ rank: string; suit: string; red: boolean }>;
    total: number;
    /** True when the data is from the real-time cache, false when it's
     *  the seeded mock (no poll has populated the cache yet). */
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
    return { cards: this.mockMiniHand(lobbyId), total: 0, live: false };
  }

  /** Deterministic mock hand derived from the lobby id. Shows 4 cards so
   *  each Active Games card has a sensible preview without extra contract
   *  reads. Real hand data lives in the game screen. */
  private mockMiniHand(seedStr: string): Array<{ rank: string; suit: string; red: boolean }> {
    // Simple string hash for deterministic seeding
    let hash = 0;
    for (let i = 0; i < seedStr.length; i++) {
      hash = ((hash << 5) - hash) + seedStr.charCodeAt(i);
      hash |= 0;
    }
    const RANKS = ['A', '2', '3', '4', '5', '6', '7'];
    const SUITS = [
      { sym: '♥', red: true },
      { sym: '♦', red: true },
      { sym: '♣', red: false },
      { sym: '♠', red: false },
    ];
    const hand: Array<{ rank: string; suit: string; red: boolean }> = [];
    for (let i = 0; i < 4; i++) {
      // LCG step from the seed hash → different index per position
      hash = (hash * 1103515245 + 12345) | 0;
      const rIdx = Math.abs(hash) % RANKS.length;
      hash = (hash * 1103515245 + 12345) | 0;
      const sIdx = Math.abs(hash) % SUITS.length;
      const s = SUITS[sIdx];
      hand.push({ rank: RANKS[rIdx], suit: s.sym, red: s.red });
    }
    return hand;
  }

  private renderLobby(lobby: Lobby): string {
    const isFull = lobby.playerCount >= 2;
    return `
      <div class="lobby-card" data-lobby-id="${lobby.id}">
        <div class="lobby-header">
          <h3>${lobby.name}</h3>
          <span class="lobby-status ${lobby.status}">${lobby.status}</span>
        </div>
        <div class="lobby-info">
          <div class="info-item">
            <span class="label">Host:</span>
            <span class="value">${lobby.hostName}</span>
          </div>
          <div class="info-item">
            <span class="label">Players:</span>
            <span class="value">${lobby.playerCount} / 2</span>
          </div>
        </div>
        <button
          class="btn btn-primary join-btn"
          data-lobby-id="${lobby.id}"
          data-is-rejoin="${lobby.isPlayerInLobby ? 'true' : 'false'}"
          ${isFull && !lobby.isPlayerInLobby ? 'disabled' : ''}
        >
          ${lobby.isPlayerInLobby ? 'Rejoin' : (isFull ? 'Full' : 'Join')}
        </button>
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

    // Help icon — placeholder for a future "How to play" modal.
    document.getElementById('help-btn')?.addEventListener('click', () => {
      console.log('[LobbyListScreen] Help button clicked — modal not implemented yet');
    });

    // About / Report icon — placeholder for a future "About & Report an
    // issue" modal.
    document.getElementById('about-btn')?.addEventListener('click', () => {
      console.log('[LobbyListScreen] About button clicked — modal not implemented yet');
    });

    // Resume buttons — jump straight into the game screen
    document.querySelectorAll('.resume-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const lobbyId = target.dataset.lobbyId;
        if (lobbyId) {
          console.log('[LobbyListScreen] Resuming game:', lobbyId);
          this.dispatchEvent('navigate', { screen: 'game', lobbyId });
        }
      });
    });

    // Join buttons
    document.querySelectorAll('.join-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const lobbyId = target.dataset.lobbyId;
        const isRejoin = target.dataset.isRejoin === 'true';
        if (lobbyId) {
          if (isRejoin) {
            // Already in the lobby — just navigate, don't send another join transaction
            console.log('[LobbyListScreen] Rejoining lobby (already a member):', lobbyId);
            this.dispatchEvent('navigate', { screen: 'lobby', lobbyId });
          } else {
            this.joinLobby(lobbyId);
          }
        }
      });
    });
  }

  private showCreateLobbyModal() {
    const modal = document.getElementById('create-lobby-modal');
    if (!modal) return;

    modal.style.display = 'flex';

    // Close button (X)
    document.getElementById('modal-close-btn')?.addEventListener('click', () => {
      modal.style.display = 'none';
    });

    // Close on overlay click
    modal.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).id === 'create-lobby-modal') {
        modal.style.display = 'none';
      }
    });

    // Cancel button
    document.getElementById('cancel-create-btn')?.addEventListener('click', () => {
      modal.style.display = 'none';
    });

    // Confirm button
    document.getElementById('confirm-create-btn')?.addEventListener('click', async () => {
      const nameInput = document.getElementById('lobby-name') as HTMLInputElement;
      const confirmBtn = document.getElementById('confirm-create-btn') as HTMLButtonElement;

      const lobbyName = nameInput.value.trim() || `${this.gameService.getPlayerName()}'s Lobby`;

      if (!this.gameService.getPlayerName()) {
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
          alert('Failed to create lobby. Please try again.');
          return;
        }

        // Join the lobby
        this.gameService.joinLobby(lobby.id);

        modal.style.display = 'none';

        // Navigate to lobby screen
        this.dispatchEvent('navigate', { screen: 'lobby', lobbyId: lobby.id });
      } catch (error) {
        console.error('Error creating lobby:', error);
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
    if (!this.gameService.getPlayerName()) {
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
        this.dispatchEvent('navigate', { screen: 'lobby', lobbyId });
      } else {
        alert('Failed to join lobby. It may be full.');
        // Re-enable button on failure
        if (joinBtn) {
          joinBtn.disabled = false;
          joinBtn.textContent = 'Join';
        }
      }
    } catch (error) {
      console.error('Error joining lobby:', error);
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

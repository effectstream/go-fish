/**
 * Lobby Screen - Waiting room before game starts.
 *
 * Go Fish is always 2 players. The lobby screen is where mask application
 * happens (moved forward from the game screen):
 *   - Host lands here immediately after createdLobby → runs applyMask(P1) →
 *     submits hostReady grammar → waits for opponent.
 *   - Guest lands here immediately after joinedLobby → runs applyMask(P2).
 *   - Once both masks are confirmed and status=in_progress → navigate to game.
 *
 * Actions:
 *   - Host, alone and mask done: "Cancel Lobby" → closedLobby.
 *   - Anyone: Retry button on mask failure.
 */

import { GoFishGameService } from '../services/GoFishGameService';
import { applyMyMask } from '../game/SetupFlow';
import { MidnightService } from '../services/MidnightService';
import { submitHostReady } from '../effectstreamBridge';
import { soundManager } from '../three/SoundManager';
import { GameSessionManager } from '../game/GameSessionManager';

interface LobbyStateResponse {
  players: Array<{
    wallet_address: string;
    account_id: number;
    player_name: string;
  }>;
  host_account_id: number;
  host_mask_applied?: boolean;
  lobby_name: string;
  status: string;
  created_at?: string;
  is_expired?: boolean;
}

/**
 * Local per-player mask state. Starts idle, advances as applyMyMask progresses.
 * Failure state drops into 'failed' which surfaces a Retry button.
 */
type MaskPhase = 'idle' | 'in_progress' | 'done' | 'failed';

export class LobbyScreen {
  private container: HTMLElement;
  private gameService: GoFishGameService;
  private lobbyId: string = '';
  private refreshInterval?: number;
  private fetchFailCount: number = 0;
  private cancelPending: boolean = false;

  /** My role in this lobby, resolved from the first successful lobby_state read. */
  private myPlayerId: 1 | 2 | null = null;
  private isHost: boolean = false;

  /** Mask state for me. Advances idle → in_progress → done/failed. */
  private myMaskPhase: MaskPhase = 'idle';
  /** Cached on-chain mask status for the opponent (polled via getSetupStatus). */
  private opponentMaskApplied: boolean = false;
  /** Cached on-chain mask status for me. Mirrors myMaskPhase=='done' once confirmed. */
  private myMaskApplied: boolean = false;
  /** Cached on-chain `hasDealt` for me + opponent. Dealing happens in the
   *  background via GameSession.runAutomaticSetup — the lobby screen just
   *  waits for both flags to land before bouncing to the main menu, so the
   *  user doesn't see a stray "Awaiting confirmation: dealing cards"
   *  global loader on the menu. */
  private myHasDealt: boolean = false;
  private opponentHasDealt: boolean = false;

  /** True while the hostReady grammar tx is being submitted. */
  private hostReadySubmitting: boolean = false;
  /** True once hostReady has landed (or we've detected host_mask_applied in lobby state). */
  private hostReadySubmitted: boolean = false;
  /** One-shot guard for the "everything ready, leave" navigation.
   *  `tick()` is async, and setInterval keeps firing while a tick awaits —
   *  without this flag, two in-flight ticks both observe the ready state
   *  and both dispatch `navigate: lobby-list`, producing duplicate
   *  SceneManager + UIManager transitions. */
  private navigationTriggered: boolean = false;

  /** Last rendered signature — prevents innerHTML churn on every poll. */
  private lastRenderSig: string = '';

  /** Tracks player count between ticks so we can fire a one-shot
   *  "opponent joined" sound on the 1 → 2 transition. */
  private lastPlayerCount: number = 0;

  /** True once the expiry popup has been shown — prevents repeat popups. */
  private expiryShown: boolean = false;

  private static readonly MAX_FETCH_FAILS = 5;

  constructor(container: HTMLElement) {
    this.container = container;
    this.gameService = GoFishGameService.getInstance();
  }

  async show(lobbyId: string) {
    this.lobbyId = lobbyId;
    this.fetchFailCount = 0;
    this.cancelPending = false;
    this.myPlayerId = null;
    this.isHost = false;
    this.myMaskPhase = 'idle';
    this.opponentMaskApplied = false;
    this.myMaskApplied = false;
    this.myHasDealt = false;
    this.opponentHasDealt = false;
    this.hostReadySubmitting = false;
    this.hostReadySubmitted = false;
    this.navigationTriggered = false;
    this.lastRenderSig = '';
    this.lastPlayerCount = 0;
    this.expiryShown = false;

    await this.tick();
    // 3s poll — covers lobby-state (player joins, host_mask_applied flip) and
    // on-chain mask status for the opponent. Separate Midnight queries are
    // cheap enough at this cadence for a single-lobby view.
    this.refreshInterval = window.setInterval(() => this.tick(), 3000);
  }

  hide() {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = undefined;
    }
  }

  /** One poll cycle: fetch lobby state, resolve role, advance mask flow, render. */
  private async tick() {
    const lobby = await this.fetchLobbyState();
    if (!lobby) return;

    if (this.checkLobbyExpired(lobby)) return;

    this.resolveRole(lobby);
    this.detectPlayerJoined(lobby);
    await this.refreshMaskStatus();
    this.kickMaskFlowIfNeeded();
    this.maybeLeaveLobbyOnReady(lobby);
    this.render(lobby);
  }

  /** If the lobby is still open and has exceeded the 10-minute TTL, show an
   *  expiry popup and stop polling. Uses the server-computed `is_expired`
   *  flag so we don't depend on client/server clock agreement. */
  private checkLobbyExpired(lobby: LobbyStateResponse): boolean {
    if (this.expiryShown) return true;
    if (!lobby.is_expired) return false;
    if ((lobby.players || []).length >= 2) return false;

    this.expiryShown = true;
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = undefined;
    }
    this.showExpiredPopup(lobby.lobby_name);
    return true;
  }

  private showExpiredPopup(lobbyName: string): void {
    this.container.innerHTML = `
      <div class="lobby-screen" style="display:flex;align-items:center;justify-content:center;height:100%;">
        <div style="background:#1a1a2e;border:1px solid rgba(255,255,255,0.15);border-radius:0.5rem;padding:2rem;max-width:340px;text-align:center;">
          <h2 style="color:#e2e8f0;margin:0 0 1rem;">Lobby Closed</h2>
          <p style="color:#a0aec0;margin:0 0 1.5rem;line-height:1.5;">
            <strong style="color:#e2e8f0;">${lobbyName}</strong> was open for 10 minutes without anyone joining and has been removed from the lobby list.
          </p>
          <button id="expired-ok-btn" class="btn btn-primary" style="min-width:120px;">OK</button>
        </div>
      </div>
    `;
    document.getElementById('expired-ok-btn')?.addEventListener('click', () => {
      this.dispatchEvent('navigate', { screen: 'lobby-list' });
    });
  }

  /** Fire a one-shot "opponent joined" sound on the 1 → 2 transition. */
  private detectPlayerJoined(lobby: LobbyStateResponse): void {
    const count = (lobby.players || []).length;
    if (this.lastPlayerCount === 1 && count >= 2) {
      soundManager.playPlayerJoined();
    }
    this.lastPlayerCount = count;
  }

  private async fetchLobbyState(): Promise<LobbyStateResponse | null> {
    try {
      const { API_BASE_URL } = await import('../apiConfig');
      const response = await fetch(`${API_BASE_URL}/lobby_state?lobby_id=${this.lobbyId}`);
      if (!response.ok) {
        this.fetchFailCount++;
        if (this.fetchFailCount >= LobbyScreen.MAX_FETCH_FAILS) {
          console.warn('[LobbyScreen] Lobby no longer available, returning to list');
          this.dispatchEvent('navigate', { screen: 'lobby-list' });
        } else if (this.lastRenderSig !== 'loading') {
          this.lastRenderSig = 'loading';
          this.renderLoading();
        }
        return null;
      }
      this.fetchFailCount = 0;
      return (await response.json()) as LobbyStateResponse;
    } catch (err) {
      console.warn('[LobbyScreen] fetchLobbyState failed:', err);
      return null;
    }
  }

  private resolveRole(lobby: LobbyStateResponse): void {
    if (this.myPlayerId !== null) return;
    const myWalletAddress = this.gameService.getPlayerId().toLowerCase();
    const players = lobby.players || [];
    const me = players.find(
      p => p.wallet_address?.toLowerCase() === myWalletAddress,
    );
    if (!me) return; // Haven't appeared in the lobby yet — wait for next poll.
    this.isHost = me.account_id === lobby.host_account_id;
    // Host is always player 1; guest is always player 2 (EVM join order).
    this.myPlayerId = this.isHost ? 1 : 2;
    console.log(
      `[LobbyScreen] Role resolved for ${this.lobbyId}: playerId=${this.myPlayerId} (${this.isHost ? 'host' : 'guest'}), myWallet=${myWalletAddress}, players=${players.length}`,
    );
    // Flag wallet collisions loudly — dev env can give both browsers the
    // same Hardhat account, which silently maps both to playerId=1 and
    // leaves P2 stuck forever waiting for a mask P2 will never apply.
    if (players.length > 1 &&
        players[0].wallet_address?.toLowerCase() === players[1].wallet_address?.toLowerCase()) {
      console.warn(
        `[LobbyScreen] Wallet collision in ${this.lobbyId}: both players share ${myWalletAddress}.`,
        'Switch to a different Hardhat account (dev) — otherwise only the host can progress.',
      );
    }
  }

  /** Pull current mask + dealt status from the Midnight indexer for both
   *  sides. Mask state is monotonic (true → never flips back), so we can
   *  short-circuit once both mask + dealt flags are all true. */
  private async refreshMaskStatus(): Promise<void> {
    if (this.myPlayerId === null) return;
    if (this.myMaskApplied && this.opponentMaskApplied
        && this.myHasDealt && this.opponentHasDealt) return;
    try {
      const status = await MidnightService.getSetupStatus(this.lobbyId, this.myPlayerId);
      // Log only when a flag transitions — avoids log spam on steady state.
      if (status.hasMaskApplied !== this.myMaskApplied
          || status.opponentHasMaskApplied !== this.opponentMaskApplied
          || status.hasDealt !== this.myHasDealt
          || status.opponentHasDealt !== this.opponentHasDealt) {
        console.log(
          `[LobbyScreen] refreshMaskStatus transition for pid=${this.myPlayerId}: `
          + `myMask ${this.myMaskApplied}→${status.hasMaskApplied}, `
          + `oppMask ${this.opponentMaskApplied}→${status.opponentHasMaskApplied}, `
          + `myDealt ${this.myHasDealt}→${status.hasDealt}, `
          + `oppDealt ${this.opponentHasDealt}→${status.opponentHasDealt}`,
        );
      }
      this.myMaskApplied = status.hasMaskApplied;
      this.opponentMaskApplied = status.opponentHasMaskApplied;
      this.myHasDealt = status.hasDealt;
      this.opponentHasDealt = status.opponentHasDealt;
      if (this.myMaskApplied && this.myMaskPhase !== 'done') {
        // Detected mask already on-chain (e.g., page reload mid-flow). Skip
        // the submit path entirely so we don't double-submit.
        this.myMaskPhase = 'done';
      }
    } catch {
      // Transient — next tick will retry.
    }
  }

  /** Start applyMyMask if we haven't yet. Non-blocking — runs in background. */
  private kickMaskFlowIfNeeded(): void {
    if (this.myPlayerId === null) return;
    if (this.myMaskPhase !== 'idle') return;
    if (this.myMaskApplied) {
      this.myMaskPhase = 'done';
      return;
    }
    this.myMaskPhase = 'in_progress';
    void this.runMaskFlow();
  }

  private async runMaskFlow(): Promise<void> {
    if (this.myPlayerId === null) return;
    const pid = this.myPlayerId;
    console.log(`[LobbyScreen] Starting applyMyMask for player ${pid}`);
    const result = await applyMyMask(this.lobbyId, pid);
    if (result.success) {
      this.myMaskPhase = 'done';
      this.myMaskApplied = true;
      soundManager.playSuccess();
      console.log(`[LobbyScreen] Mask applied for player ${pid}`);
      if (this.isHost) {
        void this.runHostReady();
      }
    } else {
      this.myMaskPhase = 'failed';
      soundManager.playError();
      console.warn(`[LobbyScreen] Mask failed for player ${pid}:`, result.errorMessage);
    }
    // Trigger a re-render now that state has changed.
    await this.tick();
  }

  /** Host-only: after mask lands on-chain, submit hostReady grammar so the
   *  open-lobbies list flips from "Preparing" to "Open". Idempotent on the
   *  contract side, so transient retries are safe. */
  private async runHostReady(): Promise<void> {
    if (this.hostReadySubmitting || this.hostReadySubmitted) return;
    this.hostReadySubmitting = true;
    try {
      const res = await submitHostReady(this.lobbyId);
      if (res.success) {
        this.hostReadySubmitted = true;
        console.log('[LobbyScreen] hostReady submitted');
      } else {
        console.warn('[LobbyScreen] hostReady submit failed:', res.errorMessage);
      }
    } catch (err) {
      console.warn('[LobbyScreen] hostReady threw:', err);
    } finally {
      this.hostReadySubmitting = false;
    }
  }

  private maybeLeaveLobbyOnReady(lobby: LobbyStateResponse): void {
    // Bounce to the main menu as soon as the EVM lobby has flipped to
    // in_progress AND this player's mask is confirmed on-chain. Dealing
    // and startGame now run fully in the background via GameSession —
    // global loader is muted while on the menu, per-card badges show
    // progress. The host's mask is always done long before P2 joins, so
    // in practice this fires as soon as P2's join lands.
    if (this.navigationTriggered) return;
    if (lobby.status === 'in_progress' && this.myMaskApplied) {
      this.navigationTriggered = true;
      if (this.refreshInterval) {
        clearInterval(this.refreshInterval);
        this.refreshInterval = undefined;
      }
      console.log('[LobbyScreen] in_progress + my mask confirmed → returning to main menu');
      soundManager.playGameStart();
      this.dispatchEvent('navigate', { screen: 'lobby-list' });
    } else {
      // Diagnostic: surface which precondition is blocking the navigation.
      console.log(
        `[LobbyScreen] Gate check — status=${lobby.status} myMaskApplied=${this.myMaskApplied}`,
      );
    }
  }

  private render(lobby: LobbyStateResponse) {
    const players = lobby.players || [];
    const playerCount = players.length;
    const myWalletAddress = this.gameService.getPlayerId();

    const infoText = this.computeInfoText(playerCount);
    const statusClass = this.computeStatusClass();

    // Cancel button only when: I'm host, mask is done, no opponent has joined.
    // (Can't cancel mid-mask — the Midnight tx is already in flight.)
    const canCancel = this.isHost && this.myMaskPhase === 'done' && playerCount < 2;
    const canRetryMask = this.myMaskPhase === 'failed';

    const sig = [
      lobby.lobby_name,
      playerCount,
      infoText,
      statusClass,
      canCancel,
      canRetryMask,
      this.myMaskPhase,
    ].join('|');
    if (sig === this.lastRenderSig) return;
    this.lastRenderSig = sig;

    const footerButtons = [
      canRetryMask ? `<button id="retry-mask-btn" class="btn btn-primary">Retry</button>` : '',
      canCancel ? `<button id="cancel-lobby-btn" class="btn btn-secondary">Cancel Lobby</button>` : '',
    ].filter(Boolean).join(' ');

    this.container.innerHTML = `
      <div class="lobby-screen">
        <header class="side-header">
          <button id="back-btn" class="icon-btn back-btn" title="Back to lobbies" aria-label="Back">‹</button>
          <h1 class="title">${lobby.lobby_name}</h1>
          <div class="lobby-id-chip" title="Lobby ID — also the Midnight game ID">id: ${this.lobbyId}</div>
          <div class="welcome ${statusClass}">${infoText}</div>
        </header>

        <div class="side-content">
          <h2>Players (${playerCount}/2)</h2>
          <div class="players-list">
            ${players.map(p => this.renderPlayer(p, lobby.host_account_id, myWalletAddress)).join('')}
            ${playerCount < 2 ? `
              <div class="player-item waiting-slot">
                <span class="player-name">${
                  this.myMaskPhase === 'done'
                    ? 'Waiting for opponent…'
                    : 'Preparing game…'
                }</span>
              </div>
            ` : ''}
          </div>
        </div>

        <footer class="side-footer">
          ${footerButtons}
        </footer>
      </div>
    `;

    this.attachEventListeners();
  }

  /** Status-line text reflecting mask + dealing progress. */
  private computeInfoText(playerCount: number): string {
    if (this.myMaskPhase === 'failed') {
      return 'Mask failed. Tap Retry to try again.';
    }
    if (this.myMaskPhase !== 'done') {
      // Lead with "Preparing Game" regardless of role — it's the dominant
      // signal the user cares about.
      return 'Preparing Game…';
    }
    // My mask is done.
    if (this.isHost && playerCount < 2) {
      return 'Deck ready — waiting for an opponent to join…';
    }
    if (!this.opponentMaskApplied) {
      return this.isHost ? 'Opponent joined — preparing their deck…' : 'Waiting for host…';
    }
    // Both masks on-chain — dealing now runs in GameSession.
    if (!this.myHasDealt || !this.opponentHasDealt) {
      return 'Dealing cards…';
    }
    // Both dealt but V4.3 startGame circuit hasn't landed yet → phase is
    // still 'Setup' on-chain. GameSession.setupStartGame drives it.
    const session = GameSessionManager.instance.get(this.lobbyId);
    if (session && session.getSnapshot().setupPhase !== 'done') {
      return 'Starting game…';
    }
    return 'Game ready — returning to menu…';
  }

  private computeStatusClass(): string {
    if (this.myMaskPhase === 'failed') return 'status-error';
    if (this.myMaskPhase !== 'done') return 'status-preparing';
    return 'status-ready';
  }

  private renderPlayer(player: any, hostAccountId: number, myWalletAddress: string): string {
    const playerIsHost = player.account_id === hostAccountId;
    const isMe = player.wallet_address?.toLowerCase() === myWalletAddress.toLowerCase();
    return `
      <div class="player-item ${isMe ? 'current-player' : ''}">
        <span class="player-name">
          ${player.player_name}
          ${playerIsHost ? '<span class="badge host">Host</span>' : ''}
          ${isMe ? '<span class="badge you">You</span>' : ''}
        </span>
      </div>
    `;
  }

  private renderLoading() {
    this.container.innerHTML = `
      <div class="lobby-screen">
        <header class="side-header">
          <h1 class="title">Loading…</h1>
        </header>
        <div class="side-content"></div>
      </div>
    `;
  }

  private attachEventListeners() {
    // Back button — return to the lobby list without leaving the lobby.
    // Mask flow keeps running in the background if kicked off; next re-entry
    // will pick it up from the idempotent short-circuit in applyMyMask.
    document.getElementById('back-btn')?.addEventListener('click', () => {
      this.dispatchEvent('navigate', { screen: 'lobby-list' });
    });

    // Retry mask — only visible when myMaskPhase === 'failed'.
    document.getElementById('retry-mask-btn')?.addEventListener('click', () => {
      if (this.myMaskPhase !== 'failed') return;
      this.myMaskPhase = 'idle';
      this.lastRenderSig = ''; // force re-render
      void this.tick();
    });

    // Cancel Lobby — host only, mask done, alone.
    document.getElementById('cancel-lobby-btn')?.addEventListener('click', async () => {
      if (this.cancelPending) return;
      this.cancelPending = true;

      const btn = document.getElementById('cancel-lobby-btn') as HTMLButtonElement;
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Cancelling…';
      }

      try {
        const ok = await this.gameService.closeLobby(this.lobbyId);
        if (ok) {
          this.dispatchEvent('navigate', { screen: 'lobby-list' });
        } else {
          soundManager.playError();
          alert('Failed to cancel the lobby. It may already have a second player.');
          if (btn) {
            btn.disabled = false;
            btn.textContent = 'Cancel Lobby';
          }
          this.cancelPending = false;
        }
      } catch (err) {
        console.error('[LobbyScreen] Error cancelling lobby:', err);
        soundManager.playError();
        alert('Failed to cancel the lobby. Please try again.');
        if (btn) {
          btn.disabled = false;
          btn.textContent = 'Cancel Lobby';
        }
        this.cancelPending = false;
      }
    });
  }

  private dispatchEvent(type: string, detail: any) {
    this.container.dispatchEvent(new CustomEvent(type, { detail, bubbles: true }));
  }
}

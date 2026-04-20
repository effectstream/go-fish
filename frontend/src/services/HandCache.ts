/**
 * Lightweight localStorage cache for per-game sidebar data.
 *
 * Writers: every live {@link GameSession} pushes its latest snapshot (hand,
 * score, names, phase, inFlight, turn) after each adapter poll. Writes are
 * cheap (small JSON) and synchronous.
 *
 * Readers: the Active Games sidebar reads this cache directly instead of
 * querying the contract per game. Keeps the sidebar render free of
 * indexer/contract calls — especially important with multiple concurrent
 * games, where polling every card would flood the network.
 *
 * The cache is best-effort: stale entries are benign (just show the last
 * known state); missing entries fall back to the `findResumableGames`
 * chain snapshot + a mock mini-hand preview.
 */
import type { Card } from '../../../packages/shared/data-types/src/go-fish-types';
import type { InFlightState } from '../game/types';

// Bumped from v1 → v2 when the schema expanded beyond just the hand.
// Old entries under the v1 key are simply ignored and will be rewritten
// by the first poll of each live session.
const KEY_PREFIX = 'gofish_game_v2_';

export interface CachedGame {
  /** Lobby id (redundant with the key, handy for consumers iterating). */
  lobbyId: string;
  /** Which player the cache owner is (1 or 2). */
  playerId: 1 | 2;
  /** Display label for the game card. */
  lobbyName: string;
  /** Opponent's display name (from /lobby_state, best-effort). */
  opponentName: string;
  /** Hand seen on-chain at `updatedAt`. Capped to full hand (4–21 cards). */
  cards: Card[];
  /** Book count for this player. */
  myScore: number;
  /** Book count for the opponent. */
  opponentScore: number;
  /** True when `currentTurn === playerId` in the last observed state. */
  isMyTurn: boolean;
  /** Numeric phase (0=dealing … 6=game_over). Mirrors the sidebar's
   *  pill-selection logic without needing a string-map. */
  phase: number;
  /** Local in-flight state from the session (proving/sending/waiting/null). */
  inFlight: InFlightState;
  /** ms-since-epoch when the writer last refreshed this entry. */
  updatedAt: number;
}

function keyFor(lobbyId: string): string {
  return `${KEY_PREFIX}${lobbyId}`;
}

/**
 * Persist the latest sidebar snapshot for a game. Called from
 * {@link GameSession} on every poll. Intentionally no-op on errors
 * (quota, private mode) — the cache is a nicety, not required for
 * correctness.
 */
export function setCachedGame(entry: CachedGame): void {
  try {
    localStorage.setItem(keyFor(entry.lobbyId), JSON.stringify(entry));
  } catch {
    // Ignore — storage pressure / private mode / blocked.
  }
}

/**
 * Read the latest cached sidebar snapshot for a game, or null if none is
 * stored or the entry is malformed.
 */
export function getCachedGame(lobbyId: string): CachedGame | null {
  try {
    const raw = localStorage.getItem(keyFor(lobbyId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedGame;
    if (
      !parsed ||
      typeof parsed.lobbyId !== 'string' ||
      (parsed.playerId !== 1 && parsed.playerId !== 2) ||
      !Array.isArray(parsed.cards) ||
      typeof parsed.updatedAt !== 'number'
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Drop the cached entry for a game. Called on session destroy. */
export function clearCachedGame(lobbyId: string): void {
  try {
    localStorage.removeItem(keyFor(lobbyId));
  } catch {
    // ignore
  }
}

/** Return every cached sidebar entry currently in storage, keyed by
 *  lobbyId. Used by the sidebar on its initial render (before any
 *  session events have fired) so a fresh page shows known games right
 *  away. */
export function listCachedGames(): Map<string, CachedGame> {
  const out = new Map<string, CachedGame>();
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(KEY_PREFIX)) continue;
      const lobbyId = k.slice(KEY_PREFIX.length);
      const entry = getCachedGame(lobbyId);
      if (entry) out.set(lobbyId, entry);
    }
  } catch {
    // ignore
  }
  return out;
}

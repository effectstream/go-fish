/**
 * Per-lobby persistent game log, backed by localStorage.
 *
 * The canvas Game Log (rendered by GameHUD) is the only consumer. All writes
 * go through {@link appendEntry} / {@link replaceLastIfSource}, and reads
 * always pull the live array from storage so a fresh tab on the same lobby
 * picks up the existing history immediately.
 *
 * Best-effort: storage failures (quota, private mode) degrade silently —
 * the log is a UX nicety, not required for correctness.
 */

const KEY_PREFIX = 'gofish_game_log_v1_';

export type GameLogSource = 'status' | 'action' | 'response' | 'system';

export interface GameLogEntry {
  /** ms-since-epoch when the entry was created. Formatted at render time. */
  time: number;
  /** Human-readable text (no timestamp prefix). */
  message: string;
  /** Origin tag — drives dedupe (status replacement) and future styling. */
  source: GameLogSource;
}

function keyFor(lobbyId: string): string {
  return `${KEY_PREFIX}${lobbyId}`;
}

function isEntry(v: unknown): v is GameLogEntry {
  if (!v || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.time === 'number' &&
    typeof e.message === 'string' &&
    typeof e.source === 'string'
  );
}

export function loadEntries(lobbyId: string): GameLogEntry[] {
  try {
    const raw = localStorage.getItem(keyFor(lobbyId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isEntry);
  } catch {
    return [];
  }
}

function saveEntries(lobbyId: string, entries: GameLogEntry[]): void {
  try {
    localStorage.setItem(keyFor(lobbyId), JSON.stringify(entries));
  } catch {
    // Ignore — quota / private mode / blocked.
  }
}

/** Append `entry` and trim to the most recent `cap` items. Returns the new array. */
export function appendEntry(
  lobbyId: string,
  entry: GameLogEntry,
  cap: number,
): GameLogEntry[] {
  const entries = loadEntries(lobbyId);
  entries.push(entry);
  if (entries.length > cap) entries.splice(0, entries.length - cap);
  saveEntries(lobbyId, entries);
  return entries;
}

/**
 * If the most recent entry has the given `source`, overwrite it with `entry`
 * (preserving log length). Otherwise append. Used by the phase status line so
 * "Waiting for X..." doesn't spam new rows on every poll.
 */
export function replaceLastIfSource(
  lobbyId: string,
  source: GameLogSource,
  entry: GameLogEntry,
  cap: number,
): GameLogEntry[] {
  const entries = loadEntries(lobbyId);
  if (entries.length > 0 && entries[entries.length - 1].source === source) {
    entries[entries.length - 1] = entry;
  } else {
    entries.push(entry);
    if (entries.length > cap) entries.splice(0, entries.length - cap);
  }
  saveEntries(lobbyId, entries);
  return entries;
}

export function clearEntries(lobbyId: string): void {
  try {
    localStorage.removeItem(keyFor(lobbyId));
  } catch {
    // ignore
  }
}

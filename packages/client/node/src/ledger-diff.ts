/**
 * Ledger diff printer — compares each new Midnight ledger snapshot against the
 * previous one and logs just the changed entries. Module-level state keeps the
 * last snapshot so consecutive `event_midnight` blocks can be compared.
 *
 * No DB writes — this is purely observational for now.
 */

export type Diff =
  | { path: string; op: "add"; new: unknown }
  | { path: string; op: "remove"; old: unknown }
  | { path: string; op: "change"; old: unknown; new: unknown };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Recursively diff two ledger subtrees. Arrays and scalars compare via JSON equality. */
function diffLedger(prev: unknown, curr: unknown, path = ""): Diff[] {
  if (isPlainObject(prev) && isPlainObject(curr)) {
    const diffs: Diff[] = [];
    const keys = new Set<string>([...Object.keys(prev), ...Object.keys(curr)]);
    for (const k of keys) {
      const childPath = path ? `${path}.${k}` : k;
      if (!(k in prev)) {
        diffs.push({ path: childPath, op: "add", new: curr[k] });
      } else if (!(k in curr)) {
        diffs.push({ path: childPath, op: "remove", old: prev[k] });
      } else {
        diffs.push(...diffLedger(prev[k], curr[k], childPath));
      }
    }
    return diffs;
  }

  if (JSON.stringify(prev) !== JSON.stringify(curr)) {
    return [{ path, op: "change", old: prev, new: curr }];
  }
  return [];
}

function fmt(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (typeof v === "object") {
    const s = JSON.stringify(v);
    return s.length > 800 ? s.slice(0, 800) + `…(${s.length}B)` : s;
  }
  return String(v);
}

let lastSnapshot: Record<string, unknown> = {};
let firstBlockSeen = false;

/** Compute diffs against the previous snapshot and advance the baseline.
 *  On the first call, diff is taken against `{}` so all present entries show as adds.
 *  Returns the diff list so callers can both log AND project into tables. */
export function computeLedgerDiff(payload: Record<string, unknown>): {
  diffs: Diff[];
  isInitial: boolean;
} {
  const isInitial = !firstBlockSeen;
  const diffs = diffLedger(lastSnapshot, payload);
  firstBlockSeen = true;
  lastSnapshot = payload;
  return { diffs, isInitial };
}

/** Print diffs for a block. */
export function logLedgerDiff(diffs: Diff[], isInitial: boolean, blockHeight: number): void {
  const label = isInitial ? "📷 [MIDNIGHT INITIAL]" : "📝 [MIDNIGHT DIFF]";

  if (diffs.length === 0) {
    console.log(`✓ [MIDNIGHT] block=${blockHeight} no changes`);
    return;
  }

  console.log(`${label} block=${blockHeight} (${diffs.length} change${diffs.length === 1 ? "" : "s"}):`);
  for (const d of diffs) {
    if (d.op === "add") console.log(`  + ${d.path} = ${fmt(d.new)}`);
    else if (d.op === "remove") console.log(`  - ${d.path}  (was ${fmt(d.old)})`);
    else console.log(`  ~ ${d.path}: ${fmt(d.old)} → ${fmt(d.new)}`);
  }
}

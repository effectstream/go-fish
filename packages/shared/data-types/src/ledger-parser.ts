/**
 * Go Fish ledger parser — materializes the compiled contract's live ledger()
 * accessors into plain JSON-safe objects.
 *
 * Why this exists: the compiled `ledger()` returns an object whose map fields
 * expose `isEmpty/size/member/lookup/[Symbol.iterator]` as function properties.
 * The framework JSON-roundtrips the parser's output before it reaches the
 * event_midnight STF, and JSON.stringify drops functions — so maps serialize
 * as `{}`. We eagerly iterate each map (via Symbol.iterator) here, before the
 * roundtrip, so real entries survive.
 */

import * as GoFishContract from "@go-fish/midnight-contract/contract";

function hexOf(u: Uint8Array): string {
  return "0x" + Array.from(u).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** If a Bytes<N> value is printable ASCII (optionally zero-padded), return the string. */
function tryDecodeAscii(u: Uint8Array): string | null {
  let end = u.length;
  while (end > 0 && u[end - 1] === 0) end--;
  if (end === 0) return null;
  for (let i = 0; i < end; i++) {
    const b = u[i];
    if (b < 0x20 || b > 0x7e) return null;
  }
  return new TextDecoder().decode(u.subarray(0, end));
}

function keyToString(k: unknown): string {
  if (k instanceof Uint8Array) return tryDecodeAscii(k) ?? hexOf(k);
  if (typeof k === "bigint") return k.toString();
  if (k !== null && typeof k === "object") {
    // Struct key (e.g. JubjubPoint {x, y}) — JSON with bigint→string.
    return JSON.stringify(k, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  }
  return String(k);
}

function valueToJSON(v: any): any {
  if (v == null) return v;
  if (v instanceof Uint8Array) return hexOf(v);
  if (typeof v === "bigint") {
    return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString();
  }
  if (typeof v !== "object") return v;
  if (Symbol.iterator in v) {
    const out: Record<string, any> = {};
    for (const [k, val] of v as Iterable<[unknown, unknown]>) {
      out[keyToString(k)] = valueToJSON(val);
    }
    return out;
  }
  const out: Record<string, any> = {};
  for (const [k, val] of Object.entries(v)) out[k] = valueToJSON(val);
  return out;
}

// deno-lint-ignore no-explicit-any
export function parseGoFishLedger(state: any): Record<string, any> {
  const live = GoFishContract.ledger(state);
  const out: Record<string, any> = {};
  for (const key of Object.keys(live)) {
    out[key] = valueToJSON((live as any)[key]);
  }
  return out;
}

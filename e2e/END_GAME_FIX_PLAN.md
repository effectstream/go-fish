# End-Game Stall Fix — Plan

**Scope:** Resolve `BACKEND_ISSUES.md` #3 (game stalls in `TurnStart`
with an empty hand) and #4 (`winner` ledger never written when the
game stalls). #4 is a symptom of #3.

**Status:** Design — not implemented.

---

## 1. What we observed

Three e2e runs, all hitting the same exit path in `_helpers.ts:918`
(`endReason: "empty hand"`). `winner` was never set in any run.

| Run | Turns | Scores | Hands | Books |
|-----|-------|--------|-------|-------|
| 1   | 18    | 6 – 0  | 0, 2  | 6 / 7 |
| 2   | 15    | 0 – 5  | 3, 0  | 5 / 7 |
| 3   | 13    | 2 – 2  | 4, 0  | 4 / 7 |

## 2. Root cause

Two gaps combine into a dead end:

1. **`askForCard` rejects you with 0 cards.** Rule 5
   (`game.compact:315`) requires `currentCount > 0` for the asked
   rank, so any player whose hand reaches 0 can't call `askForCard`
   for *anything*.
2. **There is no standalone "go fish" circuit.** The deck draw lives
   inside `respondToAsk`'s go-fish branch (`game.compact:393-407`),
   which is only reachable *after* a successful `askForCard`. Grep
   confirms no exported `goFish` / `drawCard` path.

Combine: empty hand → can't ask → can't reach the draw → stuck. Real
Go Fish has a "draw from deck when empty" exception; the contract
doesn't.

Separately, `addScore` (`GoFish.compact:152`) only transitions to
`GameOver` at 7 total books — so runs 1 and 2 (decided at book 4) ran
past their mathematical end and stalled on an empty hand.

## 3. Fix — two Compact diffs

### 3.1 Early-win at ≥ 4 books — `GoFish.compact:addScore`

**Replaces** the existing `books + 1 == 7` end-game block (lines
151-167). By pigeonhole, `totalBooks == 7` implies `max(s1,s2) ≥ 4`,
so the new check fires strictly earlier — keeping the old cap is
dead code. No tie branch: by induction, when this check fires, the
other player is strictly `< 4`.

```compact
// Replaces the full body of addScore. Reads pre-increment values
// ONCE, computes locally, writes ONCE. Never re-reads the ledger
// after an insert (Compact's queryLedgerState returns the post-write
// value, which caused a double-count in the original code).
const prevS1 = scoreP1.lookup(gid) as Uint<8>;
const prevS2 = scoreP2.lookup(gid) as Uint<8>;
const newS1: Uint<8> = (disclosed_playerId == 1 as Uint<64>)
    ? (prevS1 + 1 as Uint<8>) as Uint<8> : prevS1;
const newS2: Uint<8> = (disclosed_playerId == 2 as Uint<64>)
    ? (prevS2 + 1 as Uint<8>) as Uint<8> : prevS2;

if (disclosed_playerId == 1 as Uint<64>) {
    scoreP1.insert(gid, newS1);
} else if (disclosed_playerId == 2 as Uint<64>) {
    scoreP2.insert(gid, newS2);
}
const books = totalBooks.lookup(gid) as Uint<8>;
totalBooks.insert(gid, (books + 1 as Uint<8>) as Uint<8>);

if (newS1 >= 4 as Uint<8>) {
    phase.insert(gid, GamePhase.GameOver);
    winner.insert(gid, 1 as Uint<64>);
} else if (newS2 >= 4 as Uint<8>) {
    phase.insert(gid, GamePhase.GameOver);
    winner.insert(gid, 2 as Uint<64>);
}
```

**Compact read-after-write pitfall:** `queryLedgerState` mutates the
circuit context in place, so `lookup` after `insert` on the same
ledger returns the post-write value. The original code used `lookup →
insert → lookup → +1` which double-counted (confirmed: game was
ending at 3 books instead of 4). Audit found no other same-ledger
read-after-write patterns in `GoFish.compact`, `game.compact`,
`Hand.compact`, or `Deck.compact`.

**ec_mul safety:** scalar reads and phase/winner writes only. Safe.

### 3.2 Empty-hand exception in rule 5 — `game.compact:askForCard`

Let a player with an empty hand ask for *any* rank. This routes the
turn through `respondToAsk`'s existing go-fish branch — no new
circuit, no new signing convention. Matches the real Go Fish rule
("draw from deck when empty").

```compact
// game.compact, inside askForCard. REPLACE line 315:
//     assert(currentCount > 0 as Uint<8>, "Cannot ask for a rank you don't have in your hand");
// with:

// RULE 5: Must hold ≥ 1 card of the asked rank — EXCEPT when the hand is
// empty. An empty-hand ask is the real-Go-Fish "draw from deck" move and
// flows through respondToAsk's existing go-fish branch.
const askerHandSize = hand_getHandSize(gid, askingPlayerId);
if (askerHandSize > 0 as Uint<64>) {
    assert(currentCount > 0 as Uint<8>, "Cannot ask for a rank you don't have in your hand");
}
```

**ec_mul safety:** `countCardsOfRank_withSecrets` (which contains the
ec_mul) still runs unconditionally above this block. The new `if`
only wraps the `assert`, which has no ec_mul. Safe.

**Why rule 5 still exists for non-empty hands:** a non-empty player
asking for a rank they don't hold would leak nothing useful and waste
a turn — keep the assert for correctness on normal moves.

## 4. Client changes — `e2e/smoke/_helpers.ts`

1. **Drop the empty-hand bail** (`_helpers.ts:918-929`). With rule 5
   relaxed, an empty-handed `askForCard` is legal — let it flow
   through `playOneTurn` normally.
2. **Pick a rank when the hand is empty.** `handRanks(handBefore)[0]`
   (`_helpers.ts:932`) throws on an empty array. Replace with
   `handRanks(handBefore)[0] ?? 0` (or any constant 0-6) — the
   contract no longer cares whether the asker holds the rank.
3. **Promote the final-state assertion** in `e2e/game-round.test.ts`:
   assert `result.finalPhase === PHASE.GameOver` and
   `result.winner !== null && result.winner !== 0`. With the early-win
   rule, ties are unreachable (§3.1 induction argument).

No other helper changes. `checkAndEndGame` stays in the contract as a
safety net but the client never needs to call it — every finished
game exits via early-win.

## 5. Managed contract regeneration

`packages/shared/contracts/midnight/go-fish-contract/src/managed/**`
is auto-generated and currently stale (missing V4's `winner` /
`getWinner`). Run `deno task build:midnight` twice: once **before**
the edits (clean baseline), and once **after** (verify the `addScore`
diff and the relaxed assert appear in the generated output).

Then run the ec_mul guard detection script from
`ZKIR-EC-MUL-GUARD-BUG.md`. Expected: 0 violations.

## 6. Validation

1. **Contract test suite** — `deno task --filter
   @go-fish/midnight-contract test`. Existing 164 tests should still
   pass.
2. **New contract test — early-win at 4.** Seed a game to 3 – 0,
   score P1's 4th book, assert `phase == GameOver && winner == 1 &&
   totalBooks == 4`.
3. **New contract test — empty-hand ask.** Seed P1 with 0 cards and a
   non-empty deck, call `askForCard(gid, 1, 0, now)`, then
   `respondToAsk(gid, 2, now)`. Assert phase transitions correctly
   through the go-fish branch and P1's hand size ends ≥ 1.
4. **`deno task test`** — state-machine tests; should be unaffected.
5. **`deno task test:e2e`** — run `game-round.test.ts` at least 3
   times. Expected: `finalPhase == GameOver`, `winner ∈ {1, 2}`,
   `divergences == 0`, `exitReason` showing early-win.

## 7. Rollout

1. Regenerate managed contract on current sources (baseline commit).
2. Apply §3.1 diff to `GoFish.compact`.
3. Apply §3.2 diff to `game.compact`.
4. Regenerate managed contract (second commit — makes the diff
   obvious).
5. Apply §4 client changes.
6. Run validation (§6). Close `BACKEND_ISSUES.md` #3 and #4.

**Risk:** low. Both diffs are localized edits inside existing
circuits; no new circuits, no new signing conventions, no new ZKIR
surfaces.

## 8. Open questions

1. **Does `askForCard`'s timestamp / `assertCallerIsPlayer` path
   depend on any side-channel that assumes `currentCount > 0`?** A
   quick grep shows no — the check is self-contained. Verify
   during implementation.
2. **Should `autoScoreBooks` also run for the *non-asking* player
   after each turn?** Tangential to this fix, but with relaxed rule
   5 the non-active player may accumulate 3 of a rank via transfer
   and not get scored until their own next turn. Not a correctness
   issue (they'll still score eventually), but worth a follow-up.

## 9. Summary

- **Contract fix A** — `GoFish.compact:addScore`: replace the 7-book
  cap with an early-win at score ≥ 4. Writes `winner`.
- **Contract fix B** — `game.compact:askForCard`: skip rule 5 when
  the asker's hand is empty. Routes empty-hand turns through
  `respondToAsk`'s existing go-fish branch — no new circuit.
- **Client fix** — `_helpers.ts`: drop the empty-hand bail and
  tolerate `handRanks([])` when picking a rank.
- Issue #4 (`winner` never set) resolves automatically once every
  game ends via early-win.

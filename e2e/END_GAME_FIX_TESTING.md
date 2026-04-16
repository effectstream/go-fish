# End-Game Fix — Testing Handoff

**Context:** Two Compact diffs + a managed-contract regen resolved
`BACKEND_ISSUES.md` #3 (game stalls in `TurnStart` with empty hand)
and #4 (`winner` ledger never written). Full design rationale lives
in `e2e/END_GAME_FIX_PLAN.md`. The implementation is complete and all
162 pre-existing contract tests still pass; your job is to add
coverage for the new behavior and run e2e validation.

---

## What changed in the contract

1. **Early-win at ≥ 4 books** — `GoFish.compact:addScore` now
   transitions to `GameOver` and writes `winner` the moment either
   score reaches 4. Replaces the old `books + 1 == 7` cap. By
   pigeonhole, book 7 is now unreachable; every game ends at
   totalBooks ∈ {4, 5, 6}.
   - `winner == 0` (tie) is **unreachable** via the early-win path by
     induction — the other player is always strictly `< 4` when the
     check fires. Only the legacy `endGame` fallback can ever write
     `winner == 0`.

2. **Empty-hand asks are legal** — `game.compact:askForCard` rule 5
   (`assert(currentCount > 0, ...)`) is now wrapped in
   `if (hand_getHandSize(gid, disclosed_playerId) > 0 as Uint<64>)`.
   With an empty hand, the asker may request *any* rank; the flow
   continues through `respondToAsk`'s existing three branches:
   - **Transfer:** opponent had cards of rank → move them to the
     asker's hand → phase → `TurnStart`.
   - **Go fish:** opponent had none, deck non-empty → draw 1 for
     asker → phase → `WaitForDrawCheck` → `afterGoFish`.
   - **Switch:** opponent had none, deck empty → `switchTurn` to
     opponent.

3. **`getWinner` exposed at top level** — new wrapper in
   `game.compact` delegating to `go_fish_getWinner`. Managed contract
   now has 31 circuits (was 30). Before this, `getWinner` was only in
   the `GoFish` module and didn't appear in
   `managed/contract/index.d.ts`, which is why the e2e test was
   always reading it as `__missing`.

4. **Nothing else changed** — `respondToAsk`, `afterGoFish`,
   `checkAndScoreBook`, `switchTurn`, `claimTimeoutWin`,
   `checkAndEndGame` are all untouched.

## What changed in the e2e harness

- `e2e/smoke/_helpers.ts:playOneTurn` — the empty-hand bail at the
  top of the function is gone. When `handBefore.length === 0` the
  helper now picks rank 0 and calls `askForCard` normally, relying
  on the contract's new rule-5 exception. Logs a distinct message
  for the empty-hand path.
- `e2e/game-round.test.ts` — added two hard assertions at the end of
  the test body:
  - `result.finalPhase === PHASE.GameOver` (throws on regression)
  - `result.winner === 1 || result.winner === 2`
    (throws on `null`, `0`, or anything else)

## Contract tests to add

Add to `packages/shared/contracts/midnight/example.test.ts` (same
file as the existing 162 tests). Tag each with a new `N`-series ID
or similar.

1. **Early-win at exactly 4.** Seed scoreP1 = 3, P2 = 0 via repeated
   `checkAndScoreBook` calls. Score P1's 4th book. Assert:
   - `getGamePhase(gid) == GamePhase.GameOver` (6)
   - `getWinner(gid) == 1`
   - `totalBooks == 4`
   - Follow-up `askForCard`, `switchTurn`, `checkAndScoreBook`
     calls all fail with the existing "game over" guards.

2. **Early-win on the trailing side.** Mirror of (1): P2 scores the
   4th book first. Assert `winner == 2`.

3. **Early-win at 4-2 and 4-3.** Mid-game states where the winner's
   score reaches 4 while the opponent holds 2 or 3. Verify the rule
   fires regardless of opponent score.

4. **Guard against off-by-one.** Seed a 3 – X state and verify the
   game is *not* over — the rule must not fire below 4.

5. **Empty-hand ask — transfer branch.** Seed asker's hand to 0,
   opponent holds ≥ 1 card of rank R. Call
   `askForCard(gid, asker, R, now)` then
   `respondToAsk(gid, opponent, now)`. Assert:
   - Both calls succeed (no rule-5 assertion failure).
   - Asker's hand size increases by exactly the count of R the
     opponent held.
   - Phase transitions to `TurnStart`.

6. **Empty-hand ask — go-fish branch.** Asker hand = 0, opponent has
   0 of the asked rank, deck ≥ 1 card. Assert:
   - Phase transitions to `WaitForDrawCheck` after `respondToAsk`.
   - `afterGoFish` succeeds and transitions out of
     `WaitForDrawCheck`.
   - Asker's hand size == 1 at the end.

7. **Empty-hand ask — switch-turn branch.** Asker hand = 0,
   opponent has 0, deck empty. Assert:
   - `currentTurn` switches to opponent.
   - Phase is `TurnStart`.
   - Asker's hand is still 0.

8. **Rule 5 still enforced for non-empty hands.** Asker has exactly
   1 card (rank X). Call `askForCard` for rank Y ≠ X. Assert it
   fails with `"Cannot ask for a rank you don't have in your hand"`.

9. **`getWinner` pre-game-over.** Immediately after `init_game` or
   `applyMask`, call `getWinner(gid)`. Assert `== 0` (no winner
   recorded).

10. **`getWinner` post-game-over.** Full game → early-win. Assert
    `getWinner` returns `1` or `2` matching the `winner` ledger
    entry and consistent with the final score comparison.

11. **No off-by-one on early-win (regression for read-after-write
    double-count bug).** Seed scoreP1 = 3, totalBooks = 3, scoreP2 =
    0. Call `checkAndScoreBook` to score P1's 4th book. Re-read
    `getScores` — must be `[4, 0]`, NOT `[3, 0]` (which would mean
    game-over fired before the 4th write via the old double-count).
    Assert `getGamePhase == GameOver`, `getWinner == 1`,
    `totalBooks == 4`. This is the regression test for the Compact
    `queryLedgerState` read-after-write pitfall.

## e2e validation

Run the full stack and execute `game-round.test.ts` ≥ 3 times to
sample across shuffle nondeterminism.

**Green run looks like:**

```
exitReason:   phase → GameOver
finalPhase:   6 (GameOver=6)
winner:       1   (or 2; never null and never 0)
divergences:  0
```

**Red flags (regressions):**

- `exitReason: "empty hand"` — rule 5 still blocking. Verify
  `disclosed_playerId` is being passed to `hand_getHandSize`.
- `exitReason: "MAX_TURNS (20) reached"` — the loop isn't
  progressing. Likely the empty-hand path returned without
  advancing state. Check the logs for repeated `(empty)` hands.
- `winner: null` — `getWinner` isn't exposed at the top level (or
  the managed contract wasn't regenerated). Run
  `deno task build:midnight` and check `index.d.ts` for the
  `getWinner` entry.
- `winner: 0` — the early-win path produced a tie, which should be
  mathematically impossible. Inspect `finalS1` / `finalS2`
  computation in `addScore`.
- The helper's `sum >= 7` break in `runFullGame` (`_helpers.ts:1131`)
  firing — also should be unreachable. If it fires, the contract's
  majority rule isn't ending games.

## Commands

```bash
# Contract simulation suite (expect 162/162)
cd packages/shared/contracts/midnight && deno task test

# Node API suite (expect 27/27)
deno task test

# Rebuild managed contract from .compact sources
deno task build:midnight

# ec_mul guard bug detection (expect zero output)
cd packages/shared/contracts/midnight/go-fish-contract && \
for zkir in src/managed/zkir/*.zkir; do
  ec_muls=$(grep -c "ec_mul" "$zkir")
  guarded=$(grep -c 'public_input { guard: [^n]' "$zkir")
  if [ "$ec_muls" -gt 0 ] && [ "$guarded" -gt 0 ]; then
    echo "UNSAFE: $(basename "$zkir")"
  fi
done

# Full e2e (requires Hardhat :8545, Paima :9996, batcher :3336,
# Midnight node+indexer :8088, proof server :6300, deployed contract)
deno task test:e2e
```

## Gotchas

1. **Managed contract is regenerated.** `managed/**` diffs are
   large and auto-generated. Don't hand-edit; `deno task
   build:midnight` to reproduce.

2. **Witness-disclosure rule.** The first build failed because
   `hand_getHandSize(gid, askingPlayerId)` leaked the witness. Fix
   was to pass `disclosed_playerId` instead. If you add new Hand
   circuit calls with variable player IDs, use the disclosed form.

3. **Existing test `N5 game ends at 7 books`** now reports "game
   over with 5 books (ended via addScore)" and passes. The test's
   assertion was flexible enough to accept the new behavior. Leave
   it alone — or rename to `game ends at early-win threshold`.

4. **`BACKEND_ISSUES.md` #1 is NOT fixed.** The default witness
   module still has the `Math.random()` fallback bug. The e2e test
   sidesteps it via `e2e/smoke/test-witnesses.ts`. Don't regress to
   the default witnesses.

5. **Frontend is out of scope.** No changes to `frontend/`. A
   follow-up ticket should track: (a) reading `getWinner` on the
   GameOver screen, (b) wiring the empty-hand UI to the relaxed
   rule-5 ask path. Not your problem for this PR.

6. **`checkAndEndGame` is now dead code in the happy path.** It's
   still present and still works, but the client never needs to
   call it — every game ends via early-win. Keep it as a safety
   net for the pathological 3-3 edge case (which only matters if
   the 4+ rule is ever disabled).

7. **Compact read-after-write pitfall.** `queryLedgerState` mutates
   the circuit context in place — a `lookup` after an `insert` on
   the same ledger returns the post-write value, not a snapshot.
   The original `addScore` had `lookup → insert → lookup → +1`
   which double-counted. If you add new contract logic that reads
   a ledger after writing to it in the same circuit, compute the
   value locally instead. Audit confirmed no other same-ledger
   read-after-write patterns exist in the current codebase.

## Files of interest

- `e2e/END_GAME_FIX_PLAN.md` — design rationale, coverage table,
  edge cases.
- `e2e/BACKEND_ISSUES.md` — issues #3 and #4 can move to "Resolved"
  once you've confirmed the e2e runs are green.
- `packages/shared/contracts/midnight/go-fish-contract/src/GoFish.compact`
  — the `addScore` diff.
- `packages/shared/contracts/midnight/go-fish-contract/src/game.compact`
  — the `askForCard` rule-5 relaxation + the new top-level
  `getWinner` wrapper.
- `packages/shared/contracts/midnight/go-fish-contract/src/managed/contract/index.d.ts`
  — verify `getWinner` appears in `ImpureCircuits`,
  `ProvableCircuits`, and `Circuits`.

## Done means

- [ ] 11 new contract tests added and passing (list above).
- [ ] E2E run 3×, all green on the new assertions.
- [ ] `BACKEND_ISSUES.md` #3 and #4 moved to "Resolved".
- [ ] ec_mul guard script reports zero violations.

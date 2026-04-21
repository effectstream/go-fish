# FEATURES_PLAN

Two workstreams:

- **Part A — Forfeit / Leave Game / Claim Timeout Win** (§1–§7). Contract is done;
  frontend wiring + UI.
- **Part B — UI polish** (§8–§14). Canvas animation, loader messaging, mini-card
  correctness, setup-phase log quality.

---

# PART A — Forfeit, Leave Game, Claim Timeout Win

Owner: frontend + paima-node integration. Contract side is already implemented in
`packages/shared/contracts/midnight/go-fish-contract/src/game.compact`. No
`.compact` changes are required.

---

## 1. User-facing actions

Two user-facing player actions. `cleanupGame` is run by the backend — NOT
surfaced in the UI and NOT wired through the frontend service layers.

| UI action                    | Where                                   | Trigger / gating                                       | Contract call                              | Result                                                 |
|------------------------------|-----------------------------------------|--------------------------------------------------------|--------------------------------------------|--------------------------------------------------------|
| **Concede** / **Close Game** | 3-dots `⋮` menu, top-right of canvas    | Any phase ≠ `GameOver`                                 | `concede(gameId, playerId, now)`           | Phase → GameOver. Winner = opponent (active game) or 0 / draw (Setup). |
| **Claim Win (Timeout)**      | Inline near countdown pill, opponent's turn | `now ≥ lastMoveAt + 605s` (5s client-side buffer over the 600s contract check) | `claimTimeoutWin(gameId, claimingPlayerId)` | Phase → GameOver, winner = caller                      |

**Copy rules for the 3-dots menu** — label is phase-dependent:

| Game phase                         | Menu label    | Confirm modal copy                                        | Winner result |
|------------------------------------|---------------|-----------------------------------------------------------|---------------|
| `Setup` (pre-deal, incl. stranded) | **Close Game**| "Close this game? Both players will be marked a draw."    | 0 (draw)      |
| `TurnStart` / `WaitFor*`           | **Concede**   | "Concede this game? Your opponent wins."                  | opponent      |
| `GameOver`                         | *(menu hidden — nothing to do)*                                                           | n/a           |

The 3-dots menu is the single entry point so we don't pile more buttons onto
the active-game HUD. Claim Win stays outside the menu — it's a time-critical
primary action that should be surfaced right next to the countdown.

**Cleanup (backend-only)**: when the Paima node observes `phase == GameOver`
for a game, it calls `cleanupGame` as the owner (callerPlayerId=0) to drop
per-game ledger state. The frontend does not need to know this happened.

---

## 2. What already exists (do not duplicate)

### 2.1 Compact contract (complete — no work needed)

| Circuit                                       | File : line                                                       |
|-----------------------------------------------|-------------------------------------------------------------------|
| `concede(gameId, playerId, now)`              | `packages/shared/contracts/midnight/go-fish-contract/src/game.compact:~1302` — Setup → draw, active → opponent wins, GameOver → rejects |
| `claimTimeoutWin(gameId, claimingPlayerId)`   | `…/game.compact:~1262` — requires `now ≥ lastMoveAt + 600s` (no `now` param; anchored on `blockTime` only) |
| `checkAndEndGame(gameId)` (stalemate)         | `…/game.compact:1095`                                             |
| `cleanupGame(gameId, callerPlayerId)`         | `…/game.compact:1369`                                             |
| `getLastMoveAt(gameId)` / `getTurnTimeout()`  | `…/GoFish.compact:617` / `:625`                                   |
| `endGameWithWinner` / `endGame`               | `…/GoFish.compact:428` / `:413`                                   |
| `assertNowWithinWindow(now)` helper           | `…/game.compact:~96–103` — `blockTime - 240s ≤ now ≤ blockTime + 120s` |

**Contract constants (updated 2026-04-21):**
- `TURN_TIMEOUT = 600s` (10 minutes). Exposed via `getTurnTimeout()` at `GoFish.compact:625`. Doubled from 300s so a user can reasonably take the full turn without a partner jumping to claim.
- **Client timestamp (`now`) drift window**: every player-initiated circuit that takes a `now` parameter (`askForCard`, `respondToAsk`, `afterGoFish`, `requestToDrawCard`, `drawCard`, `skipTurn`, `scoreInitialBooks`, `concede`) enforces `blockTime - 240s ≤ now ≤ blockTime + 120s` via `assertNowWithinWindow`. Client may send a `now` up to 4 min in the past or 2 min in the future relative to block time. `claimTimeoutWin` takes no `now` — it reads `lastMoveAt` and `blockTime` directly.

### 2.2 Frontend (partial)

Already wired:
- `claimTimeoutWin` — `frontend/src/services/MidnightService.ts:398`, `MidnightOnChainService.ts:1301`, `GoFishContractService.ts:1165`, `zk-time-estimator.ts:36`. **No UI callsite yet.**
- `checkAndEndGame` — same three files; plus `GameSession.ts:1225` auto-fires on deck-empty + hand-empty.
- Re-export audit — `e2e/smoke/contract-config.test.ts:66` expects `concede` to be present.
- Contract reads go direct from the frontend via `GoFishContractService` / `MidnightService.getGameState` (seen in runtime logs: `[MidnightService] getGameState: contract phase=1 turn=1 hands=4,4 scores=0,0`). No backend proxying. `getWinner`/`getLastMoveAt` follow the same pattern — no new plumbing needed, just add query wrappers.

Not wired (work to do):
- `concede` — no service methods, no bridge wrapper, no UI, no estimator entry.
- `lastMoveAt` / `getTurnTimeout` — not fetched in any poll; frontend cannot render a countdown.
- `getWinner` — not queried; GameOver panel currently infers winner from `scores >= 4` which breaks for concede (scores stay 0).

Out of frontend scope:
- `cleanupGame` — the Paima node calls it as owner after observing `GameOver`. Not surfaced to the user; no service wiring needed.

---

## 3. Implementation plan

### Phase 1 — Wire `concede` + winner / lastMoveAt queries through the service layers

Mirror the existing `claimTimeoutWin` wiring end-to-end. Also add two pure-read
helpers (`getWinner`, `getLastMoveAt`) so the UI phases don't need backend
changes — reads come straight from the contract as every other game-state read
already does.

- **`frontend/src/zk-time-estimator.ts`** — add `concede: 10` (alongside `claimTimeoutWin: 10`). K-cost is comparable: small ledger writes + one `endGameWithWinner`.
- **`frontend/src/midnightBridge.ts`** — add `concede()` local-simulation wrapper mirroring `checkAndEndGame` at `:637`. Needed for the TypeScript-contract dev mode (`USE_TYPESCRIPT_CONTRACT=true`).
- **`frontend/src/services/GoFishContractService.ts`** — add `concede` to the circuit label map (~`:269`) and add a `callDelegated` wrapper (~`:1165` pattern) that calls `contract.callTx.concede(gameId, playerId, nowSecs)`. Add pure-read helpers for `getWinner` and `getLastMoveAt` (no proof — mirror how `getGameState` is implemented).
- **`frontend/src/services/MidnightOnChainService.ts`** — add `onChainConcede(lobbyId, playerId)` modelled on `onChainClaimTimeoutWin` (`:1301–1320`). Add `onChainGetWinner(lobbyId)` and `onChainGetLastMoveAt(lobbyId)`. Export alongside the other re-exports near `:1368`.
- **`frontend/src/services/BatcherMidnightService.ts`** — add a batcher-mode dispatch stub for concede (current comment at `:5` states most moves are delegated to `GoFishContractService`; follow that pattern). Reads are always direct to the contract, no batcher path.
- **`frontend/src/services/MidnightService.ts`** — add top-level routers for `concede`, `getWinner`, `getLastMoveAt` (~`:398` pattern) and re-exports near `:789`.

Signatures (TS):

```ts
export async function concede(
  lobbyId: string,
  playerId: number,
): Promise<MidnightResult>;

export async function getWinner(lobbyId: string): Promise<0 | 1 | 2>;

export async function getLastMoveAt(lobbyId: string): Promise<number>;
```

`now` parameter inside concede: derive as `Math.floor(Date.now() / 1000)`.
Contract validates via `assertNowWithinWindow`: `blockTime - 240s ≤ now ≤
blockTime + 120s`, so 4 min past / 2 min future client drift is tolerated.

**Cleanup is out of scope** for this PR and the plan generally — the Paima
node handles `cleanupGame` as owner once it observes a `GameOver` transition.
No frontend service wiring.

### Phase 2 — UI: 3-dots `⋮` menu with Concede / Close Game

Single new UI surface: a discrete 3-dots icon at the **top-right of the game
canvas** that opens a small popover listing destructive / rare actions. Keeps
the HUD clean — no new inline button cluster.

Location: `frontend/src/three/ui/GameHUD.ts` (or a sibling module if the
existing file is getting large). Absolute-positioned at `top: 8px; right: 8px`,
inside the canvas HUD layer so it stays visible over the 3D scene.

Visual:
- Default: a small rounded-rect button `⋮` with subtle hover highlight.
- Click → slide-down popover (~180px wide) anchored below the icon.
- Popover items: phase-dependent label (see table in §1):
  - Setup → **Close Game**
  - Active game → **Concede**
  - GameOver → menu hidden / icon not rendered
- Click outside the popover dismisses it.
- Popover item carries `.tx-guarded` so PR B7's tx-in-flight lock disables it
  during an active proof/send.

Confirmation modal (reused pattern from the existing create-lobby modal):
- Setup: "Close this game? Both players will be marked a draw." — `[Close game]` / `[Cancel]`.
- Active: "Concede this game? Your opponent wins." — `[Concede]` / `[Cancel]`.
- Single confirm click. No "type FORFEIT" escalation in v1.

Flow on confirm:
1. Close the popover + modal.
2. Call `MidnightService.concede(lobbyId, playerId)`.
3. Show a brief waiting banner ("Submitting concede…") — re-use the existing
   `showBanner` mechanism in `GameSession`.
4. Let the game-state poller pick up `phase == GameOver` and flip to the
   `renderGameOverPanel()`. Do not navigate away; the user should see the
   result screen.

**GameOver screen update**: `renderGameOverPanel` currently infers the
outcome from `scores >= 4`. That breaks for concede (scores stay 0-0) and for
Setup-concede (scores always 0-0, result must be a draw). Switch to reading
`winner` from the contract:

```ts
const winner = await MidnightService.getWinner(lobbyId);
if (winner === 0)               render "🤝 It's a Draw";
else if (winner === myPlayerId) render "🎉 You Won!";
else                            render "😔 You Lost";
```

### Phase 3 — UI: Countdown + Claim Win

Goal: show each player "N seconds until opponent times out" on the opponent's
turn, unlock the **Claim Win** button at the 10-min mark.

Data source: the Phase 1 query helpers (`getLastMoveAt`, `getTurnTimeout`).
Frontend queries the contract directly — same pattern as every other game-
state read; no backend change.

- Extend the game-state poller (`frontend/src/game/GameStateAdapter.ts` /
  `GameSession.ts`) to read `getLastMoveAt(gameId)` each tick and cache
  `turnTimeout = 600` (constant).
- Surface `lastMoveAt` on the session snapshot.

UI:
- When it's NOT my turn, render a small pill near the HUD turn bar:
  `⏳ Opponent times out in M:SS` counting down from **10:00**.
- When the countdown reaches 0, swap the pill into a **Claim Win** button.
- When it IS my turn, render nothing (can't claim against myself).
- The `Claim Win` button confirms once (same pattern as Concede), then calls
  `MidnightService.claimTimeoutWin(lobbyId, playerId)`. No `now` parameter —
  the circuit reads `blockTime` directly. Button is `.tx-guarded`.

**Clock-skew buffer**: the contract compares `blockTime >= lastMoveAt + 600`.
Enable the UI button at `lastMoveAt + 605s` (5s buffer) to avoid a click that
deterministically reverts with "Timeout period has not elapsed yet".

**Countdown text cadence:**
- `> 60s` remaining → `M:SS` (e.g., `9:42`, `2:15`).
- `≤ 60s` remaining → one-decimal-second: `12.4s`, `3.2s`.
- Tick the DOM at 200ms. Poll `lastMoveAt` once per 5–10s (cheap query, but
  not free); interpolate between polls using `Date.now()` offsets so the
  countdown reads smoothly.

### Phase 4 — Leaderboard observability (deferred)

Nothing in `packages/client/node/src/` currently observes Midnight `GameOver`
events or distinguishes end-reason. Leaderboard schema in
`packages/client/database/` has `games_won` but no "forfeit"/"timeout"/"draw"
columns.

Minimum work if we want analytics: extend the Paima node's Midnight watcher to
read `winner` and infer end-reason from the last-move sequence, plus new
columns for forfeits / timeouts / draws.

**Recommendation:** defer. Only matters if product asks for these metrics.
Out of scope for v1.

> **Cleanup is owned by the Paima node**, not the frontend. When the node
> observes a game flipping to `GameOver`, it calls `cleanupGame(gameId, 0)`
> as owner, which drops the per-game ledger state. No frontend-side cleanup
> hook, no user-visible cleanup button, no participant-side cleanup.

---

## 4. Testing plan

### 4.1 Contract smoke tests (`packages/shared/contracts/midnight/example.test.ts`)

Mirror the existing `claimTimeoutWin` negative tests at `:2595–2646`:

- `concede` non-existent game → reverts "Game does not exist"
- `concede` during Setup → **accepts**; `getWinner() == 0` (draw); `phase == GameOver`.
- `concede` after GameOver → reverts "Game is already over"
- `concede` as non-registered caller → reverts (verifyCallerIsPlayer)
- `concede` with invalid `playerId` (3) → reverts "Invalid player index"
- `concede` with `now` outside `[blockTime-240, blockTime+120]` → reverts "Claimed timestamp outside allowed window" (assertNowWithinWindow)
- `concede` happy path active game: P1 concedes mid-turn → `getWinner() == 2`, `phase == GameOver`
- `concede` happy path Setup: P1 concedes before deal → `getWinner() == 0`, `phase == GameOver`

Already covered by the `e2e/smoke/contract-config.test.ts:66` re-export check.

### 4.2 E2E (`e2e/smoke/_helpers.ts`)

Add helpers:
- `runConcede(session, gameId, playerId)` — modelled on `runSkipTurn` / `runCleanupGame` (`:807`).
- `runClaimTimeoutWin(session, gameId, claimingPlayerId)` — same shape.

Add smoke scenarios:
- P1 plays 2 turns, then P2 concedes → game ends, `winner == 1`.
- Setup-concede: P1 creates + P2 joins, P2 applies mask, P1 concedes before dealing → game ends, `winner == 0` (draw).
- P1 stalls; test harness fast-forwards block time past `lastMoveAt + 600`; P2 claims timeout → `winner == 2`.
- Backend `cleanupGame` path is covered separately by whichever node-side test suite owns the Midnight observer — not part of this feature's frontend tests.

### 4.3 Frontend

- Unit: service-layer routing (on-chain vs. backend vs. batcher) for `concede` and the two read helpers.
- Component: 3-dots menu shows "Concede" mid-game, "Close Game" during Setup, hidden during GameOver; countdown pill appears on opponent's turn; Claim Win disabled until `lastMoveAt + 605s`.
- Manual:
  1. Start a game, open 3-dots → "Concede" → confirm → observe GameOver with opponent marked winner.
  2. Setup-concede: create a lobby, before P2 fully joins open 3-dots → "Close Game" → confirm → observe GameOver with draw screen.
  3. Start a game, don't move for 10:05 → the other client's countdown pill unlocks into "Claim Win"; click it → GameOver, claimer marked winner.
  4. 3-dots menu dims / blocks with toast while a tx is in flight (PR B7 `.tx-guarded` integration).

---

## 5. Edge cases and risks

| # | Case                                                                 | Handling                                                                                          |
|---|----------------------------------------------------------------------|---------------------------------------------------------------------------------------------------|
| 1 | Both players concede concurrently                                    | Whichever lands first wins the revert race; second `concede` reverts with "Game is already over". UI should re-read state on error and show game over. |
| 2 | Concede tx in-flight while opponent's book-scoring tx lands → GameOver | Same: concede will revert "Game is already over". Show "Game ended while your move was pending." |
| 3 | Claim Timeout during an active proof generation on opponent side     | Contract is authoritative — if proof lands and updates `lastMoveAt` before block time reaches `lastMoveAt + 600`, claim reverts. UI already re-polls; just surface the revert message. |
| 4 | Stranded Setup game (partner never applied mask)                     | **Resolved by contract update (2026-04-21).** `concede` now accepts during Setup and resolves to a draw (winner=0). Participant can concede out cleanly and call `cleanupGame` once phase flips to GameOver. No admin-only path needed. |
| 5 | User closes tab mid-forfeit                                          | Proof may still be submitted from a previously-spawned worker, or not. On reconnect, re-read `phase` — if GameOver, show result; if still active, show Forfeit button again. |
| 6 | Block-time clock skew (Midnight block lag)                           | `claimTimeoutWin` button gating uses `lastMoveAt + 605` (5s buffer). Still revert-safe. Client `now` has 4-min past + 2-min future tolerance for player-initiated circuits. |
| 7 | `cleanupGame` race                                                   | **Backend-owned.** Frontend doesn't call cleanupGame. Paima node handles race/idempotency server-side. |
| 8 | Multi-concurrent-games (MULTI_GAME_CONCURRENCY.md)                   | Forfeit / Claim are scoped to the foreground game only; background sessions' pills belong in the sidebar. Out of scope — reuse same service calls keyed by `lobbyId`. |

---

## 6. Delivery order (suggested PR split)

Three PRs. Cleanup is backend-only and isn't tracked here.

1. **PR A1 — Service plumbing** (no-op behaviourally):
   - `zk-time-estimator.ts` + `midnightBridge.ts` + service layer for `concede` plus pure-read helpers for `getWinner` and `getLastMoveAt`.
   - Smoke tests for `concede` in `example.test.ts`.
   - No UI. Green tests.
2. **PR A2 — 3-dots menu + Concede / Close Game**:
   - `⋮` icon top-right of the canvas HUD; popover with phase-dependent label.
   - Confirm modal (active vs Setup copy).
   - `renderGameOverPanel` rewired to read `winner` from the contract (so draws render as "🤝 It's a Draw").
   - Manual QA scenarios 1 + 2.
3. **PR A3 — Countdown + Claim Timeout Win**:
   - Adapter polls `lastMoveAt`; session surfaces it.
   - Countdown pill + Claim Win button with 5s buffer gating at `+605s`.
   - Manual QA scenario 3.

4. **(Deferred) PR A4 — Leaderboard end-reason tracking.**

---

## 7. Open questions

- **Double-confirm forfeit?** Single confirm vs. "type FORFEIT" modal. Default: single confirm; escalate only if users report accidental clicks.
- **Timeout buffer value.** 5s buffer (`+605s`) is a guess. If we see revert-on-click in QA, bump to 10s.
- **3-dots menu placement on mobile / narrow viewports.** Top-right of the canvas may crowd the existing wallet / sound controls on small screens. Verify in manual QA; worst case, move to top-left.
- **Leaderboard end-reason.** Is "forfeits given" / "timeouts won" / "draws" player-facing metric valuable enough to add a column? Default: no, until product asks.

> ~~Stranded Setup path~~ — **resolved 2026-04-21.** Contract now accepts `concede` during Setup and resolves to a draw. No admin tooling needed.

---
---

# PART B — UI Polish

Seven improvements to the in-game UX. All frontend-only. Grouped by subsystem so
each section can ship as its own small PR.

## 8. Scope summary

| # | Area                                    | Symptom today                                                | Target state                                                                     |
|---|-----------------------------------------|--------------------------------------------------------------|----------------------------------------------------------------------------------|
| 1 | Card leaving hand (card lost)           | Card vanishes instantly with no tween                        | Card tweens out of hand along a visible trajectory (~0.8–1.0s) before despawning |
| 2 | Mini-cards in HUD / menu                | Always rendered as face-down placeholders, even when unknown | If hand state is unknown/partial, render NOTHING (no placeholder backs)          |
| 3 | Canvas HUD empty state                  | Score + log panels render blank until data loads             | Dark backing box paints first; "Loading…" text inside until data arrives         |
| 4 | Section titles (Your Books, etc.)       | Titles show with empty/0 values before data loads            | Titles show alongside "Loading…" when value is unknown; never "0" as a fallback  |
| 5 | ZK loader overtime message              | `+N.Ns` counter after estimate, no explanatory text          | At `+2.0s` overtime, show "Taking more than expected, please wait…" subtitle     |
| 6 | Shuffle animation during Setup          | Static spinner while proof runs (up to ~60s on slow HW)      | Cards visually shuffle on the canvas with multiple animation variants cycling    |
| 7 | Setup-phase log quality                 | Several setup actions are silent; no "waiting for opponent"  | Every setup step logged; explicit "Waiting for opponent to X" when blocked       |
| 8 | Tx-in-flight interaction lock           | User can click Create/Join/back buttons mid-proof and trigger a second tx that races or errors | While loader is in `proving` or `sending`, game-mutation UI is disabled; click on a locked control shows a toast "Blockchain operation in progress — please wait" |
| 9 | Menu selection highlight + top-bar name | No visual indicator which game in the menu is the currently-viewed one; player's own name not shown in the in-game top bar | Golden border on the active/selected game card in the lobby list; player name rendered in the turn-bar left slot |

---

## 9. Card-leaving animation (§8.1)

**Current:** `frontend/src/three/objects/CardHand.ts:29–37` (`setCards`) nukes old cards and instantiates new ones. `frontend/src/three/scenes/GameScene.ts:284` applies `setPlayerHand(state.myHand)`. A comment at `GameScene.ts:656–658` already flags: "cards are already removed from the hand by setCards, so we can't animate the removed Card3D objects."

**Infrastructure already present:** `frontend/src/three/animations/CardAnimations.ts:112–130` has `animateTransfer()` — 0.7s position tween with `power2.inOut`. Reusable.

**Plan:**
1. In `CardHand.setCards(newCards)`, diff against the previous `cards` array. For each card in the old set not in the new set, do NOT dispose immediately — capture its mesh, start a leave tween (see 9.1 below), and dispose in the tween's `onComplete`.
2. Add `CardAnimations.animateCardLeave(card3d, destination, duration)`:
   - Duration: **900ms** (configurable constant). Rationale: fast animations (≤500ms) are what users report as "just disappears". 800–1200ms is the sweet spot for "I saw that happen".
   - Trajectory: arc up + forward toward the opponent zone when a card is transferred (ask-with-hit), or arc up + fade when it's a book being claimed. Use `THREE.QuadraticBezierCurve3` with control point above the hand midpoint.
   - Easing: `power2.out` (fast start, gentle landing).
   - Fade: lerp material opacity to 0 in the last 30% of the tween.
3. **Input lock during animation.** Block further ask/respond clicks while any card-leave tween is active (existing `inFlight` flag in GameSession likely covers this; verify).
4. **Variants** — two distinct leave behaviours (pick by caller, pass as `kind` arg):
   - `transfer` (ask-with-hit): arc toward opponent's hand mini area.
   - `book` (card goes to scored pile): arc up + drop toward book zone, small spin.

**Acceptance:** manual — ask and hit; visually confirm the card travels across the board for ~0.9s before disappearing.

**Files touched:**
- `frontend/src/three/objects/CardHand.ts` (diff on setCards)
- `frontend/src/three/animations/CardAnimations.ts` (new `animateCardLeave`)
- `frontend/src/three/scenes/GameScene.ts:~284` (pass animation intent)

---

## 10. Mini-card correctness (§8.2)

**Current:** `frontend/src/screens/GameScreen.ts:626` and `:1488–1495` both render opponent mini-cards as `CardComponent.renderCardBack()` × `handSize`. This fires even when `gameState` is fresh or opponent hand is not yet populated — users see face-down placeholders that don't correspond to a real hand.

**Rule:** The mini-cards rail MUST be a faithful projection of the true game state. If the count is unknown, render nothing.

**Plan:**
1. Extract the mini-card rail into a single helper `renderOpponentMiniCards(count: number | null)`:
   - `count === null` or `count === undefined` → return `''` (empty string, not a placeholder).
   - `count === 0` → return empty (no mini rail needed).
   - `count > 0` → render `count` backs, capped at 10 with `+N` overflow (existing behaviour).
2. Callers pass `state?.opponentHandSize ?? null` instead of a computed/defaulted number.
3. Remove any hardcoded placeholder counts (e.g., pre-deal "4 cards" assumptions). Before `dealCards` completes, opponent hand size is genuinely unknown → render nothing.
4. Same treatment for any OTHER mini-rail (our own hand mini, book piles): if the data source is null, render nothing, not zeros.

**Acceptance:** load into a game mid-setup where opponent hand size isn't yet fetched; verify no face-down backs appear until the first real game-state tick.

**Files touched:**
- `frontend/src/screens/GameScreen.ts` (both `:626` and `:1488–1495` callsites)

---

## 11. Canvas HUD empty-box + Loading… (§8.3 + §8.4)

**Current:**
- Score panel: `frontend/src/three/ui/GameHUD.ts:298–315` (`updateScorePanel`) renders unconditionally; if values are undefined, text is blank/`0`.
- Log panel: `frontend/src/three/ui/GameHUD.ts:374–393` (`updateLogPanel`) — renders empty if no log yet.
- Initial load path: `frontend/src/screens/GameScreen.ts:138–155` — if `gameState` is null, shows error, not a loading skeleton.

**Plan — empty-box first:**
1. HUD panels always paint their backing box in the base CSS (pattern already used at GameHUD.ts:111–112 with `backdrop-filter` and rgba bg). Ensure the backing `<div>` renders at mount, independent of data. No-op if already the case for the outer container; the fix is to stop short-circuiting the whole panel when data is null.
2. Inside each panel, instead of returning empty when data is null:
   - Score panel → render title + `<span class="loading-placeholder">Loading…</span>` per metric.
   - Log panel → render title + `<div class="loading-placeholder">Loading…</div>` single row.
3. Add a `.loading-placeholder` CSS class: muted colour, faint shimmer (CSS keyframe `@keyframes shimmer`) so it's clearly a loading state, not a real value.

**Plan — titles never show without a value:**
1. Every labelled metric ("Your Books", "Opponent Books", "Deck", "Hand") renders as:
   - Title: always.
   - Value: real number if present; otherwise `Loading…`.
2. **Never** show a numeric fallback (`0`, `-`, `—`) when the truth is "we don't know yet". `0` is a valid game state and must only appear when confirmed.
3. Distinguish `null/undefined` (unknown) from `0` (known zero) at the call site. If the gameState has a nullable shape, propagate nullability into the panel props.

**Acceptance:**
- Reload mid-game: before the first indexer poll settles, the HUD shows dark boxes with titles and "Loading…" text, not blank and not `0`.
- On slow network, the loading state persists visibly (not a flash) until data arrives.

**Files touched:**
- `frontend/src/three/ui/GameHUD.ts:298–315, 374–393`
- `frontend/src/style.css` (or nearest HUD stylesheet) — add `.loading-placeholder`.

---

## 12. ZK loader "Taking more than expected" subtitle (§8.5)

**Current:** `frontend/src/three/ui/GlobalLoader.ts:138–145` (`formatCountdown`) returns `Xs`; `:325` prepends `+` once `remaining < 0`. Existing CSS `.gl-countdown-over` at `:110–112` tints the counter orange when overtime.

**Plan:**
1. Add a sibling DOM element `.gl-overtime-hint` under the countdown, empty by default, populated only when overtime exceeds the hint threshold.
2. Threshold constant: `OVERTIME_HINT_AFTER_MS = 2000`. Rationale: user asked for "+2.0s". Don't fire at `+0.1s` — tiny overages are common and noise.
3. In the same render tick that prepends `+`, check `overBy >= 2000` → set hint text: `"Taking more than expected, please wait…"`.
4. When the loader resets for a new proof, clear the hint element.
5. CSS: smaller font than the counter, same orange tint, 150ms fade-in so it doesn't pop.
6. **Stretch:** at `+10s`, change the hint to `"Still working — slow machines can take up to a minute for this step."` to reassure users during the worst-case `dealCards` proof.

**Acceptance:** artificially delay a proof (dev-mode throttle); observe the hint appearing at +2.0s, not before.

**Files touched:**
- `frontend/src/three/ui/GlobalLoader.ts:~325`
- loader CSS (same file or linked stylesheet) — new `.gl-overtime-hint` rule.

---

## 13. Shuffle animation during Setup (§8.6)

**Current:** `frontend/src/screens/GameScreen.ts:948–987` (`renderSetupPhase`) shows a static spinner + status text. Proof cost: `dealCards` is k=15 (~25.7s reference, up to ~60s on slow hardware per `zk-time-estimator.ts:37`). `applyMask` adds another proof. Combined Setup wait on a slow machine can exceed 60s of dead UI.

**Goal:** keep the 3D canvas alive with a continuous, visually varied shuffle animation so users see the app is working.

**Plan:**
1. New module `frontend/src/three/animations/ShuffleAnimations.ts` with an orchestrator:
   - `startShuffleLoop(scene, deckGroup): StopFn`
   - Picks an animation variant every `~4–6s` and chains them. When the Setup flow completes, `stopFn()` halts the chain and transitions to the dealt-hand layout.
2. **Variants (at least 5, picked pseudo-random non-repeating):**
   - **Riffle:** split deck in half, interleave with alternating lift + drop.
   - **Overhand shuffle:** lift top ~1/3, drop back on top from a raised position.
   - **Cascade/waterfall:** cards arc from one hand position to another in a bow.
   - **Table spread:** fan out face-down in an arc, sweep back into a stack.
   - **Hindu shuffle:** successive small clumps pulled off the bottom and dropped on top.
   - **(Bonus) Card flourish:** brief spin of the whole deck + single card twirl, for visual variety between heavier variants.
3. Each variant is self-contained: takes the deckGroup, returns a Promise that resolves when the animation ends + the deck is visually back to a neutral stack. Orchestrator awaits, then picks the next variant. Shuffle bag ensures no variant repeats twice in a row.
4. **Performance:**
   - Use a small pool (21 cards = one full deck mesh set) — no new allocations per tick.
   - Target 60fps on a modern laptop; degrade gracefully on slow HW (per-frame dt clamp).
   - All variants must be idempotent w.r.t. ending state (deck is a neat stack) so switching between them doesn't leave stragglers.
5. **Wire-up in `GameSession.setupDealCards()` (GameSession.ts:716–811) + `applyMyMask` (SetupFlow.ts:25–74):**
   - Start the shuffle loop on entering Setup.
   - Stop the loop + run a final "deal out" animation when dealCards tx lands.
6. **Fallback:** if `reduced-motion` media query is set, use a single slow cascade with no variant swapping, to respect accessibility.

**Acceptance:**
- Start a fresh game on a throttled CPU; shuffle plays uninterrupted for the full duration.
- Visual variety: three distinct variants observed within the first 30s.
- When deal completes, animation ends cleanly and cards fly to hands (no flicker or snap).

**Files touched:**
- `frontend/src/three/animations/ShuffleAnimations.ts` (new)
- `frontend/src/game/SetupFlow.ts` or `frontend/src/game/GameSession.ts` (start/stop hooks)
- `frontend/src/three/scenes/GameScene.ts` (expose deckGroup handle)
- `frontend/src/screens/GameScreen.ts:948–987` (let canvas stay visible during Setup instead of showing only a spinner; keep a small inline status line for "Applying mask…" etc.)

---

## 14. Setup-phase log quality (§8.7)

**Current audit (from survey):**
- `frontend/src/game/GameSession.ts:706–709` — `addLog('🔐 Applying mask — proving…')`, `addLog('🔐 Mask applied')`. OK.
- `:730` — `notify('Waiting for opponent…')` but NO corresponding `addLog()` — so the canvas log stays silent while waiting.
- Deal / scoreInitialBooks / startGame paths at `:754–876` — mix of notify-only and addLog; some steps missing entirely.
- Frontend action log: `GameScreen.ts:73–83` (`actionLog`) + render at `:1564–1591`.

**Plan:**
1. **Every setup-phase action logs exactly once** via `addLog()`. Inventory:
   - `applyMask` start: "🔐 Applying your mask — proving locally…"
   - `applyMask` success: "🔐 Your mask applied."
   - Waiting on opponent mask: "⏳ Waiting for opponent to apply their mask…" (fired once when we finish ours but opponent hasn't)
   - `dealCards` start: "🎴 Dealing cards — this can take up to a minute…"
   - `dealCards` success: "🎴 Cards dealt."
   - Waiting on opponent deal: "⏳ Waiting for opponent to deal…"
   - `scoreInitialBooks` start / success
   - `startGame` transition to TurnStart: "▶️ Game started. P1 to ask first."
   - Any retry / failure: surface the short reason (not the stack).
2. **"Waiting for opponent to X" pattern.** Introduce a small helper `logWaitingFor(action: string)`:
   - Deduplicates: only logs the first time per waiting window (don't spam every poll tick).
   - Resets on state transition.
   - Used at every point where our local state is ready but the contract is blocked on the other player: applyMask, dealCards, respond-to-ask (if not already logged), concede (opponent hasn't acknowledged end).
3. **Keep notify() as a transient toast**; addLog is the durable canvas record. Every setup addLog should also get a notify for the toast UX.
4. **Audit pass:** walk GameSession.ts `:700–880` line by line, ensure every branch that advances setup state either calls addLog or is explicitly covered by a higher-level addLog. No silent state changes.

**Acceptance:**
- Play through setup on two clients. Each client's canvas log shows a continuous narrative from "applying mask" → "waiting for opponent" → "dealing" → "waiting for opponent" → "game started".
- Nothing silent for more than ~3s while state is in fact changing in the background.
- No duplicated "waiting for opponent" entries within the same waiting window.

**Files touched:**
- `frontend/src/game/GameSession.ts:700–880`
- `frontend/src/game/SetupFlow.ts:25–74`
- `frontend/src/game/GameStateAdapter.ts:~201` (if logWaitingFor lives there)

---

## 15. Delivery order (Part B)

Each PR is independent.

1. **PR B1 — HUD empty-box + Loading…** (§11, §8.3+§8.4). Lowest risk; biggest perceived polish win. Pure CSS + null-handling.
2. **PR B2 — Loader overtime hint** (§12, §8.5). ~20 lines + CSS.
3. **PR B3 — Mini-card correctness** (§10, §8.2). Single file, obvious diff.
4. **PR B4 — Setup log quality** (§14, §8.7). Audit-driven; touches one file primarily.
5. **PR B5 — Card-leaving animation** (§9, §8.1). Needs diffing old/new hand; most intricate of the HTML/canvas changes.
6. **PR B6 — Shuffle animation** (§13, §8.6). Largest; new module + 5+ animation variants + GameSession wiring. Ship last.
7. **PR B7 — Tx-in-flight interaction lock** (§17, §8.8). Small central state lookup + guarded click handlers on create/join flows. Defensive, ship early-to-mid.
8. **PR B8 — Menu selection highlight + top-bar name** (§18, §8.9). CSS-only highlight for the active lobby card + a left-aligned name slot in the in-game turn bar. Tiny, ship whenever.

---

## 16. Part B — Open questions

- **Exact card-leave duration.** 900ms proposed; A/B with 700ms and 1200ms if time permits.
- **Shuffle variant count at launch.** 5 is the minimum for perceived variety. Are we OK shipping with 3 if schedule is tight? (Recommend: no — 3 variants will loop visibly within 60s.)
- **Log persistence across page reloads.** Today's action log is in-memory only. Out of scope for Part B, but flag it: a reload during Setup will wipe the narrative. Consider adding a ring-buffer-backed `sessionStorage` log store in a follow-up.
- **Reduced-motion scope.** Do we also disable the card-leave tween under `prefers-reduced-motion`? Recommend: shorten (300ms fade, no arc) rather than skip entirely — the user still needs to see the card was lost.

---

## 17. Tx-in-flight interaction lock (§8.8)

**Problem:** While a proof is generating or a tx is in flight, the user can
click "Create Lobby", "Join Lobby", "Back to Lobby List", or other game-mutation
buttons. Any of these either:
- starts a second on-chain operation that races the first,
- navigates away mid-submit and orphans the pending tx (user sees no outcome),
- or triggers a concurrent-game state error we have no graceful recovery for.

**Current state:**
- The blocking condition is already tracked centrally: `GlobalLoader.foreground`
  is non-null with `state ∈ {'proving', 'sending'}` during a tx.
  (`'waiting'` is passive — waiting for opponent — and must NOT block the user.)
- Individual screens don't consult it. Buttons remain clickable, handlers run, tx happens.

**Design:**

### 17.1 Central "is-busy" state

Add to `frontend/src/three/ui/GlobalLoader.ts`:

```ts
/** True when a tx is in flight (proving or sending). `waiting` is excluded —
 *  that's a passive state and doesn't block user action. */
isTxInFlight(): boolean {
  const s = this.foreground?.state;
  return s === 'proving' || s === 'sending';
}

/** Subscribe to tx-in-flight transitions. Fires immediately with current value. */
onTxInFlightChange(cb: (busy: boolean) => void): () => void { … }
```

Implementation: track the last-emitted value; call subscribers inside `render()`
after computing the new foreground intent. Return an unsubscribe.

### 17.2 Guard helper

New tiny module `frontend/src/utils/txGuard.ts`:

```ts
import { globalLoader } from '../three/ui/GlobalLoader';
import { toast } from '../components/Toast'; // or the equivalent

export function ensureNotBusy(): boolean {
  if (!globalLoader.isTxInFlight()) return true;
  toast('Blockchain operation in progress — please wait.');
  return false;
}

export function guardedClick(handler: () => void | Promise<void>): () => void {
  return () => { if (ensureNotBusy()) handler(); };
}
```

No existing toast module? Use the existing `GameHUD.showNotification()` pattern
or the loader's own DOM node for a brief flash. Pick the one already in use on
the lobby screens to stay consistent.

### 17.3 Call sites to guard

Walk each screen and wrap the handlers that create or join a tx:

| File                                                   | Control                             | Handler to guard                  |
|--------------------------------------------------------|-------------------------------------|-----------------------------------|
| `frontend/src/screens/LobbyListScreen.ts`              | "Create Lobby" button               | create-lobby submit               |
| `frontend/src/screens/LobbyListScreen.ts`              | "Join" row action                   | join-lobby submit                 |
| `frontend/src/screens/LobbyListScreen.ts`              | "Close Lobby" (host only)           | closedLobby submit                |
| `frontend/src/screens/LobbyScreen.ts`                  | "Leave Lobby" / equivalent          | leave                             |
| `frontend/src/screens/NameEntryScreen.ts`              | "Submit" / "Continue"               | name submit                       |
| `frontend/src/screens/GameScreen.ts`                   | "Back to Lobby List" (game-over)    | navigation                        |
| `frontend/src/screens/GameScreen.ts`                   | Forfeit button (from Part A §9.3)   | concede submit                    |
| `frontend/src/screens/GameScreen.ts`                   | Claim Win button (Part A §13)       | claimTimeoutWin submit            |

**Not** guarded (passive or safe to interrupt):
- Volume / mute controls.
- Opening the side panel / active games list.
- In-game card hover / tooltip behaviour.
- Cancel buttons on modals we want the user to be able to back out of.

### 17.4 Visual disable state

A toast-only approach lets the user keep clicking and getting nagged. Also
dim / disable the buttons while busy so the state is discoverable:

1. Add a body-level class toggler subscribed to `onTxInFlightChange`:
   - `document.body.classList.toggle('tx-in-flight', busy)`.
2. CSS rule in `style.css`:
   ```css
   body.tx-in-flight .tx-guarded {
     opacity: 0.55;
     cursor: not-allowed;
     filter: saturate(0.7);
   }
   ```
3. Mark each guarded button with `.tx-guarded` class.
4. Click handler still fires (CSS `pointer-events` stays on) so the toast can
   surface the explanation — disabling the button outright would leave the user
   wondering why nothing happens.

### 17.5 Edge cases

- **Tx finishes while toast is on-screen.** Fine — toast auto-dismisses; button enables. Don't need to race-cancel.
- **Proving fails / is cancelled.** `GlobalLoader.hide()` flips `isTxInFlight` to false; body class clears; buttons re-enable.
- **User closes tab mid-proof.** Out of scope — browser-level; nothing to do.
- **Background sessions (MULTI_GAME_CONCURRENCY).** Muted loader (`setMuted(true)`) also mutes `isTxInFlight`? **Decision needed:** if a BACKGROUND session is proving, should that block the foreground user from creating a NEW game? Recommend: yes — `isTxInFlight` should reflect tx state regardless of mute. Mute only affects rendering, not the flag. Verify in implementation.
- **Idempotent guards.** A user who double-clicks right as a proof starts: the second click fires AFTER `isTxInFlight` flips true → guarded → toast. No stale first handler fires.
- **Game-internal clicks (ask-a-card, respond).** Already serialised via existing `inFlight` flag in GameSession. Don't double-guard; leave those paths alone.

### 17.6 Testing

Manual:
1. Start creating a lobby → while proof is running, click "Create Lobby" again → toast shows, no second tx fires.
2. During a dealCards proof (~30s window), click "Back to Lobby" → toast shows, navigation blocked.
3. Let proof finish → same buttons re-enable, clicks work.
4. Verify mute state (background session): switch to menu while a game session is proving → `isTxInFlight` still true → create-lobby still blocked. (Confirm this is desired behaviour with product before shipping.)

Automated:
- Unit: `GlobalLoader.isTxInFlight()` returns correct values across state transitions.
- Integration (Playwright or similar, if available): trigger a mock proof and assert button disabled state + toast appearance.

### 17.7 Files touched

- `frontend/src/three/ui/GlobalLoader.ts` — add `isTxInFlight`, `onTxInFlightChange`.
- `frontend/src/utils/txGuard.ts` (new) — helper functions.
- `frontend/src/style.css` — `.tx-guarded` disabled-look rules.
- `frontend/src/screens/LobbyListScreen.ts`, `LobbyScreen.ts`, `NameEntryScreen.ts`, `GameScreen.ts` — wrap handlers + add `.tx-guarded` class.
- Wherever the app bootstraps (`frontend/src/main.ts` or similar) — subscribe `onTxInFlightChange` → body class toggler.

### 17.8 Open question

- **Block the "Back to Lobby" during a proof only, or also during `sending`?** `sending` can be ~5–10s; blocking the user from exiting might feel heavy. Recommend: block both, but add a secondary "Cancel & discard" escape hatch later if feedback asks for it.

---

## 18. Menu selection highlight + top-bar name (§8.9)

Two small visual fixes grouped into one PR.

### 18.1 Golden border on the active lobby card

**Problem:** When the user has multiple games in the Active Games list and one is
currently the foreground session, nothing visually marks it. The user has to
remember which game they just left from.

**Plan:**
1. Determine the foreground lobby id. `SceneManager` (or whichever module owns
   the foreground session) already tracks this — the lobby list already
   suppresses the "Resume" button on the foreground card at `LobbyListScreen.ts:374`
   via `isForeground`. Reuse that signal.
2. Add a `.active` class to `.lobby-card` when `isForeground === true`:
   ```ts
   <div class="lobby-card resume-card ${isForeground ? 'active' : ''}" …>
   ```
3. CSS in `index.html` or `style.css`:
   ```css
   .lobby-card.active {
     border: 2px solid #ffaa00;          /* game's golden accent */
     box-shadow: 0 0 0 4px rgba(255, 170, 0, 0.18), 0 4px 14px rgba(0,0,0,0.4);
   }
   ```
4. Pick whichever gold tone already exists in the design system — `#ffaa00` is
   used in the HUD (`GameHUD.ts:103, 115, …`). Reuse it for consistency.
5. **Also selected but not foreground?** If the lobby list supports a
   keyboard-selected state (arrow keys / tab focus), use a lighter treatment
   (1px border, no glow) so focus ≠ foreground visually.

**Files touched:**
- `frontend/src/screens/LobbyListScreen.ts` (1 class toggle)
- `frontend/index.html` or `frontend/src/style.css` (CSS rule)

### 18.2 Player name in the top-left bar

**Problem:** The in-game turn bar (center-aligned) shows "Your Turn" /
"Opponent's Turn" + a phase description, but the player's OWN name is absent.
Users who manage multiple sessions can't tell at a glance which account/game
they're viewing.

**Plan:**
1. In `frontend/src/three/ui/GameHUD.ts`, restructure the turn bar into a
   three-slot layout: `[name] [center turn status] [phase right slot]`.
   - Left slot: player's display name (from `HUDState.playerName`).
   - Center: existing "Your Turn" / "Opponent's Turn" text (unchanged).
   - Right: existing phase description (unchanged).
2. Use CSS grid or flex `justify-content: space-between` on the turn bar,
   absolute-positioning the text within so the center stays centered.
3. While loading (before first `update()`), the placeholder already shows
   "Loading…" in the turn bar from PR B1. Add a matching left-slot placeholder
   so the layout doesn't shift when real data arrives:
   ```
   [Loading…]   [Loading…]    (nothing right)
   ```
4. Truncate long names: `max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;`.

**Files touched:**
- `frontend/src/three/ui/GameHUD.ts` — `turnBar` element structure + `updateTurnBar` + `renderInitialPlaceholders` (extend from PR B1).

### 18.3 Open questions

- **Show opponent name on the RIGHT of the turn bar?** Symmetrical but crowds the phase-description text. Recommend: no for v1. Keep the right slot for phase text only.
- **Show player name on the lobby list too?** Below the title of each game card? Not requested; defer.
- **Multi-game foreground.** The sidebar model already handles "foreground = one session at a time", so only one card should have `.active` at any moment. Verify via the existing `isForeground` check.

# Go Fish Contract — Test Plan

## Current State

The existing test suite (`example.test.ts`) has **65 happy-path tests** covering:
- Setup flow (init_deck, applyMask, dealCards)
- State queries (getGamePhase, getCurrentTurn, getScores, getHandSizes, etc.)
- Card discovery and uniqueness
- Single-turn game flow (askForCard → respondToAsk → goFish → afterGoFish)
- Book scoring (checkAndScoreBook)
- Multi-game isolation (2 concurrent games with independent state)
- Full game simulation to completion

**What is NOT tested:** Every `assert(...)` guard in the contract. The current suite only tests the success path — it never attempts an illegal action and verifies the contract rejects it.

---

## Missing Tests

Each test below targets a specific `assert` in `game.compact` or its modules. Tests are grouped by circuit. The "Assert message" column shows the exact error the test should expect.

### A. Setup Phase — `applyMask`

| # | Test | Action | Assert message |
|---|------|--------|----------------|
| A1 | Invalid player ID | `applyMask(gid, 0)` | `"Invalid player index"` |
| A2 | Invalid player ID (3) | `applyMask(gid, 3)` | `"Invalid player index"` |
| A3 | Duplicate mask P1 | P1 calls `applyMask` twice | `"Player has already applied their mask"` |
| A4 | Duplicate mask P2 | P2 calls `applyMask` twice | `"Player has already applied their mask"` |
| A5 | applyMask after setup phase | Complete setup, then call `applyMask` on same gameId | `"Can only apply mask during setup"` |

### B. Setup Phase — `dealCards`

| # | Test | Action | Assert message |
|---|------|--------|----------------|
| B1 | Deal on non-existent game | `dealCards(randomId, 1)` | `"Game does not exist"` |
| B2 | Deal before masks applied | Create game (P1 mask only), then `dealCards(gid, 1)` | `"Player 2 must apply mask before dealing"` |
| B3 | P2 deals first | Both masks applied, P2 calls `dealCards` before P1 | `"First player to deal must use player ID 1"` |
| B4 | P1 deals twice | P1 calls `dealCards` twice | `"Player has already dealt cards"` |
| B5 | Deal after setup complete | Full setup, then call `dealCards` again | `"Can only deal cards during setup"` |
| B6 | Deal with invalid player ID | `dealCards(gid, 0)` | `"Invalid player index"` |

### C. Asking for Cards — `askForCard`

| # | Test | Action | Assert message |
|---|------|--------|----------------|
| C1 | Ask on non-existent game | `askForCard(randomId, ...)` | `"Game does not exist"` |
| C2 | Ask during Setup phase | Call before dealing completes | `"Can only ask for cards at turn start"` |
| C3 | Wrong player asks | P2 asks when it's P1's turn | `"Not your turn - only current player can ask for cards"` |
| C4 | Ask for rank not in hand | P1 asks for a rank they don't hold | `"Cannot ask for a rank you don't have in your hand"` |
| C5 | Ask for invalid rank (7) | `askForCard(gid, 1, 7, now)` | `"Invalid card rank"` |
| C6 | Ask for invalid rank (255) | `askForCard(gid, 1, 255, now)` | `"Invalid card rank"` |
| C7 | Ask during WaitForResponse | Ask again while waiting for response | `"Can only ask for cards at turn start"` |

### D. Responding to Ask — `respondToAsk`

| # | Test | Action | Assert message |
|---|------|--------|----------------|
| D1 | Respond on non-existent game | `respondToAsk(randomId, ...)` | `"Game does not exist"` |
| D2 | Respond during wrong phase | Call during TurnStart | `"Not waiting for a response"` |
| D3 | Asking player responds to self | P1 asks, P1 responds | `"Asking player cannot respond to their own request"` |
| D4 | Invalid responder ID | `respondToAsk(gid, 3, now)` | `"Invalid player index"` |
| D5 | Respond when opponent has cards | Verify returns `[true, N]` and phase → TurnStart | *(positive, verify transfer)* |
| D6 | Respond when opponent has no cards | Verify returns `[false, 0]` and phase → WaitForDraw | *(positive, verify Go Fish)* |

### E. Drawing Cards — `goFish`

| # | Test | Action | Assert message |
|---|------|--------|----------------|
| E1 | goFish on non-existent game | `goFish(randomId, ...)` | `"Game does not exist"` |
| E2 | goFish during wrong phase | Call during TurnStart (without prior ask) | `"Not in draw phase"` |
| E3 | Wrong player draws | Opponent calls goFish | `"Not your turn - only current player can draw"` |
| E4 | goFish with empty deck | Exhaust deck, then goFish | `"Cannot draw - deck is empty"` |

### F. After Go Fish — `afterGoFish`

| # | Test | Action | Assert message |
|---|------|--------|----------------|
| F1 | afterGoFish on non-existent game | `afterGoFish(randomId, ...)` | `"Game does not exist"` |
| F2 | afterGoFish during wrong phase | Call during TurnStart | `"Not waiting for draw check"` |
| F3 | Wrong player calls afterGoFish | Opponent calls it | `"Only current player can call afterGoFish"` |
| F4 | Cheating: claim drew requested card | P1 draws rank X, claims drew rank Y | `"Cheating: You did not draw the requested card"` |
| F5 | Drew requested card → keep turn | `afterGoFish(gid, pid, true, now)` when true | phase → TurnStart, same player's turn |
| F6 | Didn't draw requested → switch turn | `afterGoFish(gid, pid, false, now)` | turn switches to opponent |

### G. Turn Management — `switchTurn`

| # | Test | Action | Assert message |
|---|------|--------|----------------|
| G1 | switchTurn on non-existent game | `switchTurn(randomId, 1)` | `"Game does not exist"` |
| G2 | switchTurn during wrong phase | Call during WaitForResponse | `"Can only switch turn during TurnStart phase"` |
| G3 | Non-current player switches | P2 switches when it's P1's turn | `"Only current player can switch turns"` |

### H. Book Scoring — `checkAndScoreBook`

| # | Test | Action | Assert message |
|---|------|--------|----------------|
| H1 | Score on non-existent game | `checkAndScoreBook(randomId, ...)` | `"Game does not exist"` |
| H2 | Invalid player ID | `checkAndScoreBook(gid, 0, 0)` | `"Invalid player index"` |
| H3 | Invalid rank (7) | `checkAndScoreBook(gid, 1, 7)` | `"Invalid card rank"` |
| H4 | Score during Setup | Call before game starts | `"Cannot score books during setup"` |
| H5 | Score during GameOver | Call after game ended | `"Game is already over"` |
| H6 | Score with < 3 cards of rank | Player has 1-2 of rank | returns `false`, no state change |
| H7 | Score with exactly 3 cards | Player has all 3 suits | returns `true`, hand size -3, score +1 |
| H8 | Game ends at 7 total books | Score the 7th book | phase → GameOver |

### I. Game End — `checkAndEndGame`

| # | Test | Action | Assert message |
|---|------|--------|----------------|
| I1 | checkAndEndGame non-existent | `checkAndEndGame(randomId)` | `"Game does not exist"` |
| I2 | Deck not empty | Call mid-game | returns `false` |
| I3 | Deck empty, both have cards | Exhaust deck but keep hands | returns `false` |
| I4 | Deck empty, one hand empty | Exhaust deck + empty one hand | returns `true`, phase → GameOver |

### J. Timeout — `claimTimeoutWin`

| # | Test | Action | Assert message |
|---|------|--------|----------------|
| J1 | Timeout non-existent game | `claimTimeoutWin(randomId, 1)` | `"Game does not exist"` |
| J2 | Timeout during Setup | Call before game starts | `"Game has not started yet"` |
| J3 | Timeout during GameOver | Call after game ended | `"Game is already over"` |
| J4 | Active player claims timeout | Current-turn player claims | `"Active player cannot claim timeout against themselves"` |
| J5 | Invalid player ID | `claimTimeoutWin(gid, 3)` | `"Invalid player index"` |
| J6 | Timeout not yet elapsed | Claim immediately after a move | `"Timeout period has not elapsed yet"` |

> **Note:** J6 and a valid-timeout test (J7) require `blockTimeGte`/`blockTimeLt` to be
> controllable from the test harness. If the simulator doesn't support advancing block time,
> these tests should be skipped with a comment explaining why.

### K. Card Integrity — Cross-cutting

| # | Test | What it verifies |
|---|------|-----------------|
| K1 | No duplicate cards after dealing | Union of both hands has 8 unique cards out of 21 |
| K2 | No duplicate cards after transfers | After respondToAsk with transfers, all cards still unique |
| K3 | Hand sizes match card count | `getHandSizes` matches `doesPlayerHaveSpecificCard` scan count |
| K4 | Deck + hands = 21 | `(21 - topCardIndex) + P1 hand + P2 hand = 21` at all times |
| K5 | Card point decryption round-trips | `get_card_from_point(partial_decryption(gid, card, pid))` returns original index |

### L. Multi-Game Isolation (extend existing)

| # | Test | What it verifies |
|---|------|-----------------|
| L1 | Score in game A doesn't affect game B | Score a book in A, verify B scores unchanged |
| L2 | Timeout in game A doesn't affect game B | End A via timeout, B still in TurnStart |
| L3 | Different phase per game | A in WaitForDraw, B in TurnStart — both operate independently |

---

## Implementation Notes

- **Negative tests pattern:** Wrap the circuit call in `try/catch`. On catch, verify the error message contains the expected assert string. If no error is thrown, fail the test.
  ```typescript
  try {
      provableCircuits.askForCard(sim.circuitContext, gameId, BigInt(2), BigInt(rank), BigInt(Date.now()));
      sim.circuitContext = ...; // update if needed
      recordTest('wrong player asks', false, 'Expected assert but call succeeded');
  } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes('Not your turn')) {
          recordTest('wrong player asks', true, null, msg);
      } else {
          recordTest('wrong player asks', false, e);
      }
  }
  ```

- **Test grouping:** Add new tests after the existing 65, grouped by circuit (A-L). Each group should start from a fresh `sim.reset()` + `init_deck` + full setup, so one failing test doesn't cascade.

- **Block time tests (J-series):** The `blockTimeLt` and `blockTimeGte` asserts in the contract compare against the circuit context's block timestamp. If the compact-runtime simulator doesn't expose a way to set block time, these tests must be documented as untestable in the simulator and deferred to on-chain integration tests.

- **Cheating test (F4):** Requires careful orchestration — ask for rank X, draw a card, determine its actual rank, then call `afterGoFish(drewRequestedCard=true)` when the actual rank differs. The contract checks `currentCount == prevCount + 1` which will fail.

## Priority Order

1. **A, B** — Setup guards (fast to write, catches config errors)
2. **C, D** — Ask/respond guards (core game loop protection)
3. **F4** — Cheating detection (security-critical)
4. **H6-H8** — Book scoring edge cases (game completion logic)
5. **E, F, G** — Remaining phase/turn guards
6. **K** — Card integrity invariants
7. **I** — Game end conditions
8. **J** — Timeout (may need harness changes)
9. **L** — Multi-game isolation extensions

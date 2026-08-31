# EVM Lobby Simplification Spec

Collapse the EVM-side lobby flow to **two user actions** — *Create* and *Join* — with auto-start on join, host cancel, and a 10-minute TTL on stale lobbies.

## Goals

1. Two user actions only: **Create** and **Join** (join auto-starts the game).
2. Host can **Cancel** an open lobby while no one else has joined.
3. Open lobbies disappear from the UI after **10 minutes**.
4. Max players is a constant (**2**) — always two players.
5. Drop all dead or now-unused commands from the EVM grammar.

## Final command set

After this refactor, the EVM `goFishL2Grammar` has exactly three commands:

| Command | Fields | Semantics |
|---|---|---|
| `createdLobby` | `playerName`, `lobbyName` | Creates a new lobby, host inserted as sole player. |
| `joinedLobby` | `playerName`, `lobbyID` | Second player joins. Handler unconditionally flips `status='in_progress'` and sets `started_at`. |
| `closedLobby` | `lobbyID` | Host cancels while still alone. Deletes the lobby row (cascades to `lobby_players`). |

Commands **deleted**: `toggledReady`, `startedGame`, `leftLobby`, `askedForCard`.

Note on `askedForCard`: this is the Paima grammar stub (past tense). It has no state-machine handler, no frontend encoder, no test — only two doc references. **Do not confuse** with the Midnight circuit `askForCard` (imperative, no "ed") at `packages/shared/contracts/midnight/go-fish-contract/src/game.compact:279`, which is the actual ZK gameplay circuit and must not be touched.

## File-by-file changes

### `packages/shared/data-types/src/grammar.ts`
- Delete `toggledReady`, `startedGame`, `leftLobby`, `askedForCard` entries.
- Keep `closedLobby` (already defined) — just ensure it survives.
- Modify `createdLobby`: remove the `maxPlayers` field. Final shape:
  ```ts
  createdLobby: [
    ['playerName', PlayerName],
    ['lobbyName', LobbyName],
  ],
  ```
- Final exported `goFishL2Grammar` contains only `createdLobby`, `joinedLobby`, `closedLobby`.

### `packages/client/node/src/state-machine.ts`
- **Delete handlers**: `toggledReady` (lines ~208–237), `startedGame` (~242–271), `leftLobby` (~276–305).
- **`createdLobby` handler (~22–118)**:
  - Remove the `data.parsedInput.maxPlayers` read.
  - Drop the `is_ready` column write when inserting the host into `lobby_players`.
  - Replace `lobby_${data.blockHeight}_${Date.now()}` with a deterministic ID (see *Determinism* below).
- **`joinedLobby` handler (~123–203)**:
  - After the `lobby_players` insert, unconditionally run the existing `startGame` update (set `status='in_progress'`, `started_at=<ts>`) in the same transition. No player-count check needed — the second `joinedLobby` is always the final player.
  - Remove any host-only check (never applied here anyway).
- **Add new `closedLobby` handler**:
  - Resolve signer → account_id.
  - `SELECT host_account_id, status FROM lobbies WHERE lobby_id = ?`.
  - Assert `host_account_id == signer_account_id`.
  - Assert `status = 'open'`.
  - Assert `(SELECT COUNT(*) FROM lobby_players WHERE lobby_id = ?) = 1` — only the host present.
  - `DELETE FROM lobbies WHERE lobby_id = ?`. Relies on `ON DELETE CASCADE` on the `lobby_players.lobby_id` FK (see schema section).
  - Any failed assertion: log and drop the transition (no-op), do not throw.

### `packages/client/database/migrations/database.sql`
- **Drop column** `lobbies.max_players`.
- **Drop column** `lobby_players.is_ready`.
- **Keep** `lobbies.created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP` — the TTL filter depends on it.
- **Pre-flight check**: verify the `lobby_players.lobby_id` FK has `ON DELETE CASCADE`. If missing, add it in the same migration. Otherwise the `closedLobby` handler needs a second explicit `DELETE FROM lobby_players WHERE lobby_id = ?` before the lobby delete.
- Indexes on `status` and `created_at DESC` stay — they support the TTL-filtered list query.

### `packages/client/database/src/lobby-queries.sql` (and generated pgtyped output)
- **Delete** the `togglePlayerReady` query.
- **Delete** the `startGame` query if it's still standalone — or keep it and call it from `joinedLobby`. Decide during implementation based on whether pgtyped reuse is cleaner than inlining.
- **Delete** any query that references `max_players` or `is_ready`.
- **Add** a `deleteLobby` query: `DELETE FROM lobbies WHERE lobby_id = :lobby_id`.
- **Add** a `countLobbyPlayers` query for the `closedLobby` assertion.
- Update the `openLobbies` SELECT — drop `max_players` from the column list.

### `packages/client/node/src/api.ts`
- `/open_lobbies` (~lines 78–125):
  - Modify the WHERE clause at ~line 112:
    ```sql
    WHERE l.status = 'open'
      AND l.created_at > NOW() - INTERVAL '10 minutes'
    ```
  - Drop `max_players` from the SELECT list.
  - Drop `max_players` from the TypeScript response type.
- Keep pagination, ordering (`created_at DESC`), and the optional `?wallet=` + `is_player_in_lobby` subquery (harmless, frontend may still want it).

### Shared TS types
- Wherever the `LobbySummary` / `OpenLobbyRow` type lives (likely `packages/shared/data-types/src/`), remove `maxPlayers` / `max_players`.

### Frontend (`packages/frontend/src/`)
- `screens/LobbyListScreen.ts`:
  - Per row: **Join** button for others' lobbies, **Cancel** button for your own open lobby (submits `closedLobby`). No ready toggle, no start button, no max-players display.
  - Keep the 4000ms poll at line ~24.
  - On poll tick, if the current player is a member of a lobby whose status flipped to `in_progress`, navigate to the game screen. The host, still on the waiting screen, routes through the same mechanism.
- `screens/CreateLobbyScreen.ts` (or equivalent):
  - Remove any max-players selector. Submit `createdLobby(playerName, lobbyName)` only.
- `services/GoFishGameService.ts` (~line 133 area):
  - Delete encoders/helpers for `toggledReady`, `startedGame`, `leftLobby`, and the Paima-grammar `askedForCard` if present. **Do not touch** any Midnight `askForCard` helpers.
  - Update the `createLobby(...)` helper signature to drop `maxPlayers`.
- Update the `/open_lobbies` fetch response type to match the API change.

### Docs
- `README.md` line ~190: remove the `askedForCard` bullet, update the commands list to the new three-command set.
- `CLAUDE.md` line ~119: update the "Paima concise grammar commands" section. The **Lobby** group becomes `createdLobby`, `joinedLobby`, `closedLobby`. Delete the **Game: `askedForCard`** line entirely.

### Tests (`packages/client/node/src/api.test.ts`)
- **Delete / rewrite** any test referencing `toggledReady`, `startedGame`, `leftLobby`, or `maxPlayers`.
- **Add** — auto-start: submit `createdLobby` then `joinedLobby`; assert `lobbies.status = 'in_progress'` and `started_at IS NOT NULL`.
- **Add** — `closedLobby` happy path: host alone, submits close, lobby row gone, `lobby_players` rows gone.
- **Add** — `closedLobby` rejection: non-host signer → no-op; second player present → no-op; `status != 'open'` → no-op.
- **Add** — TTL filter: insert a lobby with `created_at = NOW() - INTERVAL '11 minutes'`, `GET /open_lobbies`, assert absent. Insert a sibling with `created_at = NOW() - INTERVAL '9 minutes'`, assert present.

## Determinism fix (separate commit, recommended)

Today `state-machine.ts:29` uses `Date.now()` in the lobby ID, and the DB defaults `created_at` to `CURRENT_TIMESTAMP`. Both are non-deterministic on state-machine replay. The TTL filter now makes this matter: two replays could land a lobby on different sides of the 10-minute cutoff.

- Replace the lobby ID suffix with the block timestamp from the event payload, if Paima exposes one. Fallback: `data.blockHeight` alone is sufficient for uniqueness.
- Write `created_at` from the handler (parameterised) using the same block timestamp, instead of relying on `DEFAULT CURRENT_TIMESTAMP`.
- Pre-flight: verify whether the Paima runtime surfaces a block timestamp on the event `data` object. If not, document the limitation and defer the fix.

This can ship as an independent commit before or after the main refactor.

## Implementation order

1. **Grammar** deletions + `createdLobby` field drop. Expect compile errors to pinpoint every call site that still references the old commands — they guide steps 2 and 5.
2. **State machine**: delete dead handlers, modify `createdLobby` and `joinedLobby`, add `closedLobby`.
3. **Database**: schema migration (drop columns, verify cascade), update `lobby-queries.sql`, regenerate pgtyped.
4. **API**: `/open_lobbies` TTL filter and response type.
5. **Frontend**: button cleanup, create-lobby form, auto-nav on status flip, response type update.
6. **Tests**: delete obsolete, add new (auto-start, close, TTL).
7. **Docs**: `README.md`, `CLAUDE.md`.
8. **(Optional)** Determinism fix as its own commit.

## Out of scope

- Midnight-side circuits, including `askForCard` / `respondToAsk` / `goFish` / `afterGoFish`. None of those are touched.
- Hard TTL (cron/state-machine sweep that writes an `expired` status). Soft query-time filter is sufficient for the UI requirement.
- Leaderboard / stats / scoring flows.
- Any `PaimaL2Contract.sol` change — the contract stays a thin `paimaSubmitGameInput(bytes)` wrapper.

## Acceptance checklist

- [ ] `goFishL2Grammar` exports exactly `createdLobby`, `joinedLobby`, `closedLobby`.
- [ ] Submitting `joinedLobby` as the second player transitions `lobbies.status` to `'in_progress'` in one state-machine step.
- [ ] Host submitting `closedLobby` while alone deletes the lobby and its `lobby_players` rows.
- [ ] Non-host `closedLobby`, or `closedLobby` with a second player present, is a no-op.
- [ ] `GET /open_lobbies` never returns rows older than 10 minutes.
- [ ] `lobbies.max_players` and `lobby_players.is_ready` columns no longer exist.
- [ ] Frontend shows only **Create**, **Join**, **Cancel** buttons in the lobby flow; no ready/start UI.
- [ ] No reference to `askedForCard` anywhere in `packages/` or docs. References to Midnight `askForCard` are untouched.
- [ ] `api.test.ts` passes with the new auto-start, close, and TTL tests.

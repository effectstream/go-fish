# Setup Race Condition - Final Fix

**Date**: 2026-01-16
**Issue**: Players still retrying applyMask/dealCards after success
**Status**: ✅ Fixed with frontend-side caching

## Problem

Even with backend status checks, the race condition persisted:

```
17:22:01 INFO [MidnightActions] applyMask succeeded (Player 2)
17:22:02 INFO [MidnightActions] applyMask succeeded (Player 1)
17:22:04 ERROR [MidnightActions] applyMask failed: Player has already applied their mask (Player 2)
17:22:04 ERROR [MidnightActions] applyMask failed: Player has already applied their mask (Player 1)
```

Both players were retrying operations 2 seconds later (next poll cycle) even though they had already succeeded.

## Root Cause

The backend status check (`/api/midnight/setup_status`) could return stale data due to:
1. **Query caching** - 1 second cache TTL
2. **Contract state lag** - Midnight contract state might not be immediately queryable
3. **Race between write and read** - Status check happens before contract state is fully committed

Timeline:
```
T=0s   Player applies mask → contract updated
T=0.5s Backend cache expires
T=1s   Frontend polls status
T=1.1s Status check queries contract (might get old state)
T=1.1s Status returns hasMaskApplied: false (wrong!)
T=1.2s Frontend thinks mask not applied, tries again
T=1.2s ERROR: Already applied!
```

## Solution: Frontend-Side Caching

Added frontend-side flags to track which operations **this client** has attempted:

### Code Changes

**File**: [GameScreen.ts:39-40](packages/frontend/src/screens/GameScreen.ts#L39-L40)

```typescript
private setupInProgress: boolean = false;
private setupCompleted: boolean = false;
private maskApplied: boolean = false;  // Track if we've applied mask (frontend-side cache)
private cardsDealt: boolean = false;   // Track if we've dealt cards (frontend-side cache)
```

### Updated Logic

**Apply Mask** - [GameScreen.ts:282-308](packages/frontend/src/screens/GameScreen.ts#L282-L308)

```typescript
// Before - Only checked backend status
if (!status.hasMaskApplied) {
  await applyMask();
}

// After - Double check: frontend cache AND backend status
if (!this.maskApplied && !status.hasMaskApplied) {
  const result = await applyMask();

  if (result.success) {
    this.maskApplied = true;  // ✅ Mark as applied locally
  } else if (result.errorMessage?.includes('already applied')) {
    this.maskApplied = true;  // ✅ Mark as applied even on error
  }
}
```

**Deal Cards** - [GameScreen.ts:312-352](packages/frontend/src/screens/GameScreen.ts#L312-L352)

```typescript
// Before
if (!status.hasDealt) {
  await dealCards();
}

// After - Double check
if (!this.cardsDealt && !status.hasDealt) {
  const result = await dealCards();

  if (result.success) {
    this.cardsDealt = true;  // ✅ Mark as dealt locally
  } else if (result.errorMessage?.includes('already dealt')) {
    this.cardsDealt = true;  // ✅ Mark as dealt even on error
  }
}
```

## How It Works Now

### Successful Flow

```
Poll 1 (T=0s):
  this.maskApplied = false
  status.hasMaskApplied = false
  → Call applyMask() ✅
  → Set this.maskApplied = true

Poll 2 (T=2s):
  this.maskApplied = true  ✅ Frontend knows we already did this!
  → Skip applyMask() (even if backend status is stale)
  → No duplicate request!
```

### Error Recovery Flow

```
Poll 1 (T=0s):
  this.maskApplied = false
  status.hasMaskApplied = false
  → Call applyMask()
  → Network error! ❌
  → this.maskApplied stays false

Poll 2 (T=2s):
  this.maskApplied = false
  status.hasMaskApplied = false
  → Retry applyMask() ✅ (valid retry)
  → Success!
  → Set this.maskApplied = true
```

### "Already Applied" Error Flow

```
Poll 1 (T=0s):
  Player applies mask successfully
  Backend slow to update status

Poll 2 (T=2s):
  this.maskApplied = false (we think)
  status.hasMaskApplied = false (stale data)
  → Call applyMask()
  → Error: "already applied"
  → Set this.maskApplied = true ✅
  → Continue to next step!

Poll 3 (T=4s):
  this.maskApplied = true ✅
  → Skip applyMask()
  → No more errors!
```

## Key Benefits

1. **Idempotency**: Each operation only attempted once per client
2. **Resilience to stale data**: Works even if backend status is cached/delayed
3. **Error tolerance**: "Already applied" errors mark operation as complete
4. **Valid retries still work**: Real failures (network errors) still retry

## Comparison

| Scenario | Before | After |
|----------|--------|-------|
| Backend status stale | Retry → Error ❌ | Skip (frontend cache) ✅ |
| Network failure | No retry ❌ | Retry next poll ✅ |
| "Already applied" error | Retry loop ❌ | Mark complete, move on ✅ |
| Successful operation | Works ✅ | Works ✅ |

## Testing

### Manual Test

1. Start game with both players
2. Observe console logs:

**Expected**:
```
[GameScreen] Applying mask...
[GameScreen] Mask applied successfully
[GameScreen] Mask already applied, skipping  ← No retry!
[GameScreen] Both players have masks applied, dealing cards...
[GameScreen] Cards dealt successfully
[GameScreen] Cards already dealt, skipping  ← No retry!
[GameScreen] Automatic setup complete!
```

**No errors about "already applied"**

### Stress Test

1. Start 10 games in a row
2. All should complete without duplicate operation errors

## Files Modified

- **[GameScreen.ts:39-40](packages/frontend/src/screens/GameScreen.ts#L39-L40)** - Added frontend cache flags
- **[GameScreen.ts:282-308](packages/frontend/src/screens/GameScreen.ts#L282-L308)** - Apply mask with double-check
- **[GameScreen.ts:312-352](packages/frontend/src/screens/GameScreen.ts#L312-L352)** - Deal cards with double-check

## Related Documentation

- [AUTOMATIC_SETUP_RACE_CONDITION_FIX.md](AUTOMATIC_SETUP_RACE_CONDITION_FIX.md) - Initial race condition fix
- [FIXES_2026_01_16_PART2.md](FIXES_2026_01_16_PART2.md) - Other fixes from today
- [DB_MUTEX_DEADLOCK_FIX.md](DB_MUTEX_DEADLOCK_FIX.md) - Polling and caching fixes

## Lessons Learned

1. **Don't trust backend status alone** - Always cache client-side state
2. **Idempotency is key** - Operations should be safe to retry
3. **Error messages are data** - "Already done" errors can guide state
4. **Multi-layer defense** - Backend status + frontend cache = robust

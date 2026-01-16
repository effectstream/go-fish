# Midnight Integration Tasks

**Status**: Architecture complete, ready for SDK integration

All scaffolding, witnesses, and API endpoints are in place. You need to replace the TODO placeholders with actual Midnight SDK calls.

---

## Task 1: Import Midnight Contract Runtime

**File**: `packages/frontend/src/midnightBridge.ts`

**Add imports** (top of file):
```typescript
import { Contract, type Witnesses, ledger } from '../../shared/contracts/midnight/go-fish-contract/managed/contract/index.js';
import type { CircuitContext } from '@midnight-ntwrk/compact-runtime';
// Import whatever Midnight wallet SDK you're using
```

---

## Task 2: Initialize Contract Instance

**File**: `packages/frontend/src/midnightBridge.ts`

**Replace the placeholder** (line ~10):
```typescript
let contract: Contract<PrivateState> | null = null;
```

**With initialization**:
```typescript
// Initialize when wallet connects
const contract = await Contract.create({
  witnesses: witnesses, // Already implemented (lines 121-165)
  privateState: privateState,
  // ... other Midnight runtime config
});
```

---

## Task 3: Connect Midnight Wallet

**File**: `packages/frontend/src/midnightBridge.ts` (Line 27-38)

**Replace TODO**:
```typescript
export async function connectMidnightWallet() {
  try {
    // TODO: Replace this line
    // midnightWallet = { connected: true };

    // With actual Midnight SDK call:
    midnightWallet = await MidnightWallet.connect(); // or similar

    // Already has error handling below
    return { success: true };
  } catch (error) {
    // ... existing error handling
  }
}
```

---

## Task 4: Replace Circuit Call Placeholders

All functions follow this pattern. Replace the `// TODO` section with actual contract calls:

### Pattern (all 11 functions follow this):
```typescript
export async function someAction(params) {
  try {
    if (!isMidnightConnected()) {
      return { success: false, errorMessage: 'Not connected' };
    }

    const gameId = lobbyIdToGameId(lobbyId); // Already implemented

    // ⚠️ REPLACE THIS PLACEHOLDER:
    console.log(`[MidnightBridge] someAction(...)`);
    await new Promise(resolve => setTimeout(resolve, 1000));

    // 👇 WITH ACTUAL CONTRACT CALL:
    const result = await contract.someAction({
      gameId: gameId,
      playerId: BigInt(playerId),
      // ... other params
    });

    return { success: true, /* extract result data */ };
  } catch (error) {
    // Already has error handling
  }
}
```

### List of Functions to Update (all in midnightBridge.ts):

| Function | Line | Contract Method | Returns |
|----------|------|-----------------|---------|
| `applyMask` | 212-238 | `contract.applyMask(gameId, playerId)` | `[]` |
| `dealCards` | 247-270 | `contract.dealCards(gameId, playerId)` | `[]` |
| `askForCard` | 279-302 | `contract.askForCard(gameId, playerId, rank)` | `[]` |
| `respondToAsk` | 311-335 | `contract.respondToAsk(gameId, playerId)` | `[boolean, bigint]` |
| `goFish` | 344-368 | `contract.goFish(gameId, playerId)` | `CurvePoint` |
| `afterGoFish` | 377-401 | `contract.afterGoFish(gameId, playerId, drew)` | `[]` |
| `checkAndScoreBook` | 410-434 | `contract.checkAndScoreBook(gameId, playerId, rank)` | `boolean` |
| `getGamePhase` | 443-453 | `contract.getGamePhase(gameId)` | `number` |
| `getScores` | 460-470 | `contract.getScores(gameId)` | `[bigint, bigint]` |

---

## Task 5: Backend Midnight Queries

**File**: `packages/client/node/src/api.ts` (Line 226-264)

**Current**: Returns placeholder data
**Needed**: Query actual Midnight contract

**Replace placeholder** (line 247-263):
```typescript
// TODO: Query Midnight contract for actual game state

// 👇 WITH:
const midnightState = await queryMidnightContract(gameId);

return {
  lobbyId: lobby_id,
  // ... existing fields ...

  // Replace placeholders with real data:
  phase: midnightState.phase,
  currentTurn: Number(midnightState.currentTurn),
  scores: midnightState.scores.map(Number),
  handSizes: midnightState.handSizes.map(Number),
  deckCount: Number(midnightState.deckSize - midnightState.topCardIndex),
  isGameOver: midnightState.isGameOver,

  // Query player's private hand
  myHand: await queryPlayerHand(gameId, currentPlayerId),
  myBooks: await calculatePlayerBooks(gameId, currentPlayerId),
};
```

**Helper to create**:
```typescript
async function queryMidnightContract(gameId: Uint8Array) {
  // Use Midnight query context to read contract state
  // Return: { phase, currentTurn, scores, handSizes, deckSize, topCardIndex, isGameOver }
}

async function queryPlayerHand(gameId: Uint8Array, playerId: number) {
  // Query player's semi-masked cards
  // Decrypt using player's secret key
  // Return array of card objects
}
```

---

## Task 6: Midnight Event Indexer (Optional for MVP)

**Create new file**: `packages/client/node/src/midnight-indexer.ts`

**Purpose**: Listen to Midnight contract events and sync to database

For MVP, you can skip this and just poll the contract directly from the API endpoint. For production, you'd want:

```typescript
// Listen to Midnight events
midnightContract.on('GamePhaseChanged', (gameId, newPhase) => {
  // Update database
  db.query('UPDATE games SET phase = $1 WHERE game_id = $2', [newPhase, gameId]);
});

midnightContract.on('ScoreUpdated', (gameId, playerId, newScore) => {
  // Log to game_moves table
  db.query('INSERT INTO game_moves (game_id, account_id, move_type, ...) VALUES (...)');
});
```

---

## Reference: Contract TypeScript Bindings

**Location**: `packages/shared/contracts/midnight/go-fish-contract/managed/contract/index.d.ts`

All circuit signatures are already defined. Example:

```typescript
export type ImpureCircuits<PS> = {
  applyMask(
    context: CircuitContext<PS>,
    gameId_0: Uint8Array,
    playerId_0: bigint
  ): CircuitResults<PS, []>;

  askForCard(
    context: CircuitContext<PS>,
    gameId_0: Uint8Array,
    askingPlayerId_0: bigint,
    targetRank_0: bigint
  ): CircuitResults<PS, []>;

  // ... etc
};
```

---

## Testing Your Integration

1. **Start with wallet connection**:
   ```typescript
   await connectMidnightWallet();
   console.log(isMidnightConnected()); // Should be true
   ```

2. **Test applyMask** (simplest circuit):
   ```typescript
   const result = await applyMask('test_lobby_123', 1);
   console.log(result); // { success: true }
   ```

3. **Test state query**:
   ```typescript
   const phase = await getGamePhase('test_lobby_123');
   console.log(phase); // Should return 0 (Setup) initially
   ```

4. **Full game flow**:
   - Both players: `applyMask(gameId, playerId)`
   - Both players: `dealCards(gameId, playerId)`
   - Player 1: `askForCard(gameId, 1, rank)`
   - Player 2: `respondToAsk(gameId, 2)`
   - Continue with goFish, checkAndScoreBook, etc.

---

## Key Points

✅ **What's Done**:
- Architecture and file structure
- All function signatures
- Witness implementations (crypto helpers)
- Error handling patterns
- API endpoint structure
- Database schema

🔧 **What You Do**:
- Import Midnight SDK
- Replace TODOs with contract calls
- Handle contract responses
- Query contract state in API

**Estimated Time**: 2-4 hours for basic integration (assuming Midnight SDK docs are clear)

---

## Questions?

Refer to:
- Full integration guide: `MIDNIGHT_INTEGRATION.md`
- Midnight contract test: `packages/shared/contracts/midnight/example.test.ts`
- Contract bindings: `packages/shared/contracts/midnight/go-fish-contract/managed/contract/`

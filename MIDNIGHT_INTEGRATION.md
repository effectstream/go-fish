# Midnight Contract Integration Guide

This document outlines the integration between your Paima-based Go Fish game and the Midnight ZK contract.

## Current Status

### ✅ Completed

1. **Midnight Contract** - Fully implemented with ZK privacy features
   - Location: `packages/shared/contracts/midnight/go-fish-contract/src/`
   - 4 modules: GoFish.compact, Hand.compact, Deck.compact, game.compact
   - All circuits exported and TypeScript bindings generated

2. **Frontend Midnight Bridge** - Skeleton implementation with witness providers
   - Location: `packages/frontend/src/midnightBridge.ts`
   - Witness implementations for client-side proof generation
   - Function stubs for all game actions (applyMask, dealCards, askForCard, etc.)

3. **Backend API Endpoint** - `/game_state` endpoint created
   - Location: `packages/client/node/src/api.ts` (lines 158-265)
   - Returns player-specific game state
   - Placeholder for Midnight contract queries (marked with TODO)

4. **EVM Lobby System** - Fully functional
   - Create/join/ready/start lobby flow working
   - Leave lobby functionality implemented
   - Smooth transition to `in_progress` status

### 🚧 Ready for Integration

The following integration points are **ready** for your Midnight integration engineer. All architecture, witnesses, and API endpoints are in place - they just need to wire up the actual Midnight SDK calls:

## 1. Midnight Wallet Connection

**File**: `packages/frontend/src/midnightBridge.ts` (Line 27-38)

**Status**: Stub ready, SDK import needed

**What's ready**:
- Function signature and error handling structure
- `midnightWallet` state variable
- `isMidnightConnected()` helper

**Integration needed**:
```typescript
export async function connectMidnightWallet(): Promise<{ success: boolean; errorMessage?: string }> {
  try {
    // Replace placeholder with actual Midnight wallet SDK
    // Example: const wallet = await MidnightWallet.connect();

    midnightWallet = wallet; // Store wallet instance
    return { success: true };
  } catch (error) {
    // Error handling already in place
    return { success: false, errorMessage: error.message };
  }
}
```

**SDK to use**: `@midnight-ntwrk/wallet-sdk` or equivalent

## 2. Circuit Call Implementation

**File**: `packages/frontend/src/midnightBridge.ts`

**Status**: All 11 function stubs ready with witnesses

**What's ready**:
- ✅ All witness implementations (getFieldInverse, player_secret_key, etc.)
- ✅ Function signatures matching contract TypeScript bindings
- ✅ Error handling and response structures
- ✅ gameId conversion helper (`lobbyIdToGameId`)
- ✅ Private state management (`PrivateState` type)

**Integration pattern** (same for all functions):

### Setup Phase
```typescript
// Line 212-238: applyMask()
// - Generate player secret key witness
// - Generate shuffle seed witness
// - Call contract.applyMask(gameId, playerId)
// - Generate ZK proof
// - Submit transaction

// Line 247-270: dealCards()
// - Call contract.dealCards(gameId, playerId)
// - Generate ZK proof
// - Submit transaction
```

### Gameplay Actions
```typescript
// Line 279-302: askForCard()
// - Call contract.askForCard(gameId, playerId, targetRank)
// - Verify player has rank in hand (client-side check)

// Line 311-335: respondToAsk()
// - Call contract.respondToAsk(gameId, playerId)
// - Returns [hasCards, count]

// Line 344-368: goFish()
// - Call contract.goFish(gameId, playerId)
// - Returns CurvePoint (semi-masked card)

// Line 377-401: afterGoFish()
// - Call contract.afterGoFish(gameId, playerId, drewRequestedCard)
// - Verify delta check passed

// Line 410-434: checkAndScoreBook()
// - Call contract.checkAndScoreBook(gameId, playerId, targetRank)
// - Returns boolean (book completed)
```

### State Queries
```typescript
// Line 443-453: getGamePhase()
// - Query contract.getGamePhase(gameId)

// Line 460-470: getScores()
// - Query contract.getScores(gameId)
// - Returns [score1, score2]
```

**Key Requirements**:
- Use generated TypeScript bindings from `packages/shared/contracts/midnight/go-fish-contract/managed/contract/index.js`
- Implement witness generation using the provided `witnesses` object
- Handle proof generation and transaction submission
- Return proper success/error responses

## 3. Midnight Event Indexer

**File**: Create new file `packages/client/node/src/midnight-indexer.ts`

**Purpose**: Listen to Midnight contract events and sync state to Paima database

**Required functionality**:
```typescript
// Listen for Midnight contract state changes
// - Game phase transitions
// - Score updates
// - Card transfers
// - Book completions

// Update Paima database tables:
// - game_moves table (track all actions)
// - games table (update current state)
```

**Database Schema** (already exists):
```sql
-- packages/client/database/src/mod.ts lines 75-85
CREATE TABLE game_moves (
    move_id SERIAL PRIMARY KEY,
    game_id TEXT NOT NULL,
    account_id INTEGER NOT NULL,
    move_type TEXT NOT NULL,  -- 'ask', 'respond', 'draw', 'book'
    target_account_id INTEGER,
    rank TEXT,
    cards_transferred INTEGER DEFAULT 0,
    success BOOLEAN,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

## 4. Backend Midnight Contract Queries

**File**: `packages/client/node/src/api.ts`

**Location**: Line 226-264 (marked with `// TODO: Query Midnight contract`)

**Implement queries for `/game_state` endpoint**:
```typescript
// Query Midnight contract for public state:
const phase = await midnightContract.getGamePhase(gameId);
const currentTurn = await midnightContract.getCurrentTurn(gameId);
const scores = await midnightContract.getScores(gameId);
const handSizes = await midnightContract.getHandSizes(gameId);
const deckCount = await getDeckCount(gameId); // getDeckSize() - getTopCardIndex()
const isGameOver = await midnightContract.isGameOver(gameId);

// Query player-specific private state:
const myHand = await queryPlayerHand(gameId, currentPlayerId);
const myBooks = await calculatePlayerBooks(gameId, currentPlayerId);
```

**Required**:
- Set up Midnight contract query context
- Handle contract state reads
- Decrypt player's private hand data
- Calculate derived state (books, etc.)

## 5. Game Flow Integration

### Current Flow (EVM only)
```
1. Player creates lobby (EVM)
2. Players join (EVM)
3. Players ready up (EVM)
4. Host starts game (EVM)
   → Lobby status = 'in_progress'
5. [Gap: No gameplay implementation]
```

### Target Flow (EVM + Midnight)
```
1-4. [Same as above]

5. Frontend detects status = 'in_progress'
   → Navigate to GameScreen

6. GameScreen initiates Midnight setup:
   → Player 1: applyMask(gameId, 1)
   → Player 2: applyMask(gameId, 2)
   → Player 1: dealCards(gameId, 1)  [deals to P2]
   → Player 2: dealCards(gameId, 2)  [deals to P1]

7. Game begins (phase = TurnStart)
   → GameScreen polls /game_state every 1 second
   → Displays current player's hand (decrypted)
   → Shows opponent's card count (encrypted)

8. Player actions:
   → askForCard() → respondToAsk() → [transfer or goFish()]
   → afterGoFish() → checkAndScoreBook()
   → Repeat until game over

9. Game ends:
   → Navigate to ResultsScreen
   → Display final scores
```

## 6. GameScreen Integration

**File**: `packages/frontend/src/screens/GameScreen.ts`

**Current**: Uses local state from `GoFishGameService.getGameState()`
**Target**: Fetch from `/game_state` API (Midnight-synced)

**Changes needed**:
```typescript
// Line 35-42: Change from local state to API
private async render() {
  const response = await fetch(
    `http://localhost:9999/game_state?lobby_id=${this.lobbyId}&wallet=${walletAddress}`
  );
  const gameData = await response.json();

  // Use gameData instead of local game object
  // gameData.myHand, gameData.phase, gameData.scores, etc.
}

// Line 261-277: Change askForCard to use Midnight
document.getElementById('ask-btn')?.addEventListener('click', async () => {
  if (this.selectedRank && this.selectedTargetId) {
    const result = await MidnightBridge.askForCard(
      this.lobbyId,
      this.myPlayerId,
      this.selectedRank
    );

    if (result.success) {
      // Wait for opponent's respondToAsk()
      // State updates via API polling
    }
  }
});
```

## Data Flow Diagram

```
┌─────────────┐
│  Frontend   │
│  (Browser)  │
└──────┬──────┘
       │
       │ 1. Game actions
       ↓
┌─────────────────┐
│ Midnight Bridge │  ← witnesses (secrets, seeds)
│ (Frontend)      │
└──────┬──────────┘
       │
       │ 2. ZK proofs
       ↓
┌──────────────────┐
│ Midnight Network │  ← Contract circuits
│ (Blockchain)     │
└──────┬───────────┘
       │
       │ 3. Events
       ↓
┌───────────────────┐
│ Midnight Indexer  │
│ (Paima Node)      │
└──────┬────────────┘
       │
       │ 4. State updates
       ↓
┌──────────────┐
│  Database    │
│  (PGLite)    │
└──────┬───────┘
       │
       │ 5. State queries
       ↓
┌──────────────┐
│  API Server  │
│  (Fastify)   │
└──────┬───────┘
       │
       │ 6. Game state JSON
       ↓
┌──────────────┐
│  Frontend    │
│  (Polling)   │
└──────────────┘
```

## Player ID Mapping

**Rule**: `lobby host = player1, first joiner = player2`

**Implementation**: Already done in `/game_state` API (line 219-220)
```typescript
// Determine player IDs (host = player1, first joiner = player2)
const currentPlayerId = players.findIndex((p: any) => p.account_id === accountId) + 1;
```

## Testing Checklist

Once implementation is complete, test this flow:

- [ ] Create lobby (EVM)
- [ ] Join lobby (EVM)
- [ ] Ready up (EVM)
- [ ] Start game (EVM)
- [ ] Both players connect Midnight wallet
- [ ] Both players apply mask
- [ ] Both players deal cards
- [ ] Game enters TurnStart phase
- [ ] Player 1 asks for card
- [ ] Player 2 responds (has cards → transfer)
- [ ] Player 1 asks again (no cards → go fish)
- [ ] Player 1 draws card
- [ ] Player completes a book (4 of same rank)
- [ ] Turn switches
- [ ] Continue until game over (13 books or deck empty)
- [ ] View results screen

## Key Files Reference

### Midnight Contract
- Main contract: `packages/shared/contracts/midnight/go-fish-contract/src/game.compact`
- TypeScript bindings: `packages/shared/contracts/midnight/go-fish-contract/managed/contract/index.d.ts`
- Test example: `packages/shared/contracts/midnight/example.test.ts`

### Frontend
- Midnight bridge: `packages/frontend/src/midnightBridge.ts` ✅ (stubs created)
- EVM bridge: `packages/frontend/src/effectstreamBridge.ts`
- Game screen: `packages/frontend/src/screens/GameScreen.ts`
- Results screen: `packages/frontend/src/screens/ResultsScreen.ts`

### Backend
- API routes: `packages/client/node/src/api.ts` ✅ (/game_state added)
- State machine: `packages/client/node/src/state-machine.ts`
- Database queries: `packages/client/database/src/game-queries.sql`

## Notes for Integration Engineer

1. **Witness Generation**: All witness functions are implemented in `midnightBridge.ts`. The `witnesses` object is exported and ready to use with the Midnight runtime.

2. **Secret Key Management**: Currently generates random secrets. In production, derive from wallet signature for deterministic keys across sessions.

3. **gameId Generation**: Uses simple encoding in `lobbyIdToGameId()`. Consider using proper keccak256 for production.

4. **Error Handling**: All bridge functions return `{ success: boolean, errorMessage?: string }`. Use this pattern consistently.

5. **Proof Costs**: ZK proofs can be expensive. Monitor gas costs for:
   - Shuffle (52 cards) - Most expensive
   - Card transfers - Moderate
   - Book scoring - Moderate
   - State queries - Read-only (cheap)

6. **Privacy**: The Midnight contract ensures:
   - Player hands are private (semi-masked)
   - Deck order is hidden
   - Card transfers are verifiable
   - No trusted dealer needed

## Questions?

Contact the team lead or refer to:
- [Midnight Documentation](https://docs.midnight.network/)
- [Paima Engine Docs](https://docs.paimastudios.com/)
- Existing test suite: `packages/shared/contracts/midnight/example.test.ts`

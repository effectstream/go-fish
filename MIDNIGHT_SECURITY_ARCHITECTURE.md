# Midnight Security Architecture - Mental Poker Protocol

**Date**: 2026-01-16
**Status**: ⚠️ CURRENT IMPLEMENTATION IS INSECURE (Testing Only)

## Overview

This document explains the security model for the Go Fish Midnight integration and outlines the path from the current **insecure testing implementation** to a **production-ready secure implementation**.

## Mental Poker Protocol Fundamentals

Mental Poker is a cryptographic protocol that allows players to play card games without a trusted dealer. The core principle:

> **No single party (including the server) should be able to see any player's cards**

### How It Works (Simplified)

1. **Static Deck**: All players agree on a standard 52-card deck (represented as elliptic curve points)
2. **Player Masking**: Each player applies their secret mask to the deck
   - Player 1: `maskedDeck = deck × secret1` (elliptic curve scalar multiplication)
   - Player 2: `doubleMaskedDeck = maskedDeck × secret2`
3. **Dealing**: Cards are drawn from the double-masked deck
4. **Unmasking**: Each player unmasks their own cards using their secret
   - Player 1's card: `card = doubleMaskedCard / secret1 / secret2`
5. **Zero-Knowledge Proofs**: Players prove actions are valid without revealing cards

### Critical Security Requirement

**Player secrets MUST remain private to each player**
- If Server knows Secret1 AND Secret2 → Server can decrypt ALL cards
- If Player1 knows Player2's Secret2 → Player1 can cheat
- Secrets must be generated client-side and NEVER transmitted

## Current Implementation (INSECURE - Testing Only)

### Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│ Frontend (Browser)                                       │
│  ├── midnightBridge.ts                                  │
│  │   └── witnesses { player_secret_key, shuffle_seed } │
│  │       └── Generates secrets locally ✅               │
│  └── Does NOT call backend for game actions yet ❌      │
└─────────────────────────────────────────────────────────┘
                          ↓
                  HTTP API Calls
                          ↓
┌─────────────────────────────────────────────────────────┐
│ Backend (Server)                                         │
│  ├── midnight-actions.ts                                │
│  │   └── witnesses { player_secret_key, shuffle_seed } │
│  │       └── Generates secrets for BOTH players ⚠️      │
│  │       └── Stores secrets in Map ⚠️                   │
│  ├── applyMask(), dealCards() - called from API         │
│  └── Backend executes ALL ZK circuits ⚠️                │
└─────────────────────────────────────────────────────────┘
```

### Security Violations

#### 1. Backend Generates Player Secrets
**Location**: [midnight-actions.ts:69-85](packages/client/node/src/midnight-actions.ts#L69-L85)

```typescript
player_secret_key: (context, gameId, player) => {
  // ⚠️ Backend generates secrets for BOTH players
  const secret = BigInt(Math.floor(Math.random() * 1000000)) + 1n;
  playerSecrets.set(key, secret);  // ⚠️ Server stores secrets
  return [context.privateState, secret];
}
```

**Problem**: Server knows Player 1's secret AND Player 2's secret
**Impact**: Server can decrypt both players' hands → Mental Poker broken

#### 2. Backend Executes Game Actions
**Location**: [midnight-actions.ts:287-312](packages/client/node/src/midnight-actions.ts#L287-L312)

```typescript
export async function applyMask(lobbyId: string, playerId: 1 | 2) {
  // ⚠️ Backend runs the circuit (uses backend-generated secret)
  const result = actionContract.impureCircuits.applyMask(
    actionContext,
    gameId,
    BigInt(playerId)
  );
}
```

**Problem**: Backend executes circuits with its own generated secrets
**Impact**: Players never generate their own secrets → Not zero-knowledge

#### 3. Secrets Stored Server-Side
**Location**: [midnight-actions.ts:41](packages/client/node/src/midnight-actions.ts#L41)

```typescript
const playerSecrets = new Map<string, bigint>();
```

**Problem**: All secrets stored in server memory
**Impact**:
- Server compromise reveals all secrets
- Server operator can cheat
- Not truly decentralized

### Why This Works for Testing

✅ **Functionality**: The game works, cards are masked/unmasked correctly
✅ **Development**: Easy to test without complex client-side crypto
✅ **Debugging**: Server can see all state for troubleshooting

❌ **Security**: Completely violates Mental Poker security guarantees

## Production Architecture (SECURE)

### Overview

```
┌─────────────────────────────────────────────────────────┐
│ Player 1 Browser                                         │
│  ├── Generate Secret1 (NEVER leaves browser) ✅         │
│  ├── Execute circuits locally ✅                        │
│  ├── Generate ZK proof ✅                               │
│  └── Submit proof to blockchain → Backend ✅            │
└─────────────────────────────────────────────────────────┘
                          ↓
                 Proof Submission
                          ↓
┌─────────────────────────────────────────────────────────┐
│ Backend (Server)                                         │
│  ├── Verify ZK proofs ✅                                │
│  ├── Update public game state ✅                        │
│  ├── NEVER access player secrets ✅                     │
│  └── witnesses throw errors if called ✅                │
└─────────────────────────────────────────────────────────┘
                          ↓
                 Proof Submission
                          ↓
┌─────────────────────────────────────────────────────────┐
│ Player 2 Browser                                         │
│  ├── Generate Secret2 (NEVER leaves browser) ✅         │
│  ├── Execute circuits locally ✅                        │
│  ├── Generate ZK proof ✅                               │
│  └── Submit proof to blockchain → Backend ✅            │
└─────────────────────────────────────────────────────────┘
```

### Implementation Changes Needed

#### 1. Frontend Takes Ownership of Circuit Execution

**File**: `packages/frontend/src/midnightBridge.ts`

**Current** (Correct, but not used):
```typescript
export const witnesses: Witnesses<PrivateState> = {
  player_secret_key: (context, _gameId, _player) => {
    // ✅ Generated in browser
    if (!privateState.playerSecretKey) {
      generatePlayerSecret();
    }
    return [context.privateState, privateState.playerSecretKey!];
  },
  // ...
};
```

**Needed**: Frontend must call these circuits directly:
```typescript
// Instead of calling backend API:
// await fetch('/api/midnight/apply_mask', { ... })

// Call circuit in browser:
const result = contract.impureCircuits.applyMask(
  circuitContext,
  gameId,
  BigInt(playerId)
);

// Submit proof to backend for verification
await fetch('/api/midnight/submit_proof', {
  method: 'POST',
  body: JSON.stringify({ proof: result.proof })
});
```

#### 2. Backend Becomes Proof Verifier Only

**File**: `packages/client/node/src/midnight-actions.ts`

**Change witnesses to throw errors**:
```typescript
const actionWitnesses: Witnesses<PrivateState> = {
  player_secret_key: (context, gameId, player) => {
    // ✅ Backend should NEVER access secrets
    throw new Error(
      'Backend must not access player secrets. ' +
      'Secrets are client-side only for zero-knowledge security.'
    );
  },

  shuffle_seed: (context, gameId, player) => {
    throw new Error('Shuffle seeds are client-side only.');
  },

  // ✅ These are OK - they don't use secrets
  getFieldInverse: (context, x) => { ... },
  split_field_bits: (context, f) => { ... },
  get_sorted_deck_witness: (context, input) => { ... },
};
```

**Replace action functions with proof verification**:
```typescript
export async function verifyAndApplyMask(
  lobbyId: string,
  playerId: 1 | 2,
  proof: Proof  // ✅ Proof generated client-side
): Promise<{ success: boolean; errorMessage?: string }> {
  try {
    // ✅ Verify proof (uses public inputs only, no secrets)
    const isValid = await verifyProof(proof);

    if (!isValid) {
      return { success: false, errorMessage: 'Invalid proof' };
    }

    // ✅ Update game state based on verified proof
    await updateGameState(lobbyId, playerId, proof.publicOutputs);

    return { success: true };
  } catch (error: any) {
    return { success: false, errorMessage: error.message };
  }
}
```

#### 3. Query-Only Backend Contract

**File**: `packages/client/node/src/midnight-query.ts`

This file is mostly correct - it only queries public state:

```typescript
export async function queryGamePhase(lobbyId: string) {
  // ✅ Read-only, no secrets needed
  const phase = await queryContract.circuits.getGamePhase(context, gameId);
  return Number(phase.result);
}
```

Keep as-is, but ensure witness functions throw errors if accidentally called.

### Migration Path

#### Phase 1: Testing (Current State)
- ⚠️ Backend generates secrets (INSECURE)
- ⚠️ Backend executes circuits
- ✅ Game functionality works
- ⚠️ Document security limitations

#### Phase 2: Hybrid (Transition)
- ⚠️ Backend still generates secrets (for backwards compatibility)
- ✅ Frontend CAN execute circuits (optional)
- ✅ Add proof verification endpoints
- ⚠️ Both modes supported

#### Phase 3: Production (Secure)
- ✅ Frontend MUST execute circuits
- ✅ Backend ONLY verifies proofs
- ✅ Backend witnesses throw errors
- ✅ Secrets never leave browser

## Security Comparison

### Current Implementation (Testing)
| Property | Status | Impact |
|----------|--------|--------|
| Server can see Player 1's cards | ❌ Yes | Critical security violation |
| Server can see Player 2's cards | ❌ Yes | Critical security violation |
| Players trust each other | ❌ No | But both trust server |
| Truly zero-knowledge | ❌ No | Server knows everything |
| Resistant to server compromise | ❌ No | All secrets revealed |
| Cryptographically provable fairness | ❌ No | Server can cheat |

### Production Implementation (Secure)
| Property | Status | Impact |
|----------|--------|--------|
| Server can see Player 1's cards | ✅ No | Cryptographically impossible |
| Server can see Player 2's cards | ✅ No | Cryptographically impossible |
| Players trust each other | ✅ No | Zero-knowledge proofs |
| Truly zero-knowledge | ✅ Yes | No trust required |
| Resistant to server compromise | ✅ Yes | Secrets never on server |
| Cryptographically provable fairness | ✅ Yes | Math guarantees |

## Reference Implementation

The [example.test.ts](packages/shared/contracts/midnight/example.test.ts) file demonstrates the correct pattern:

```typescript
// ✅ Secrets generated at the start (lines 24-28)
const keys = {
  player1: BigInt(Math.floor(Math.random() * 1000000)),
  player2: BigInt(Math.floor(Math.random() * 1000000)),
  shuffleSeed1: new Uint8Array(32).fill(Math.floor(Math.random() * 256)),
  shuffleSeed2: new Uint8Array(32).fill(Math.floor(Math.random() * 256)),
};

// ✅ Witness looks up pre-generated secret (lines 173-179)
player_secret_key: ({ privateState }, _gameId, playerIndex) => {
  return [privateState, getSecretKey(Number(playerIndex))];
}

// ✅ All circuits executed in the test (client-side simulation)
const r = impureCircuits.applyMask(sim.circuitContext, gameId, BigInt(1));
```

This is how the **frontend** should work in production.

## Action Items

### Immediate (Document Current State)
- ✅ Add security warnings to midnight-actions.ts
- ✅ Document that current implementation is testing-only
- ✅ Create this security architecture document

### Short-term (Enable Testing)
- [ ] Keep current backend-centric approach for development
- [ ] Add clear warnings in UI that this is not production-ready
- [ ] Test game functionality end-to-end

### Long-term (Production Migration)
- [ ] Implement client-side circuit execution in frontend
- [ ] Add proof submission endpoints to backend
- [ ] Add proof verification in backend
- [ ] Remove secret generation from backend
- [ ] Make backend witnesses throw errors
- [ ] Security audit before production deployment

## Conclusion

**Current State**: The implementation works but is **NOT SECURE** for production. The server can see all cards, violating the Mental Poker protocol's fundamental security guarantee.

**Path Forward**: Migrate to client-side circuit execution where player secrets never leave the browser. This requires significant refactoring but is essential for production deployment.

**Timeline**: Use current implementation for development/testing, but plan migration before any public deployment or real-money games.

## References

- Mental Poker Protocol: Shamir, Rivest, Adleman (1981)
- Midnight Compact Runtime: [@midnight-ntwrk/compact-runtime](https://www.npmjs.com/package/@midnight-ntwrk/compact-runtime)
- Zero-Knowledge Proofs: [ZK-SNARKs](https://z.cash/technology/zksnarks/)

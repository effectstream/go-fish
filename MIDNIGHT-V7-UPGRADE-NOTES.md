# Midnight SDK v3 (Ledger-v7) Upgrade Notes

Notes from upgrading the Go Fish deploy pipeline to Midnight SDK v3.
These are intended to help with the next step: getting the batcher and UI
working against the live deployed contract.

---

## Current State

- **Deploy script** (`packages/shared/contracts/midnight/deploy-ledger7.ts`) is fully
  upgraded and working against ledger-v7 / SDK v3.
- **Contract deployed** using a two-phase strategy (stripped deploy + individual VK inserts)
  to work around block size limits.
- **Batcher and frontend** have NOT been fully tested against the live contract yet.

---

## Key SDK v3 Breaking Changes

### 1. CompiledContract Wrapping

v3 requires a `CompiledContract` wrapper instead of raw contract classes:

```typescript
import { CompiledContract } from "@midnight-ntwrk/compact-js";

let compiled = CompiledContract.make(contractName, contractClass);
compiled = CompiledContract.withWitnesses(compiled, witnesses);
compiled = CompiledContract.withCompiledFileAssets(compiled, compiledAssetsPath);
```

Any code calling `findDeployedContract`, `deployContract`, or `createCallTx`
needs to pass `compiledContract` instead of the raw contract class.

### 2. WalletProvider Interface

**Old (v2):**
```typescript
balanceTransaction(tx) → BalancedTransaction
signTransaction(tx)    → SignedTransaction
```

**New (v3):**
```typescript
balanceTx(tx: UnboundTransaction, ttl?: Date) → FinalizedTransaction
getCoinPublicKey()       → CoinPublicKey
getEncryptionPublicKey() → EncPublicKey
```

The v3 `balanceTx` receives the output of `proveTx` (an `UnboundTransaction`)
and must return a `FinalizedTransaction`.

### 3. submitInsertVerifierKeyTx Signature

Added `compiledContract` as second parameter:

```typescript
// v2: submitInsertVerifierKeyTx(providers, address, circuitId, vk)
// v3: submitInsertVerifierKeyTx(providers, compiledContract, address, circuitId, vk)
```

### 4. NodeZkConfigProvider — Prototype Methods

`NodeZkConfigProvider` methods (`getVerifierKey`, `getProverKey`, etc.) are on
the **prototype**, not own enumerable properties. Never use `{...provider}` spread
to copy/wrap it — explicitly delegate each method.

---

## Gotcha: Intent Proof Marker Deserialization

This is the most subtle bug we hit and it will affect any code that goes through
the `proveTx → balanceTx` pipeline.

**Root cause:** The wallet SDK's unshielded wallet (`TransactionOps.addSignature`)
clones intents by serializing and deserializing with hardcoded markers:

```javascript
Intent.deserialize('signature', 'pre-proof', 'pre-binding', intent.serialize())
```

After `proveTx()`, intents have `'proof'` markers (not `'pre-proof'`), so the
deserialization fails with:

```
Unable to deserialize Intent. Error: expected header tag
'midnight:intent[v6](signature[v1],proof-preimage,embedded-fr[v1]):',
got 'midnight:intent[v6](signature[v1],proof,embedded-fr[v1]):'
```

**Fix in the deploy script:** The `balanceTx` adapter signs only the balancing
transaction (which is still unproven), not the base proven transaction:

```typescript
async balanceTx(tx, ttl?) {
  const recipe = await wallet.balanceUnboundTransaction(tx, secretKeys, { ttl });

  if (recipe.balancingTransaction) {
    // Sign only the balancing tx, NOT the base (proven) tx
    const signed = await wallet.signUnprovenTransaction(
      recipe.balancingTransaction, signFn);
    return wallet.finalizeRecipe({ ...recipe, balancingTransaction: signed });
  }
  return wallet.finalizeRecipe(recipe);
}
```

**Impact on batcher/frontend:** Any `WalletProvider` adapter that calls
`wallet.signRecipe()` or `wallet.signUnboundTransaction()` on a proven
transaction will hit this same error. The batcher's `MidnightAdapter` and
the frontend's `MidnightOnChainService` both need the same workaround if
they implement `balanceTx`.

---

## Gotcha: Block Size Limits for Large Contracts

The Go Fish contract has **30 circuits** with verifier keys. Deploying all VKs
in a single transaction exceeds Midnight's block size limit:

```
exceeded block limit in transaction fee computation
```

**Solution used:** Two-phase deploy:
1. Deploy with a **stripped `ContractState`** (only `data` + `maintenanceAuthority`, no operations)
2. Insert each VK individually via `submitInsertVerifierKeyTx` (30 separate txs)

The stripped deploy bypasses `submitTx`/`proveTx` entirely (no proofs needed)
and uses `wallet.balanceUnprovenTransaction()` directly.

This shouldn't affect the batcher or frontend (they interact with an
already-deployed contract), but it's good to know the contract state on-chain
initially had no operations until all 30 VK inserts completed.

---

## Gotcha: Contract Address Format

The deployed contract address is a 32-byte hex string. The compact-runtime
(v0.14.0) and ledger-v7 both use `ContractAddress = string`. The frontend
has address normalization code that pads 32-byte addresses to 34 bytes with
`0000` prefix — verify this still works correctly with v3.

---

## Architecture Overview for Debugging

### Three Ways to Interact with the Contract

1. **Lace Wallet (frontend direct)**
   - `MidnightOnChainService.ts` → `findDeployedContract()` → `callTx.<circuit>()`
   - Lace handles proving, balancing, signing, submitting
   - Needs: Lace wallet extension installed

2. **Batcher Mode (frontend via HTTP)**
   - `BatcherMidnightService.ts` → `POST /send-input` → batcher
   - Batcher's `GoFishMidnightAdapter` generates proofs, handles secrets
   - Batcher uses its own wallet for fees
   - Frontend is wallet-less in this mode

3. **Deploy Script (one-time setup)**
   - `deploy.ts` → `deploy-ledger7.ts` → direct wallet SDK calls
   - Only runs once to deploy the contract

### Batcher-Specific Concerns

The custom `GoFishMidnightAdapter` (`packages/client/batcher/src/adapter-midnight.ts`):
- Extracts `playerSecret` and `shuffleSeed` from the circuit call payload
- Sets them as **dynamic witnesses** before proof generation
- Clears secrets after proof generation
- Has retry logic for WASM unreachable errors (max 5 retries, 15s intervals)
- Notifies the backend on setup circuit success (`mask_applied`, `dealt_complete`)

The batcher likely needs its own `WalletProvider` adapter with the same
intent-signing workaround described above.

### Contract Circuits (29 total)

**Setup phase** (called during game initialization):
- `init_deck` — initialize static deck mappings
- `applyMask` — apply player's mask to deck
- `dealCards` — deal 4 cards to opponent

**Gameplay** (called during turns):
- `askForCard`, `respondToAsk`, `goFish`, `afterGoFish`
- `partial_decryption`, `doesPlayerHaveCard`, `doesPlayerHaveSpecificCard`
- `switchTurn`, `checkAndScoreBook`, `checkAndEndGame`

**Queries** (read-only state checks):
- `getGamePhase`, `getCurrentTurn`, `getScores`, `getHandSizes`
- `get_deck_size`, `getLastAskedRank`, `getLastAskingPlayer`
- `hasMaskApplied`, `hasDealt`, `getCardsDealt`, `doesGameExist`
- `isDeckEmpty`, `isGameOver`, `get_top_card_index`, `get_card_from_point`
- `get_player_hand_size`

---

## Wallet SDK Facade API Quick Reference

The `wallet-sdk-facade@1.0.0` `WalletFacade` interface:

```typescript
// Balance methods (three flavors for different tx stages)
balanceUnprovenTransaction(tx, secretKeys, { ttl })  → UnprovenTransactionRecipe
balanceUnboundTransaction(tx, secretKeys, { ttl })   → UnboundTransactionRecipe
balanceFinalizedTransaction(tx, secretKeys, { ttl }) → FinalizedTransactionRecipe

// Signing & finalizing
signRecipe(recipe, signFn)        → BalancingRecipe  // WARNING: may fail on proven txs
signUnprovenTransaction(tx, signFn) → UnprovenTransaction  // Safe for unproven txs
finalizeRecipe(recipe)            → FinalizedTransaction
finalizeTransaction(tx)           → FinalizedTransaction  // For unproven txs

// Submission
submitTransaction(tx) → TransactionId
```

**Choose the right balance method:**
- `balanceUnprovenTransaction` — for transactions you built yourself (not yet proven)
- `balanceUnboundTransaction` — for transactions from `proveTx()` (proven but not bound)
- `balanceFinalizedTransaction` — for already-finalized transactions needing fee adjustment

---

## Files Changed in the Upgrade

| File | Change |
|------|--------|
| `packages/shared/contracts/midnight/deploy-ledger7.ts` | New file (renamed from deploy-ledger6.ts). Full v3 deploy with stripped-state strategy. |
| `packages/shared/contracts/midnight/deploy.ts` | Updated import path to `deploy-ledger7.ts` |
| `packages/shared/contracts/midnight/faucet.ts` | Updated for `wallet-sdk-facade@1.0.0` API (previous session) |

---

## Next Steps

1. **Test batcher mode end-to-end** — Start the full stack (node, indexer, proof
   server, batcher) and verify circuit calls work through the batcher
2. **Fix batcher's WalletProvider adapter** — Apply the intent-signing workaround
   if the batcher creates its own `balanceTx` implementation
3. **Test frontend in batcher mode** — Verify `BatcherMidnightService` can submit
   circuit calls and the game flow works
4. **Test frontend in Lace mode** — If using Lace wallet, verify `findDeployedContract`
   works with the `CompiledContract` wrapper
5. **Verify contract address normalization** — Check that 32-byte addresses from
   `ContractDeploy.address` work with the frontend's normalization logic

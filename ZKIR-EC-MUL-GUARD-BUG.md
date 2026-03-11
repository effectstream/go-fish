# ZKIR ec_mul Guard Bug — Root Cause, Detection, and Fix

## Summary

Any Compact circuit that calls `std_ecMul` (directly or via a function that does) inside an
`if/else` branch will cause the Midnight proof server to panic with:

```
assertion 'left == right' failed: Point should be part of the subgroup
  left: 0
 right: 1
```

This manifests as an HTTP 500 from the proof server's `/check` endpoint and is fatal — the
transaction can never succeed regardless of retries.

---

## Root Cause

### How ZKIR compiles Compact `if/else`

The Compact compiler emits `public_input` ops to read values from the public transcript into
ZKIR variable slots. When a value is read inside an `if/else` branch that depends on a runtime
condition, the compiler wraps it with a guard:

```
public_input { guard: 42 }   // reads the value only when var42 ≠ 0
```

When the guard is **false** (the branch is inactive), the `public_input` op produces **zero**
for that variable slot instead of a real transcript value.

### Why `ec_mul` panics

`ec_mul` has **no guard parameter** in ZKIR v2 — it always evaluates unconditionally. The proof
server's `preprocess` step validates that each `ec_mul` base point `(a_x, a_y)` is a valid point
on the JubJub elliptic curve subgroup before generating a proof.

`(0, 0)` is not a valid JubJub subgroup point. When a guarded `public_input` feeds zero into
an `ec_mul`'s `a_x`/`a_y` slots, `EmbeddedGroupAffine::new(0, 0)` panics.

### The deadly combination

```compact
// UNSAFE — both branches contain ec_mul
if (playerId == 1) {
    const [secret1, _] = deck_getSecretFromPlayerId(gid, 1);
    const card = std_ecMul(baseCard, secret1);   // ← guarded when playerId ≠ 1
    ...
} else if (playerId == 2) {
    const [secret2, _] = deck_getSecretFromPlayerId(gid, 2);
    const card = std_ecMul(baseCard, secret2);   // ← guarded when playerId ≠ 2
    ...
}
```

When `playerId == 1`:
- The `if` branch is active — its `ec_mul` inputs are valid.
- The `else if` branch is **inactive** — its `ec_mul` receives `(0, 0)` → **panic**.

When `playerId == 2`:
- The `else if` branch is active — its `ec_mul` inputs are valid.
- The `if` branch is **inactive** — its `ec_mul` receives `(0, 0)` → **panic**.

Both player IDs panic. The circuit is always broken.

### Propagation through call chains

The guard propagates transitively. If a function `A` calls function `B` inside a branch, and
`B` internally calls `std_ecMul`, the `ec_mul` in `B` is also guarded. The entire call chain
must be unconditional for the circuit to work:

```
dealCards
  └─ dealCard (inside if/else)           ← old bug
       └─ getTopCardForOpponent
            └─ deck_getTopCard
                 └─ partial_decryption
                      └─ std_ecMul       ← receives (0,0) → panic
```

---

## Detection Method

After compiling with `deno task compact`, check each generated ZKIR file for the combination
of `ec_mul` and non-null guarded `public_input` ops:

```bash
for zkir in src/managed/zkir/*.zkir; do
  name=$(basename "$zkir" .zkir)
  ec_muls=$(grep -c "ec_mul" "$zkir")
  guarded=$(grep -c 'public_input { guard: [^n]' "$zkir")
  if [ "$ec_muls" -gt 0 ] && [ "$guarded" -gt 0 ]; then
    echo "⚠️  $name: UNSAFE — $ec_muls ec_muls, $guarded guarded public_inputs"
  else
    echo "✅ $name"
  fi
done
```

A circuit with **both** `ec_mul` entries and non-null guarded `public_input` entries will panic
on the inactive branch. A circuit with only `public_input { guard: null }` (unconditional reads)
feeding `ec_mul` is safe.

---

## The Fix Pattern

**Never put `std_ecMul` (or any function containing it) inside a Compact `if/else`.**

Instead:
1. Fetch all player secrets **unconditionally** (outside any branch).
2. Use a **ternary** (`? :`) to select the right secret — this compiles to a `cond_select` op
   in ZKIR, which is a safe multiplexer with no curve point validation.
3. Call `std_ecMul` **once**, unconditionally, with the selected scalar.

```compact
// SAFE — ec_mul is unconditional
const [secret1, _inv1] = deck_getSecretFromPlayerId(gid, 1);
const [secret2, _inv2] = deck_getSecretFromPlayerId(gid, 2);
const secret: Field = (playerId == 1 as Uint<64>) ? secret1 : secret2;  // cond_select

const card = std_ecMul(baseCard, secret);   // ← always unconditional, always a valid point
```

### Call-chain rule

Any function containing `std_ecMul` must itself be called unconditionally. If the calling
circuit needs to vary *which* player's mask to apply, compute the player ID with a ternary
first, then call the function once:

```compact
// SAFE — the call is unconditional, only the scalar input varies
const maskerPlayerId: Uint<64> = (toPlayerId == 1 as Uint<64>) ? 2 as Uint<64> : 1 as Uint<64>;
const card = deck_getTopCard(gid, maskerPlayerId);  // ← unconditional call
```

---

## Circuits Fixed in This Codebase

All fixes follow the same pattern: fetch both secrets unconditionally, select with ternary,
call `ec_mul` once outside any branch.

| Circuit | Problem | Fix |
|---------|---------|-----|
| `dealCards` | 4-card dealing loop inside `if (playersDealt==0 && playerId==1)` — entire `ec_mul` chain guarded | Moved loop outside the ordering `if/else`; ordering enforced by assertions only |
| `getTopCard` (Deck) | Redundant `if/else` where both branches called `partial_decryption` identically | Removed `if/else`, single unconditional call |
| `getTopCardForOpponent` | Called `deck_getTopCard` inside `if (toPlayerId==1) / else` — guarded `ec_mul` | Computed `maskerPlayerId` with ternary, called `deck_getTopCard` unconditionally |
| `countCardsOfRank` | `if (playerId==1) { ec_mul } else if (playerId==2) { ec_mul }` | Both secrets fetched unconditionally; ternary selects secret; one `ec_mul` |
| `checkAndScoreBook` | Same nested `if/else` with `ec_mul` on each player branch | Same fix |
| `doesPlayerHaveSpecificCard` | Same `if/else` structure | Same fix |

---

## Invariant to Maintain

> **Every `ec_mul` in every compiled ZKIR must have `public_input { guard: null }` feeding
> its `a_x` and `a_y` inputs — never a guarded `public_input { guard: N }` for any `N`.**

Run the detection script above after every `deno task compact` to verify this invariant holds.
If any circuit shows both `ec_mul` and non-null guarded `public_input`, find the `if/else`
containing the `ec_mul` call chain and apply the ternary-select fix.

---

## Why This Is Hard to Spot in Source

- The Compact source looks reasonable — branching on player ID is a natural pattern.
- The compiler does not warn about this. It generates valid ZKIR; the problem is a runtime
  property of the proof server's preprocess step.
- The error message (`Point should be part of the subgroup`) gives no indication of which
  circuit, which branch, or which variable is at fault.
- Both player IDs panic (each has an inactive branch), so the circuit is never reachable.
- The only diagnostic path is: proof server 500 → backtrace → `EmbeddedGroupAffine::new` →
  trace ZKIR variable assignments → find the guarded `public_input` feeding the `ec_mul`.

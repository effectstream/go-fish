# Midnight SDK Lazy Loading Fix

**Date**: 2026-01-15
**Issue**: Midnight SDK dependencies causing module loading errors at app startup
**Solution**: Lazy loading to isolate Midnight SDK and prevent blocking app initialization

---

## Problem

The Midnight SDK has complex dependencies that don't fully work with Vite's ESM-first approach:
1. **WASM modules** - Requires special handling
2. **Mixed CommonJS/ESM** - Some dependencies like `object-inspect` are CommonJS
3. **Deep dependency chain** - Multiple layers of module resolution

**Error Messages**:
```
"ESM integration proposal for Wasm" is not supported currently
SyntaxError: The requested module 'object-inspect@1.13.4' doesn't provide an export named: 'default'
NS_ERROR_CORRUPTED_CONTENT
```

## Solution

Convert all Midnight SDK imports to **lazy loading** using dynamic `import()` statements. This:
- ✅ Allows app to start successfully
- ✅ Loads Midnight SDK only when needed
- ✅ Gracefully handles SDK loading failures
- ✅ Doesn't block core game functionality

## Changes Made

### 1. Main App Entry Point
**File**: [packages/frontend/src/main.ts](packages/frontend/src/main.ts:37-56)

**Before**:
```typescript
import { MidnightBridge } from './midnightBridge';

private async init() {
  await this.gameManager.init();
  await MidnightBridge.initializeMidnightContract();
}
```

**After**:
```typescript
// No import at top of file

private async init() {
  // Initialize core game first
  await this.gameManager.init();
  console.log('Go Fish Game initialized successfully');

  // Try to load Midnight SDK (optional)
  this.initializeMidnight();
}

private async initializeMidnight() {
  try {
    console.log('Initializing Midnight contract...');

    // Lazy load Midnight bridge
    const { MidnightBridge } = await import('./midnightBridge');

    const result = await MidnightBridge.initializeMidnightContract();
    if (result.success) {
      console.log('✓ Midnight contract initialized');
    } else {
      console.warn('⚠ Midnight initialization failed:', result.errorMessage);
    }
  } catch (error) {
    console.error('⚠ Failed to load Midnight SDK:', error);
    console.warn('  Game will continue without Midnight features');
  }
}
```

### 2. GameScreen Component
**File**: [packages/frontend/src/screens/GameScreen.ts](packages/frontend/src/screens/GameScreen.ts:10-23)

**Before**:
```typescript
import { MidnightBridge } from '../midnightBridge';

// Later in code:
const result = await MidnightBridge.askForCard(...);
```

**After**:
```typescript
// Lazy load helper at top of file
let MidnightBridge: any = null;
async function getMidnightBridge() {
  if (!MidnightBridge) {
    try {
      const module = await import('../midnightBridge');
      MidnightBridge = module.MidnightBridge;
    } catch (error) {
      console.error('[GameScreen] Failed to load MidnightBridge:', error);
      return null;
    }
  }
  return MidnightBridge;
}

// Later in code:
const bridge = await getMidnightBridge();
if (!bridge) {
  alert('Midnight contract not available. Please refresh the page.');
  return;
}
const result = await bridge.askForCard(...);
```

### 3. Vite Configuration
**File**: [packages/frontend/vite.config.ts](packages/frontend/vite.config.ts)

Added plugins and configuration for WASM handling:

```typescript
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';

export default defineConfig({
  plugins: [
    wasm(),                    // Handle WASM imports
    topLevelAwait(),           // Support top-level await (for WASM init)
    nodePolyfills({
      include: ['buffer', 'process'],
    }),
  ],
  optimizeDeps: {
    // Don't pre-bundle Midnight packages
    exclude: ['@midnight-ntwrk/onchain-runtime-v1', '@midnight-ntwrk/compact-runtime'],
  },
  assetsInclude: ['**/*.wasm'],
  worker: {
    format: 'es',
  },
});
```

## Expected Behavior

### On App Startup:
```
✅ Initializing Go Fish Game...
✅ Go Fish Game initialized successfully
⏳ Initializing Midnight contract...
```

Then either:
```
✅ ✓ Midnight contract initialized
```

OR (if Midnight SDK fails):
```
⚠ Failed to load Midnight SDK: [error details]
⚠ Game will continue without Midnight features
⚠ This is expected if Midnight dependencies are not fully configured
```

### On User Action (Ask for Card / Go Fish):
- If Midnight loaded successfully: Action works normally
- If Midnight failed to load: User sees: "Midnight contract not available. Please refresh the page."

## Testing

1. **Start the frontend dev server**:
   ```bash
   cd packages/frontend
   npm run dev
   ```

2. **Check browser console** for initialization messages

3. **Test game actions**:
   - Create/join lobby (should work regardless of Midnight)
   - Try "Ask for Card" button (requires Midnight)
   - Try "Go Fish" button (requires Midnight)

## Benefits

1. **Non-blocking**: App starts even if Midnight SDK has issues
2. **Graceful degradation**: Clear error messages for users
3. **Developer-friendly**: Can work on game UI without fixing Midnight issues
4. **Production-ready**: App continues to function if Midnight network is down

## Limitations

1. **Midnight features unavailable** if SDK fails to load
2. **Users must refresh** if they want to retry Midnight initialization
3. **No auto-retry** - manual refresh required

## Future Improvements

1. **Add retry logic** - Attempt to load Midnight SDK multiple times
2. **Show UI indicator** - Display Midnight connection status in game UI
3. **Alternative backend** - Fall back to EVM-only gameplay if Midnight unavailable
4. **Better error messages** - Distinguish between network issues, dependency issues, and contract errors

## Related Documentation

- [README_MIDNIGHT.md](README_MIDNIGHT.md) - Midnight integration overview
- [INTEGRATION_REVIEW.md](INTEGRATION_REVIEW.md) - Technical integration review
- [INTEGRATION_COMPLETE.md](INTEGRATION_COMPLETE.md) - Implementation details

---

**Status**: ✅ Lazy loading implemented, app should start successfully

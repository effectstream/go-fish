/**
 * Shim to provide compatibility between compact-runtime 0.11.0 and midnight-js v2.0.0
 *
 * midnight-js v2.0.0 imports `constructorContext` from compact-runtime
 * compact-runtime 0.11.0 exports `createConstructorContext` instead
 *
 * This shim re-exports the renamed function with the old name.
 *
 * IMPORTANT: We use the direct path to avoid circular imports since
 * Vite aliases @midnight-ntwrk/compact-runtime to this shim file.
 */

// Re-export everything from compact-runtime using direct node_modules path
export * from '../node_modules/@midnight-ntwrk/compact-runtime/dist/index.js';

// Import the new function and re-export with the old name
import { createConstructorContext } from '../node_modules/@midnight-ntwrk/compact-runtime/dist/index.js';
export const constructorContext = createConstructorContext;

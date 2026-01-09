/**
 * Testnet entry point for Paima Engine node
 */

import { initPaima } from '@paimaexample/runtime';
import { stateMachineDefinition } from './state-machine.ts';
import { createRouter } from './api.game.ts';
import config from '@werewolf/data-types/config.testnet.ts';

const PORT = 9999;

async function main() {
  console.log('Starting Werewolf Game - Paima Engine (Testnet Mode)');
  console.log(`API Server will run on port ${PORT}`);

  try {
    // Initialize Paima Engine
    await initPaima({
      config,
      stateMachine: stateMachineDefinition,
      apiRouter: createRouter,
      port: PORT,
    });

    console.log('✓ Paima Engine initialized successfully');
    console.log(`✓ API available at http://localhost:${PORT}`);
  } catch (error) {
    console.error('Failed to initialize Paima Engine:', error);
    Deno.exit(1);
  }
}

main();

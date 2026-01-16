/**
 * Testnet entry point for Paima Engine node
 */

import { initPaima } from '@paimaexample/runtime';
import { stateMachineDefinition } from './state-machine.ts';
import { apiRouter } from './api.ts';
import config from '@go-fish/data-types/config.testnet.ts';
import { initializeQueryContract } from './midnight-query.ts';

const PORT = 9999;

async function main() {
  console.log('Starting Go Fish Game - Paima Engine (Testnet Mode)');
  console.log(`API Server will run on port ${PORT}`);

  // Initialize Midnight query contract
  try {
    await initializeQueryContract();
    console.log('✓ Midnight query contract initialized');
  } catch (error) {
    console.error('⚠ Failed to initialize Midnight query contract:', error);
    console.error('  Game state queries will return fallback values');
  }

  try {
    // Initialize Paima Engine
    await initPaima({
      config,
      stateMachine: stateMachineDefinition,
      apiRouter: apiRouter,
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

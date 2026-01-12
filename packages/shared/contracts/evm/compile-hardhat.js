#!/usr/bin/env node
/**
 * Compile contracts using Hardhat via Node.js (not Deno)
 * This works around the Deno compatibility issues with Hardhat 3.0.4
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const execAsync = promisify(exec);

async function compile() {
  try {
    console.log('Compiling with Hardhat via Node.js...');
    const { stdout, stderr } = await execAsync('npx hardhat@3.0.4 compile', {
      cwd: __dirname
    });

    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);

    console.log('✓ Hardhat compilation complete');
  } catch (error) {
    console.error('Hardhat compilation failed:', error.message);
    process.exit(1);
  }
}

compile();

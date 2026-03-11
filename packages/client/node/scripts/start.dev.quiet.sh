#!/bin/sh
# Runs start.dev.ts with noisy infrastructure logs filtered out.
# Filters: hardhat-evmMain, hardhat-evmParallel, effectstream-sync-block-merge, effectstream-sync
QUIET_LOGS=true \
EFFECTSTREAM_ENV=dev \
EFFECTSTREAM_API_PORT=9996 \
NODE_ENV=development \
deno run -A --unstable-raw-imports "$(dirname "$0")/start.dev.ts" 2>&1 \
  | grep -v -E '(hardhat-evmMain|hardhat-evmParallel|effectstream-sync-block-merge|effectstream-sync)'

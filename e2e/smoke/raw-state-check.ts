/**
 * Direct raw check: fetch contract state from the indexer via GraphQL,
 * deserialize with ContractState, and evaluate doesGameExist + hasMaskApplied
 * for a known lobbyId. Bypasses all middleware (Apollo, indexerPublicDataProvider,
 * WS cache, etc.) to verify the raw data path works.
 *
 * Run: deno run -A --no-check --unstable-raw-imports e2e/smoke/raw-state-check.ts <lobbyId>
 */

import { ContractState, QueryContext, CostModel, sampleContractAddress, createConstructorContext } from "@midnight-ntwrk/compact-runtime";
import { Contract as GoFishContract } from "@go-fish/midnight-contract/contract";
import { witnesses } from "@go-fish/midnight-contract";

const INDEXER_URL = "http://127.0.0.1:8088/api/v3/graphql";
const CONTRACT_ADDRESS = JSON.parse(
  Deno.readTextFileSync("packages/shared/contracts/midnight/go-fish-contract.undeployed.json")
).contractAddress;

const lobbyId = Deno.args[0];
if (!lobbyId) {
  console.error("Usage: deno run -A --no-check --unstable-raw-imports e2e/smoke/raw-state-check.ts <lobbyId>");
  Deno.exit(1);
}

function lobbyIdToGameId(lobbyId: string): Uint8Array {
  const enc = new TextEncoder().encode(lobbyId);
  const g = new Uint8Array(32);
  g.set(enc.slice(0, 32));
  return g;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

async function main() {
  console.log(`Contract: ${CONTRACT_ADDRESS}`);
  console.log(`Lobby: ${lobbyId}`);
  const gameId = lobbyIdToGameId(lobbyId);
  console.log(`GameId hex: 0x${Array.from(gameId).map(b => b.toString(16).padStart(2, "0")).join("")}`);

  // 1. Fetch raw state from indexer via GraphQL
  console.log(`\nFetching state from ${INDEXER_URL}...`);
  const resp = await fetch(INDEXER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `{ contractAction(address: "${CONTRACT_ADDRESS}") { ... on ContractCall { state } ... on ContractDeploy { state } } }`,
    }),
  });
  const data = await resp.json();
  const stateHex = data.data?.contractAction?.state;
  if (!stateHex) {
    console.error("No state returned by indexer");
    Deno.exit(1);
  }
  console.log(`State: ${stateHex.length / 2} bytes`);

  // 2. Deserialize into ContractState
  const bytes = hexToBytes(stateHex);
  const contractState = ContractState.deserialize(bytes);
  console.log(`ContractState deserialized OK`);

  // 3. Build local contract + QueryContext
  const localContract: any = new GoFishContract(witnesses as any);
  const init = localContract.initialState(createConstructorContext({}, "0".repeat(64)));
  const ctx = {
    currentPrivateState: init.currentPrivateState,
    currentZswapLocalState: init.currentZswapLocalState,
    currentQueryContext: new QueryContext(contractState.data, sampleContractAddress()),
    costModel: CostModel.initialCostModel(),
  };

  // 4. Evaluate circuits
  console.log(`\n=== Circuit evaluation for ${lobbyId} ===`);

  try {
    const existsResult = localContract.impureCircuits.doesGameExist(ctx, gameId);
    console.log(`doesGameExist: ${existsResult.result}`);
  } catch (e: any) {
    console.log(`doesGameExist: ERROR — ${e.message}`);
  }

  try {
    const mask1Result = localContract.impureCircuits.hasMaskApplied(ctx, gameId, 1n);
    console.log(`hasMaskApplied(P1): ${mask1Result.result}`);
  } catch (e: any) {
    console.log(`hasMaskApplied(P1): ERROR — ${e.message}`);
  }

  try {
    const mask2Result = localContract.impureCircuits.hasMaskApplied(ctx, gameId, 2n);
    console.log(`hasMaskApplied(P2): ${mask2Result.result}`);
  } catch (e: any) {
    console.log(`hasMaskApplied(P2): ERROR — ${e.message}`);
  }

  try {
    const dealt1Result = localContract.impureCircuits.hasDealt(ctx, gameId, 1n);
    console.log(`hasDealt(P1): ${dealt1Result.result}`);
  } catch (e: any) {
    console.log(`hasDealt(P1): ERROR — ${e.message}`);
  }

  try {
    const dealt2Result = localContract.impureCircuits.hasDealt(ctx, gameId, 2n);
    console.log(`hasDealt(P2): ${dealt2Result.result}`);
  } catch (e: any) {
    console.log(`hasDealt(P2): ERROR — ${e.message}`);
  }

  try {
    const phaseResult = localContract.impureCircuits.getGamePhase(ctx, gameId);
    console.log(`getGamePhase: ${phaseResult.result}`);
  } catch (e: any) {
    console.log(`getGamePhase: ERROR — ${e.message}`);
  }

  try {
    const handsResult = localContract.impureCircuits.getHandSizes(ctx, gameId);
    console.log(`getHandSizes: [${handsResult.result[0]}, ${handsResult.result[1]}]`);
  } catch (e: any) {
    console.log(`getHandSizes: ERROR — ${e.message}`);
  }
}

main();

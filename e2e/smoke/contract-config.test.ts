/**
 * Step 2 smoke test — filesystem loading for contract address + ZK keys.
 *
 * Verifies we can:
 *   1. Read the deployed contract address from
 *      packages/shared/contracts/midnight/go-fish-contract.undeployed.json
 *   2. Instantiate NodeZkConfigProvider against src/managed/
 *   3. Actually load prover/verifier/zkir for a real circuit — exercises the
 *      path resolution that Step 1 couldn't.
 *
 * No external services required. Must be run from the repo root (or set
 * GO_FISH_REPO_ROOT).
 *
 * Run: deno task --filter @go-fish/e2e smoke:config
 */

import { assertEquals, assertExists } from "jsr:@std/assert";
import { resolve } from "jsr:@std/path";
import { NodeZkConfigProvider } from "@midnight-ntwrk/midnight-js-node-zk-config-provider";

const REPO_ROOT = Deno.env.get("GO_FISH_REPO_ROOT") ?? Deno.cwd().replace(/\/e2e\/?$/, "");

const CONTRACT_ADDRESS_FILE = resolve(
  REPO_ROOT,
  "packages/shared/contracts/midnight/go-fish-contract.undeployed.json",
);

const ZK_CONFIG_PATH = resolve(
  REPO_ROOT,
  "packages/shared/contracts/midnight/go-fish-contract/src/managed",
);

// Known circuits the full test exercises. If these don't load, nothing will.
// Note: no separate `goFish` circuit exists — respondToAsk handles the draw
// automatically and transitions phase to WaitForDrawCheck, which afterGoFish
// then resolves. afterGoFish(gameId, playerId, now) — contract v3 signature.
//
// Contract V3: `checkAndScoreBook` was removed — book scoring happens inline
// inside respondToAsk / afterGoFish, plus the one-shot post-deal scan via
// `scoreInitialBooks`. Book state is read via `getBookedRanks` /
// `hasInitialBooksScored`.
const CIRCUITS = [
  "init_deck",
  "applyMask",
  "dealCards",
  "askForCard",
  "respondToAsk",
  "afterGoFish",
  "scoreInitialBooks",
  "getBookedRanks",
  "hasInitialBooksScored",
  "discoverHand",
  "doesPlayerHaveSpecificCard",  // used for local hand reads via provableCircuits
] as const;

function loadContractAddress(): string {
  const raw = Deno.readTextFileSync(CONTRACT_ADDRESS_FILE);
  const parsed = JSON.parse(raw);
  if (typeof parsed.contractAddress !== "string") {
    throw new Error(`contractAddress missing from ${CONTRACT_ADDRESS_FILE}`);
  }
  // compact-runtime 0.14+ expects raw 64-hex without 0x prefix
  return parsed.contractAddress.replace(/^0x/, "");
}

Deno.test("contract address loads from .undeployed.json", () => {
  const addr = loadContractAddress();
  assertEquals(addr.length, 64, `expected 64 hex chars, got ${addr.length}`);
  if (!/^[0-9a-f]{64}$/i.test(addr)) {
    throw new Error(`not valid hex: ${addr}`);
  }
  console.log(`  contractAddress = ${addr}`);
});

Deno.test("NodeZkConfigProvider loads prover/verifier/zkir for all circuits", async () => {
  const provider = new NodeZkConfigProvider<typeof CIRCUITS[number]>(ZK_CONFIG_PATH);
  console.log(`  ZK config path = ${ZK_CONFIG_PATH}`);

  for (const circuit of CIRCUITS) {
    const [proverKey, verifierKey, zkir] = await Promise.all([
      provider.getProverKey(circuit),
      provider.getVerifierKey(circuit),
      provider.getZKIR(circuit),
    ]);
    assertExists(proverKey, `${circuit} prover key`);
    assertExists(verifierKey, `${circuit} verifier key`);
    assertExists(zkir, `${circuit} ZKIR`);
    console.log(`  ${circuit.padEnd(20)} prover=${proverKey.length}B verifier=${verifierKey.length}B zkir=${zkir.length}B`);
  }
});

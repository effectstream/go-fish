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
//
// Contract V3.3 flow summary:
//   - Normal ask: askForCard → respondToAsk → { afterGoFish | checkAndScoreBook }
//     (respondToAsk no longer inlines asker-side book scoring — V3.1 fix.
//      afterGoFish still auto-books the drawn rank; checkAndScoreBook is
//      the asker's follow-up after a successful transfer.)
//   - Empty-hand + deck has cards: requestToDrawCard → drawCard (no afterGoFish)
//   - Empty-hand + empty deck:     skipTurn, then checkAndEndGame to detect stalemate
//   - `scoreInitialBooks` is OPTIONAL — no longer gates the first askForCard.
const CIRCUITS = [
  "init_deck",
  "applyMask",
  "dealCards",
  "askForCard",
  "respondToAsk",
  "afterGoFish",
  "checkAndScoreBook",       // V3.1 restored — asker's post-transfer follow-up
  "scoreInitialBooks",       // V3 added, V3.3 optional
  "requestToDrawCard",       // V3.3 new — empty-hand, deck has cards
  "drawCard",                // V3.3 new — opponent of requestToDrawCard caller
  "skipTurn",                // V3.3 new — empty-hand, deck empty
  "checkAndEndGame",         // V3.3 client-invoked after skipTurn to detect stalemate
  "isDeckEmpty",             // V3.3 client-side branch condition for empty hand
  "getBookedRanks",
  "hasInitialBooksScored",
  "discoverHand",
  "doesPlayerHaveSpecificCard",  // used for local hand reads via provableCircuits
  // V4 admin / cleanup
  "initialize",              // V4 new — one-shot owner bootstrap
  "getOwner",                // V4 new — read owner hash (for admin UI gating)
  "isOwner",                 // V4 new — witness-based owner check (safe pre-init, returns false)
  "cleanupGame",             // V4 new — drops per-game ledger state (owner or participant@GameOver)
  "concede",                 // V4 re-exported — graceful game ending
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

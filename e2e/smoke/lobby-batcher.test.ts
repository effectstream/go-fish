/**
 * Step 4 smoke test — lobby POST to batcher (effectstreaml2, signed).
 *
 * Verifies we can:
 *   1. Build the batcher message with createMessageForBatcher (ported from
 *      paima-engine's packages/effectstream-sdk/concise/src/batcher.ts)
 *   2. Sign it with an ethers Wallet using a Hardhat key
 *   3. POST to ${BATCHER_URL}/send-input with target="effectstreaml2"
 *   4. Poll GET ${API_URL}/user_lobbies until the new lobby appears
 *
 * PREREQS:
 *   - Hardhat running (:8545)
 *   - Paima node running (:9996)
 *   - Batcher running (default :3336 — matches the repo config, not the
 *     upstream default of 3334)
 *
 * Run: deno task --filter @go-fish/e2e smoke:lobby
 */

import { assertEquals, assertExists } from "jsr:@std/assert";
import { ethers } from "ethers";
import { generateStmInput } from "@paimaexample/concise";
import { grammar } from "@go-fish/data-types";

const BATCHER_URL = Deno.env.get("BATCHER_URL") ?? "http://localhost:3336";
const API_URL = Deno.env.get("API_URL") ?? "http://localhost:9996";
const EVM_RPC_URL = Deno.env.get("EVM_RPC_URL") ?? "http://localhost:8545";

// Hardhat test account #1 (account #0 is typically the deployer)
const HARDHAT_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

// AddressType 0 = EVM. Matches paima-engine's CryptoManager registry.
const ADDRESS_TYPE_EVM = 0;

/**
 * Port of paima-engine's createMessageForBatcher
 * (packages/effectstream-sdk/concise/src/batcher.ts:63-78).
 *
 * Concatenates the signable fields, lowercases, and replaces non-alphanumerics
 * with "-". The batcher reconstructs the same string server-side and verifies
 * the signature.
 */
function createMessageForBatcher(
  namespace: string | null,
  millisecondTimestamp: string,
  walletAddress: string,
  _addressType: number,
  inputData: string,
  target: string | undefined = undefined,
): string {
  return ((namespace ?? "") + (target ?? "") + millisecondTimestamp + walletAddress + inputData)
    .replace(/[^a-zA-Z0-9]/g, "-")
    .toLocaleLowerCase();
}

async function postLobby(wallet: ethers.Wallet, conciseData: unknown[]): Promise<Response> {
  const timestamp = Date.now().toString();
  const inputStr = JSON.stringify(conciseData);

  // IMPORTANT: leave `target` out of the signed message and the POST body.
  //
  // Why: paima-engine 0.10.24 `extractBatches` (jsr:@paimaexample/concise)
  // does NOT persist the target field into the on-chain subunit. When the
  // Paima node later reconstructs the signed message for verification it
  // passes target=undefined → "". The batcher's own verifier uses
  // `(input.target ?? "")`, so if we omit target in the POST the batcher
  // also builds "" there. Both sides agree, signature verifies on both
  // ends. Routing still works because the batcher uses `defaultTarget`
  // when `input.target` is absent, and `effectstreaml2` is set as default
  // in main.ts:42.
  //
  // The batcher's namespace is also "" (config.ts:13), so namespace agrees
  // across: client ("") ↔ batcher ("") ↔ Paima (null → "").
  const message = createMessageForBatcher(
    "",
    timestamp,
    wallet.address,
    ADDRESS_TYPE_EVM,
    inputStr,
    undefined,
  );
  const signature = await wallet.signMessage(message);

  const body = {
    data: {
      // target intentionally omitted — batcher uses defaultTarget
      addressType: ADDRESS_TYPE_EVM,
      address: wallet.address,
      signature,
      input: inputStr,
      timestamp,
    },
    // Use wait-receipt for the smoke so errors surface; the real e2e test
    // will use no-wait and rely on the indexer/REST API for confirmation.
    confirmationLevel: "wait-receipt",
  };

  console.log(`  → POST ${BATCHER_URL}/send-input`);
  console.log(`    input=${inputStr}`);
  console.log(`    message=${message.slice(0, 80)}${message.length > 80 ? "..." : ""}`);
  console.log(`    signature=${signature.slice(0, 20)}...`);

  return fetch(`${BATCHER_URL}/send-input`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function getJson(url: string): Promise<any> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GET ${url} → ${r.status}`);
  return r.json();
}

async function pollUntil<T>(
  label: string,
  fn: () => Promise<T | null>,
  timeoutMs: number,
  intervalMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await fn();
    if (r) return r;
    console.log(`  [poll] ${label} ... (${Math.round((deadline - Date.now()) / 1000)}s left)`);
    await new Promise(res => setTimeout(res, intervalMs));
  }
  throw new Error(`Timeout: ${label}`);
}

Deno.test({
  name: "lobby: createdLobby via batcher effectstreaml2 target",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const provider = new ethers.providers.JsonRpcProvider(EVM_RPC_URL);
    const wallet = new ethers.Wallet(HARDHAT_KEY, provider);
    console.log(`  wallet address = ${wallet.address}`);

    // Snapshot existing lobbies to detect the newly-created one
    const before = await getJson(
      `${API_URL}/user_lobbies?wallet=${wallet.address.toLowerCase()}&page=0&count=50`,
    );
    const existingIds = new Set((before.lobbies || []).map((l: any) => l.lobby_id));
    console.log(`  existing lobbies: ${existingIds.size}`);

    // Build the concise tuple with the grammar helper so typebox validates
    // our fields against the contract-side schema (minLength / maxLength /
    // numeric ranges etc.). Result: ["createdLobby", "SmokeP1", "E2E-…"].
    const lobbyName = `E2E-SMOKE-${Date.now()}`;
    const conciseData = generateStmInput(grammar, "createdLobby", {
      playerName: "SmokeP1",
      lobbyName,
    });
    console.log(`  concise tuple: ${JSON.stringify(conciseData)}`);

    const res = await postLobby(wallet, conciseData as unknown as unknown[]);
    console.log(`  batcher responded: ${res.status}`);
    const bodyText = await res.text();
    console.log(`  body: ${bodyText.slice(0, 200)}`);
    assertEquals(res.ok, true, `batcher rejected: ${bodyText}`);

    // Poll Paima REST until the new lobby appears
    const newLobby = await pollUntil(
      "new lobby appears",
      async () => {
        const d = await getJson(
          `${API_URL}/user_lobbies?wallet=${wallet.address.toLowerCase()}&page=0&count=50`,
        );
        return (d.lobbies || []).find((l: any) => !existingIds.has(l.lobby_id)) || null;
      },
      30_000,
      2_000,
    );
    assertExists(newLobby, "new lobby should exist");
    console.log(`  ✓ lobby created via batcher: id=${newLobby.lobby_id} name=${newLobby.lobby_name ?? newLobby.name}`);
  },
});

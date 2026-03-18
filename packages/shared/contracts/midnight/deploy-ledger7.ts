import * as log from "@std/log";
import {
  getNetworkId,
  setNetworkId,
} from "@midnight-ntwrk/midnight-js-network-id";
import { Buffer } from "node:buffer";
import type {
  MidnightProvider,
  WalletProvider,
} from "@midnight-ntwrk/midnight-js-types";
import { CompiledContract, ContractExecutable } from "@midnight-ntwrk/compact-js";
import {
  ImpureCircuitId,
  VerifierKey,
} from "@midnight-ntwrk/compact-js/effect/Contract";
import {
  asContractAddress,
  makeContractExecutableRuntime,
  exitResultOrError,
} from "@midnight-ntwrk/midnight-js-types";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { httpClientProofProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";
import { NodeZkConfigProvider } from "@midnight-ntwrk/midnight-js-node-zk-config-provider";
import * as path from "@std/path";
import { levelPrivateStateProvider } from "@midnight-ntwrk/midnight-js-level-private-state-provider";
import { midnightNetworkConfig } from "@paimaexample/midnight-contracts/midnight-env";
import { parseCoinPublicKeyToHex } from "@midnight-ntwrk/midnight-js-utils";
import {
  sampleSigningKey,
} from "@midnight-ntwrk/compact-runtime";
import {
  SucceedEntirely,
} from "@midnight-ntwrk/midnight-js-types";

import {
  buildWalletFacade,
  getInitialShieldedState,
  registerNightForDust,
  resolveWalletSyncTimeoutMs,
  syncAndWaitForFunds,
  waitForDustFunds,
  type WalletResult,
} from "./faucet.ts";

// Declare Deno global for type-checking when not executed under Deno tooling.
declare const Deno: typeof globalThis.Deno;

// Modular wallet SDK imports
import type { WalletFacade } from "@midnight-ntwrk/wallet-sdk-facade";
import {
  shieldedToken,
  ContractDeploy,
  ContractState as LedgerContractState,
  Intent,
  Transaction,
} from "@midnight-ntwrk/ledger-v7";
import type {
  CoinPublicKey,
  DustSecretKey,
  EncPublicKey,
  FinalizedTransaction,
  TransactionId,
  ZswapSecretKeys,
} from "@midnight-ntwrk/ledger-v7";
// compact-js still returns maintenance updates backed by the older ledger wasm
// runtime, so keep a narrow compatibility bridge here when building verifier-key
// maintenance transactions.
import {
  Intent as LegacyIntent,
  Transaction as LegacyTransaction,
} from "npm:@midnight-ntwrk/ledger-v7@7.0.0";
import type { NetworkId } from "@midnight-ntwrk/wallet-sdk-abstractions";

// ============================================================================
// Constants
// ============================================================================

/** Transaction TTL duration in milliseconds (1 hour) */
const TTL_DURATION_MS = 60 * 60 * 1000;

// ============================================================================
// Types
// ============================================================================

/**
 * Configuration for deploying a Midnight contract
 */
export interface DeployConfig {
  /** Name of the contract directory (e.g., "contract-counter", "contract-eip-20") */
  contractName: string;
  /** Base filename for contract address (e.g., "contract-counter.json"); a network suffix is appended */
  contractFileName: string;
  /** The Contract class to deploy */
  // deno-lint-ignore no-explicit-any
  contractClass: any;
  /** Witness definitions */
  // deno-lint-ignore no-explicit-any
  witnesses: any;
  /** On-chain private state ID */
  privateStateId: string;
  /** Initial private state object */
  // deno-lint-ignore no-explicit-any
  initialPrivateState: any;
  /** Optional deployment arguments array */
  // deno-lint-ignore no-explicit-any
  deployArgs?: any[];
  /** Optional private state store name (defaults to contractName-based value) */
  privateStateStoreName?: string;
  /** Optional base directory override for finding contracts */
  baseDir?: string;
  /** Optional flag to extract wallet address info (for contracts that need initialOwner) */
  extractWalletAddress?: boolean;
}

/**
 * Network endpoint URLs for connecting to Midnight infrastructure
 */
export interface NetworkUrls {
  /** Optional network ID override */
  id?: string;
  /** GraphQL indexer HTTP endpoint (default: http://127.0.0.1:8088/api/v3/graphql)*/
  indexer?: string;
  /** GraphQL indexer WebSocket endpoint (default: ws://127.0.0.1:8088/api/v3/graphql/ws)*/
  indexerWS?: string;
  /** Midnight node RPC endpoint (default: http://127.0.0.1:9944)*/
  node?: string;
  /** Proof server HTTP endpoint (default: http://127.0.0.1:6300)*/
  proofServer?: string;
}

/** Initial owner structure for contracts that need wallet address */
interface InitialOwner {
  is_left: boolean;
  left: { bytes: Uint8Array };
  right: { bytes: Uint8Array };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Create a TTL date for transactions
 */
function createTtl(): Date {
  return new Date(Date.now() + TTL_DURATION_MS);
}

function checkEnvVariables(): void {
  if (!Deno.env.get("MIDNIGHT_STORAGE_PASSWORD")) {
    // Set a default password for local development
    Deno.env.set("MIDNIGHT_STORAGE_PASSWORD", "D3vP@ssw0rd!xK9m");
    log.info("MIDNIGHT_STORAGE_PASSWORD not set, using default for local dev");
  }
}

function ensureDustFeeConfig(): void {
  const margin = Deno.env.get("MIDNIGHT_DUST_FEE_BLOCKS_MARGIN");
  if (margin !== undefined) {
    const parsed = Number(margin);
    if (!Number.isFinite(parsed) || parsed < 0) {
      log.warn(
        `Invalid MIDNIGHT_DUST_FEE_BLOCKS_MARGIN="${margin}". Using default dust fee margin.`,
      );
    } else {
      log.info(
        `Using MIDNIGHT_DUST_FEE_BLOCKS_MARGIN=${Math.floor(parsed)}`,
      );
    }
  }

  const overhead = Deno.env.get("MIDNIGHT_DUST_FEE_OVERHEAD");
  if (overhead !== undefined) {
    try {
      const parsed = BigInt(overhead);
      if (parsed < 0n) throw new Error("negative");
      log.info(`Using MIDNIGHT_DUST_FEE_OVERHEAD=${parsed}`);
    } catch (_error) {
      log.warn(
        `Invalid MIDNIGHT_DUST_FEE_OVERHEAD="${overhead}". Using default dust fee overhead.`,
      );
    }
  }
}

function safeStringifyProgress(value: unknown): string {
  try {
    return JSON.stringify(
      value,
      (_key, val) => (typeof val === "bigint" ? val.toString() : val),
      2,
    );
  } catch (_error) {
    return String(value);
  }
}

const resolveSkipInsertRemainingVks = (): boolean =>
  Deno.env.get("MIDNIGHT_DEPLOY_SKIP_INSERT_REMAINING_VKS")?.toLowerCase() ===
    "true";

const messageFromError = (value: unknown): string | undefined => {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  if (typeof value === "object" && value !== null) {
    const maybeMessage = (value as { message?: unknown }).message;
    if (typeof maybeMessage === "string") return maybeMessage;
  }
  return undefined;
};

const collectErrorMessages = (error: unknown, maxDepth = 6): string[] => {
  const messages: string[] = [];
  let current: unknown = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    const message = messageFromError(current);
    if (message) messages.push(message);
    if (typeof current !== "object" || current === null) break;
    current = (current as { cause?: unknown }).cause;
  }
  if (messages.length === 0) {
    messages.push(String(error));
  }
  return messages;
};

// ============================================================================
// Wallet Facade
// ============================================================================

/**
 * Build wallet and wait for funds
 */
async function buildWalletAndWaitForFunds(
  networkUrls: Required<Omit<NetworkUrls, "id">>,
  seed: string,
  networkId: NetworkId.NetworkId,
): Promise<WalletResult> {
  log.info("Building wallet using modular SDK");
  const result = await buildWalletFacade(networkUrls, seed, networkId);

  const initialState = await getInitialShieldedState(result.wallet.shielded);
  const address = initialState.address.coinPublicKeyString();
  log.info(`Wallet seed: ${seed}`);
  log.info(`Wallet address: ${address}`);
  log.info(`Dust address: ${result.dustAddress}`);

  let balance = initialState.balances[shieldedToken().tag] ?? 0n;
  log.info("initialState " + safeStringifyProgress(initialState));
  const syncTimeoutMs = resolveWalletSyncTimeoutMs();
  if (balance === 0n) {
    const skipWait =
      Deno.env.get("MIDNIGHT_SKIP_WAIT_FOR_FUNDS")?.toLowerCase() === "true";
    log.info("Wallet shielded balance: 0");
    log.info(
      `Waiting to receive tokens... (timeout ${syncTimeoutMs}ms${
        skipWait ? ", skip on timeout enabled" : ""
      })`,
    );
    try {
      const { shieldedBalance, unshieldedBalance } = await syncAndWaitForFunds(
        result.wallet,
      );
      balance = shieldedBalance;
      if (unshieldedBalance > 0n) {
        log.info(`Unshielded balance available: ${unshieldedBalance}`);
      }
    } catch (e) {
      if (skipWait) {
        log.warn(
          `Skipping wait for shielded funds after timeout: ${
            (e as Error).message
          }`,
        );
      } else {
        throw e;
      }
    }
  }
  log.info(`Wallet balance: ${balance}`);

  return result;
}

async function ensureDustBalance(walletResult: WalletResult): Promise<void> {
  const { unshieldedBalance, dustBalance } = await syncAndWaitForFunds(
    walletResult.wallet,
    { waitNonZero: false, logLabel: "deploy" },
  );

  if (dustBalance > 0n) return;

  if (unshieldedBalance === 0n) {
    log.warn(
      "Dust balance is 0 and unshielded balance is 0; dust generation is not possible yet.",
    );
    return;
  }

  const registered = await registerNightForDust(walletResult);
  if (!registered) return;

  try {
    await waitForDustFunds(walletResult.wallet, {
      timeoutMs: resolveWalletSyncTimeoutMs(),
      waitNonZero: true,
    });
  } catch (error) {
    log.warn(
      `Dust still not available after registration: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}


// ============================================================================
// Provider Configuration
// ============================================================================

/**
 * Create wallet and midnight provider adapter for WalletFacade
 *
 * Implements the WalletProvider and MidnightProvider interfaces
 * as defined in @midnight-ntwrk/midnight-js-types v3.x
 */
function createWalletAndMidnightProvider(
  wallet: WalletFacade,
  zswapSecretKeys: ZswapSecretKeys,
  walletZswapSecretKeys: ZswapSecretKeys,
  dustSecretKey: DustSecretKey,
  walletDustSecretKey: DustSecretKey,
  unshieldedKeystore: WalletResult["unshieldedKeystore"],
): WalletProvider & MidnightProvider {
  const secretKeys = {
    shieldedSecretKeys: walletZswapSecretKeys,
    dustSecretKey: walletDustSecretKey,
  };
  return {
    getCoinPublicKey(): CoinPublicKey {
      return zswapSecretKeys.coinPublicKey;
    },
    getEncryptionPublicKey(): EncPublicKey {
      return zswapSecretKeys.encryptionPublicKey;
    },
    // v3 WalletProvider: balanceTx takes UnboundTransaction (proven), returns FinalizedTransaction
    // deno-lint-ignore no-explicit-any
    async balanceTx(tx: any, ttl?: Date): Promise<FinalizedTransaction> {
      const txTtl = ttl ?? createTtl();
      // Bind the unbound transaction first, then balance as a finalized transaction
      const bound = tx.bind();
      const recipe = await wallet.balanceFinalizedTransaction(bound, secretKeys, {
        ttl: txTtl,
      });
      const signed = await wallet.signRecipe(recipe, (payload: Uint8Array) => unshieldedKeystore.signData(payload));
      return wallet.finalizeRecipe(signed);
    },
    submitTx(tx: FinalizedTransaction): Promise<TransactionId> {
      return wallet.submitTransaction(tx).catch((error) => {
        const messages = collectErrorMessages(error);
        log.error(`submitTx failed: ${messages.join(" | ")}`);
        throw error;
      });
    },
  };
}

/**
 * Configure all providers needed for contract deployment
 */
function configureProviders(
  wallet: WalletFacade,
  zswapSecretKeys: ZswapSecretKeys,
  walletZswapSecretKeys: ZswapSecretKeys,
  dustSecretKey: DustSecretKey,
  walletDustSecretKey: DustSecretKey,
  unshieldedKeystore: WalletResult["unshieldedKeystore"],
  networkUrls: Required<Omit<NetworkUrls, "id">>,
  privateStateStoreName: string,
  zkConfigPath: string,
) {
  const signingKeyStoreName = `${privateStateStoreName}-signing-keys`;
  const walletAndMidnightProvider = createWalletAndMidnightProvider(
    wallet,
    zswapSecretKeys,
    walletZswapSecretKeys,
    dustSecretKey,
    walletDustSecretKey,
    unshieldedKeystore,
  );
  const zkConfigProvider = new NodeZkConfigProvider(zkConfigPath);
  return {
    privateStateProvider: levelPrivateStateProvider({
      midnightDbName: "midnight-level-db-deploy", // Use separate DB for deployment to avoid lock conflicts
      privateStateStoreName,
      signingKeyStoreName,
      privateStoragePasswordProvider: () => Promise.resolve(Deno.env.get("MIDNIGHT_STORAGE_PASSWORD") ?? "D3vP@ssw0rd!xK9m"),
      accountId: unshieldedKeystore.getBech32Address().asString(),
    }),
    publicDataProvider: indexerPublicDataProvider(
      networkUrls.indexer,
      networkUrls.indexerWS,
    ),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(networkUrls.proofServer, zkConfigProvider),
    walletProvider: walletAndMidnightProvider,
    midnightProvider: walletAndMidnightProvider,
  };
}

/**
 * Create a CompiledContract object from a contract class and witnesses.
 * In compact-js v2.4+, the SDK expects a CompiledContract (with internal Symbol metadata)
 * rather than a raw contract class instance.
 */
function createCompiledContract(
  contractClass: DeployConfig["contractClass"],
  witnesses: DeployConfig["witnesses"],
  contractName: string,
  compiledAssetsPath: string,
  // deno-lint-ignore no-explicit-any
): any {
  // deno-lint-ignore no-explicit-any
  let compiled: any = CompiledContract.make(contractName, contractClass);
  compiled = (CompiledContract as any).withWitnesses(compiled, witnesses);
  compiled = (CompiledContract as any).withCompiledFileAssets(compiled, compiledAssetsPath);
  return compiled;
}

/**
 * Local reimplementation of submitInsertVerifierKeyTx that bridges the ledger-v7
 * WASM instance mismatch between compact-js (pinned at 7.0.0) and midnight-js-contracts
 * (which uses 7.0.3). By building the tx with LegacyTransaction/LegacyIntent from
 * 7.0.0, then round-tripping through serialize/deserialize, we get a Transaction
 * instance compatible with the wallet's 7.0.3 WASM.
 */
async function submitInsertVerifierKeyTxLocal(
  providers: ReturnType<typeof configureProviders>,
  // deno-lint-ignore no-explicit-any
  compiledContract: any,
  contractAddress: string,
  circuitId: string,
  verifierKey: unknown,
  walletResult: WalletResult,
) {
  const contractState = await providers.publicDataProvider.queryContractState(
    contractAddress as any,
  );
  if (!contractState) {
    throw new Error(
      `No contract state found on chain for contract address '${contractAddress}'`,
    );
  }

  const signingKey = await providers.privateStateProvider.getSigningKey(
    contractAddress,
  );
  if (!signingKey) {
    throw new Error(
      `Signing key for contract address '${contractAddress}' not found`,
    );
  }

  const contractExec = ContractExecutable.make(compiledContract);
  const contractRuntime = makeContractExecutableRuntime(
    providers.zkConfigProvider,
    {
      coinPublicKey: providers.walletProvider.getCoinPublicKey(),
      signingKey,
    },
  );

  const exitResult = await contractRuntime.runPromiseExit(
    // deno-lint-ignore no-explicit-any
    (contractExec as any).addOrReplaceContractOperation(
      ImpureCircuitId(circuitId as any),
      VerifierKey(verifierKey as Uint8Array),
      {
        address: asContractAddress(contractAddress),
        contractState,
      },
    ),
  );
  // deno-lint-ignore no-explicit-any
  const maintenanceResult = exitResultOrError(exitResult as any) as any;

  // Build with the legacy (7.0.0) WASM that compact-js uses, then round-trip
  // through serialize/deserialize to get a 7.0.3-compatible Transaction.
  const legacyUnprovenTx = LegacyTransaction.fromParts(
    getNetworkId(),
    undefined,
    undefined,
    LegacyIntent.new(createTtl()).addMaintenanceUpdate(
      maintenanceResult.public.maintenanceUpdate,
    ),
  );
  const unprovenTx = Transaction.deserialize(
    "signature",
    "pre-proof",
    "pre-binding",
    legacyUnprovenTx.serialize(),
  );

  const recipe = await walletResult.wallet.balanceUnprovenTransaction(
    unprovenTx as any,
    {
      shieldedSecretKeys: walletResult.walletZswapSecretKeys as any,
      dustSecretKey: walletResult.walletDustSecretKey as any,
    },
    { ttl: createTtl() },
  );

  const signedRecipe = await walletResult.wallet.signRecipe(
    recipe,
    (payload) => walletResult.unshieldedKeystore.signData(payload),
  );

  const finalizedTx = await walletResult.wallet.finalizeRecipe(signedRecipe);
  const txId = await walletResult.wallet.submitTransaction(finalizedTx);
  return await providers.publicDataProvider.watchForTxData(txId);
}

async function deployWithLimitedVerifierKeys(
  providers: ReturnType<typeof configureProviders>,
  // deno-lint-ignore no-explicit-any
  compiledContract: any,
  config: DeployConfig,
  deployArgs: unknown[] | undefined,
  walletResult: WalletResult,
): Promise<string> {
  // Strategy: The Go Fish contract has 30 circuits with large verifier keys.
  // A deploy tx with all VKs exceeds the block size limit.
  // We deploy with NO verifier keys (stripped contract state), then insert
  // each VK individually via submitInsertVerifierKeyTx after deployment.
  //
  // Steps:
  // 1. Run ContractExecutable.initialize() with the real zkConfigProvider
  //    (so VKs are validated and the contract state is correctly initialized)
  // 2. Convert the resulting contract state to ledger format
  // 3. Create a STRIPPED copy with only data + maintenanceAuthority (no operations)
  // 4. Build the deploy transaction from the stripped state
  // 5. After deployment, insert all VKs individually

  const signingKey = sampleSigningKey();

  const coinPublicKey = parseCoinPublicKeyToHex(
    providers.walletProvider.getCoinPublicKey() as string,
    getNetworkId(),
  );

  // Step 1: Initialize the contract with the real provider to get valid state
  const contractExec = ContractExecutable.make(compiledContract);
  const contractRuntime = makeContractExecutableRuntime(
    providers.zkConfigProvider,
    {
      coinPublicKey,
      signingKey,
    },
  );

  const initialPrivateState = config.initialPrivateState ?? undefined;
  const args = deployArgs ?? [];

  log.info("Running contract initialization with full zkConfigProvider...");
  const exitResult = await contractRuntime.runPromiseExit(
    contractExec.initialize(initialPrivateState, ...args),
  );

  // deno-lint-ignore no-explicit-any
  let initResult: any;
  try {
    initResult = exitResultOrError(exitResult);
  } catch (error) {
    // deno-lint-ignore no-explicit-any
    const err = error as any;
    if (err?.["_tag"] === "ContractRuntimeError" && err?.cause?.name === "CompactError") {
      throw new Error(err.cause.message);
    }
    throw error;
  }

  const {
    public: { contractState: fullContractState },
    private: { privateState, signingKey: derivedSigningKey },
  } = initResult;

  // Step 2: Convert compact-runtime ContractState to ledger ContractState
  const fullLedgerState = LedgerContractState.deserialize(
    fullContractState.serialize(),
  );

  // Log all operations (circuits) found in the initialized state
  const allOperationIds = fullLedgerState.operations() as string[];
  log.info(
    `Contract initialized with ${allOperationIds.length} operations: ${allOperationIds.join(", ")}`,
  );

  // Step 3: Create a stripped ContractState with NO operations (no VKs)
  const strippedState = new LedgerContractState();
  strippedState.data = fullLedgerState.data;
  strippedState.maintenanceAuthority = fullLedgerState.maintenanceAuthority;
  // Deliberately skip copying operations — this is the key to reducing tx size

  log.info("Created stripped contract state (no operations/verifier keys)");

  // Step 4: Build the deploy transaction
  const contractDeploy = new ContractDeploy(strippedState);
  const contractAddress = contractDeploy.address;

  // Build the unproven transaction with Intent containing the deploy
  const intent = Intent.new(createTtl()).addDeploy(contractDeploy);
  const unprovenTx = Transaction.fromParts(
    getNetworkId(),
    undefined, // no guaranteed zswap offer needed for a stripped deploy
    undefined, // no fallible offer
    intent,
  );

  log.info(`Deploy tx built for contract address: ${contractAddress}`);

  // Step 5: Balance, sign, finalize, and submit the deploy transaction.
  // We bypass submitTx (which calls proveTx first) because our stripped deploy
  // has no circuit calls — there are no proofs to generate. The proof provider
  // would convert PreProof markers to Proof markers, causing the wallet to fail
  // when trying to deserialize the intent.
  const { wallet, walletZswapSecretKeys, walletDustSecretKey, unshieldedKeystore } = walletResult;
  const balanceSecretKeys = {
    shieldedSecretKeys: walletZswapSecretKeys,
    dustSecretKey: walletDustSecretKey,
  };

  log.info("Balancing deploy transaction (unproven)...");
  const recipe = await wallet.balanceUnprovenTransaction(
    unprovenTx,
    balanceSecretKeys,
    { ttl: createTtl() },
  );

  const signedRecipe = await wallet.signRecipe(
    recipe,
    (payload) => unshieldedKeystore.signData(payload),
  );

  const finalizedTx = await wallet.finalizeRecipe(signedRecipe);

  log.info("Submitting deploy transaction...");
  const txId = await wallet.submitTransaction(finalizedTx);
  log.info(`Deploy transaction submitted, txId: ${txId}`);

  // Wait for the transaction to be finalized on-chain
  const finalizedTxData = await providers.publicDataProvider.watchForTxData(txId);
  if (finalizedTxData.status !== SucceedEntirely) {
    throw new Error(
      `Deployment failed with status ${finalizedTxData.status}`,
    );
  }

  log.info("Deploy transaction finalized on-chain.");

  // Scope the private state provider to this contract address (required in 3.2.0)
  providers.privateStateProvider.setContractAddress(contractAddress);

  // Save private state and signing key
  if (config.privateStateId) {
    await providers.privateStateProvider.set(
      config.privateStateId,
      privateState,
    );
  }
  await providers.privateStateProvider.setSigningKey(
    contractAddress,
    derivedSigningKey,
  );

  // Step 6: Insert all verifier keys individually
  if (!resolveSkipInsertRemainingVks()) {
    // Collect all verifier keys from the real zkConfigProvider
    const allVerifierKeys = await providers.zkConfigProvider.getVerifierKeys(
      allOperationIds as any,
    );

    log.info(
      `Inserting ${allVerifierKeys.length} verifier keys individually...`,
    );
    const VK_INSERT_MAX_RETRIES = 3;
    const VK_INSERT_RETRY_DELAY_MS = 10_000;
    const VK_INSERT_PAUSE_MS = 2_000;

    for (const [circuitId, verifierKey] of allVerifierKeys) {
      log.info(`Inserting verifier key for circuit: ${circuitId}`);

      let lastError: unknown;
      for (let attempt = 1; attempt <= VK_INSERT_MAX_RETRIES; attempt++) {
        try {
          const submitResult = await submitInsertVerifierKeyTxLocal(
            providers,
            compiledContract,
            contractAddress,
            circuitId as string,
            verifierKey,
            walletResult,
          );
          if (submitResult.status !== SucceedEntirely) {
            throw new Error(
              `Insert verifier key failed for ${circuitId} with status ${submitResult.status}`,
            );
          }
          log.info(`Verifier key inserted for circuit: ${circuitId}`);
          lastError = undefined;
          break;
        } catch (err) {
          lastError = err;
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(
            `VK insert for ${circuitId} failed (attempt ${attempt}/${VK_INSERT_MAX_RETRIES}): ${msg}`,
          );
          if (attempt < VK_INSERT_MAX_RETRIES) {
            log.info(
              `Waiting ${VK_INSERT_RETRY_DELAY_MS}ms for wallet to sync before retry...`,
            );
            await new Promise((r) => setTimeout(r, VK_INSERT_RETRY_DELAY_MS));
          }
        }
      }
      if (lastError) {
        throw lastError;
      }

      // Brief pause between VK inserts to let the dust wallet state refresh
      await new Promise((r) => setTimeout(r, VK_INSERT_PAUSE_MS));
    }
    log.info("All verifier keys inserted successfully.");
  } else {
    log.warn(
      "Skipping verifier key insertion (MIDNIGHT_DEPLOY_SKIP_INSERT_REMAINING_VKS=true)",
    );
  }

  return contractAddress;
}

// ============================================================================
// Contract Deployment Helpers
// ============================================================================

/**
 * Extract initial owner from wallet for contracts that need it (e.g., EIP-20)
 */
async function extractInitialOwnerFromWallet(
  wallet: WalletFacade,
): Promise<InitialOwner> {
  const initialState = await getInitialShieldedState(wallet.shielded);
  const coinPubHex = initialState.address.coinPublicKeyString();
  const encPubHex = initialState.address.encryptionPublicKeyString();
  log.info(
    `Extracting initial owner from wallet keys (hex): coin=${coinPubHex}`,
  );
  log.info(`Encryption key (hex): ${encPubHex}`);

  const coinBytes = Buffer.from(coinPubHex, "hex");
  const encBytes = Buffer.from(encPubHex, "hex");

  return {
    is_left: true,
    left: { bytes: coinBytes },
    right: { bytes: encBytes.subarray(0, 32) },
  };
}

/**
 * Find the compiler subdirectory in the managed directory
 */
function hasManagedArtifacts(dir: string): boolean {
  const requiredDirs = ["contract", "compiler"];
  try {
    return requiredDirs.every((name) => {
      const stats = Deno.statSync(path.join(dir, name));
      return stats.isDirectory;
    });
  } catch {
    return false;
  }
}

function findCompilerSubdirectory(managedDir: string): string {
  try {
    for (const entry of Deno.readDirSync(managedDir)) {
      if (!entry.isDirectory) continue;
      const candidate = path.join(managedDir, entry.name);
      if (hasManagedArtifacts(candidate)) {
        return entry.name;
      }
    }
  } catch (_error) {
    throw new Error(`Managed directory not found: ${managedDir}`);
  }

  if (hasManagedArtifacts(managedDir)) {
    return "";
  }

  throw new Error(
    `No compiler artifacts found in managed directory: ${managedDir}. ` +
      `Ensure the directory contains compiler, contract, keys, and zkir assets.`,
  );
}

function findContractDirectoryForDeploy(
  contractName: string,
  baseDir?: string,
): string | null {
  let current = path.resolve(baseDir ?? Deno.cwd());
  while (true) {
    if (path.basename(current) === contractName) {
      return path.dirname(current);
    }

    const candidate = path.join(current, contractName);
    try {
      const stats = Deno.statSync(candidate);
      if (stats.isDirectory) return current;
    } catch {
      // ignore
    }

    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

// ============================================================================
// Main Deployment Function
// ============================================================================

/**
 * Deploys a Midnight contract using the provided configuration.
 *
 * This function is context-aware and will find the contract directory
 * and zkConfigPath automatically using a local contract search.
 *
 * @param config - Deployment configuration
 * @param networkUrls - Optional network endpoint URLs (defaults to local undeployed endpoints)
 * @returns The deployed contract address
 */
export async function deployMidnightContract(
  config: DeployConfig,
  networkUrls?: NetworkUrls,
): Promise<string> {
  checkEnvVariables();
  ensureDustFeeConfig();
  await log.setup({
    handlers: {
      console: new log.ConsoleHandler("INFO"),
    },
    loggers: {
      default: {
        level: "INFO",
        handlers: ["console"],
      },
    },
  });

  // Find the contract directory
  const contractDir = findContractDirectoryForDeploy(
    config.contractName,
    config.baseDir,
  );

  if (!contractDir) {
    throw new Error(
      `Could not find Midnight contract directory for "${config.contractName}". ` +
        `Searched starting from ${config.baseDir || Deno.cwd()}. ` +
        `Please ensure you're running from a directory that contains or is a parent of the Midnight contract directory, ` +
        `or provide an explicit baseDir parameter.`,
    );
  }

  // Find the compiler subdirectory to determine zkConfigPath
  const managedDir = path.join(
    contractDir,
    config.contractName,
    "src/managed",
  );
  const compilerSubdir = findCompilerSubdirectory(managedDir);

  const zkConfigPath = path.resolve(
    path.join(contractDir, config.contractName, "src/managed", compilerSubdir),
  );

  // Default private state store name if not provided
  const privateStateStoreName = config.privateStateStoreName ??
    `${config.contractName.replace("contract-", "")}-private-state`;

  // Merge network URLs with defaults
  const { id: networkIdOverride, ...endpoints } = networkUrls ?? {};
  const resolvedNetworkUrls: Required<Omit<NetworkUrls, "id">> = {
    indexer: endpoints.indexer ?? midnightNetworkConfig.indexer,
    indexerWS: endpoints.indexerWS ?? midnightNetworkConfig.indexerWS,
    node: endpoints.node ?? midnightNetworkConfig.node,
    proofServer: endpoints.proofServer ?? midnightNetworkConfig.proofServer,
  };
  const resolvedNetworkId =
    (networkIdOverride ?? midnightNetworkConfig.id) as NetworkId.NetworkId;

  log.info(
    `Preflight resolved endpoints -> indexerHttp=${resolvedNetworkUrls.indexer}, indexerWs=${resolvedNetworkUrls.indexerWS}, node=${resolvedNetworkUrls.node}, proofServer=${resolvedNetworkUrls.proofServer}, networkId=${resolvedNetworkId}`,
  );

  setNetworkId(resolvedNetworkId);

  let walletResult: WalletResult | null = null;
  let providers: ReturnType<typeof configureProviders> | null = null;

  try {
    log.info("Building wallet...");
    walletResult = await buildWalletAndWaitForFunds(
      resolvedNetworkUrls,
      midnightNetworkConfig.walletSeed!,
      resolvedNetworkId,
    );

    await ensureDustBalance(walletResult);

    const {
      wallet,
      zswapSecretKeys,
      walletZswapSecretKeys,
      dustSecretKey,
      walletDustSecretKey,
      dustAddress,
      unshieldedKeystore,
    } = walletResult;
    const resolvedDustReceiverAddress =
      Deno.env.get("MIDNIGHT_DUST_RECEIVER_ADDRESS") ?? dustAddress;
    if (resolvedDustReceiverAddress === dustAddress) {
      log.info(`Using derived dust address: ${resolvedDustReceiverAddress}`);
    } else {
      log.info(
        `Using dust receiver address from MIDNIGHT_DUST_RECEIVER_ADDRESS: ${resolvedDustReceiverAddress}`,
      );
    }

    // Extract wallet address info if needed (for contracts like EIP-20)
    let deployArgs = config.deployArgs;
    if (config.extractWalletAddress && deployArgs && deployArgs.length > 0) {
      const initialOwner = await extractInitialOwnerFromWallet(wallet);
      deployArgs = [...deployArgs.slice(0, -1), initialOwner];
    }

    log.info("Wallet built successfully.");

    log.info("Configuring providers...");
    // Use a separate LevelDB directory for deployment to avoid lock conflicts with batcher
    const deployPrivateStateStoreName = `${privateStateStoreName}-deploy`;

    providers = configureProviders(
      wallet,
      zswapSecretKeys,
      walletZswapSecretKeys,
      dustSecretKey,
      walletDustSecretKey,
      unshieldedKeystore,
      resolvedNetworkUrls,
      deployPrivateStateStoreName,
      zkConfigPath,
    );
    log.info("Providers configured.");

    log.info("Deploying contract...");

    // Create a CompiledContract object (v3 API requires this instead of raw contract class)
    const compiledContract = createCompiledContract(
      config.contractClass,
      config.witnesses,
      config.contractName,
      zkConfigPath,
    );

    const contractAddress = await deployWithLimitedVerifierKeys(
      providers,
      compiledContract,
      config,
      deployArgs,
      walletResult,
    );

    log.info("Contract deployed.");
    log.info(`Contract address: ${contractAddress}`);

    const baseContractFileName = config.contractFileName ??
      `${config.contractName}.json`;
    const {
      dir: contractFileDir,
      name: contractFileBaseName,
      ext: contractFileExt,
    } = path.parse(baseContractFileName);
    const normalizedExt = contractFileExt || ".json";
    const networkSuffix = `.${resolvedNetworkId}`;
    const fileBaseWithNetwork = contractFileBaseName.endsWith(networkSuffix)
      ? contractFileBaseName
      : `${contractFileBaseName}${networkSuffix}`;
    const outputFileName = `${fileBaseWithNetwork}${normalizedExt}`;
    const outputPath = path.join(
      contractDir,
      contractFileDir,
      outputFileName,
    );

    await Deno.writeTextFile(
      outputPath,
      JSON.stringify({ contractAddress }, null, 2),
    );
    log.info(
      `Contract address saved to ${outputPath} (network: ${resolvedNetworkId})`,
    );

    return contractAddress;
  } catch (e) {
    if (e instanceof Error) {
      log.error(`Deployment failed: ${e.message}`);
      log.debug(e.stack);
    } else {
      log.error("An unknown error occurred during deployment.");
    }
    throw e;
  } finally {
    // Close wallet first
    if (walletResult) {
      log.info("Closing wallet...");
      try {
        await walletResult.wallet.stop();
      } catch (_closeError) {
        // Ignore close errors
      }
      log.info("Wallet closed.");
    }

    // Wait a moment for Level DB to finish any async close operations
    // The levelPrivateStateProvider opens/closes DB for each operation in withSubLevel
    // But there might be pending async operations
    log.info("Waiting for Level DB cleanup...");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

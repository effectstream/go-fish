/**
 * In-Browser Wallet — Creates and persists a Midnight wallet locally in the browser.
 *
 * Uses the same pattern as pvp-v2: a random 32-byte seed is generated once,
 * stored in localStorage, and used to derive ZswapSecretKeys. This gives each
 * browser tab/user a persistent Midnight identity without requiring the Lace
 * wallet extension. All transactions are routed through the batcher for dust
 * balancing and chain submission.
 */

import {
  ZswapSecretKeys,
  type CoinPublicKey,
  type EncPublicKey,
} from "@midnight-ntwrk/ledger-v8";

const LOCAL_ZSWAP_SEED_KEY = "go-fish-local-zswap-seed";

const toHex = (data: Uint8Array): string =>
  Array.from(data)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

const fromHex = (hex: string): Uint8Array => {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const match = clean.match(/.{1,2}/g);
  return new Uint8Array(match ? match.map((b) => parseInt(b, 16)) : []);
};

let _keys: ZswapSecretKeys | null = null;

/**
 * Get or create the local in-browser Midnight wallet.
 * The seed is persisted in localStorage so the identity survives page reloads.
 */
export function getOrCreateLocalWallet(): ZswapSecretKeys {
  if (_keys) return _keys;

  const existingSeed = localStorage.getItem(LOCAL_ZSWAP_SEED_KEY);
  if (existingSeed) {
    _keys = ZswapSecretKeys.fromSeed(fromHex(existingSeed));
    console.log("[InBrowserWallet] Restored wallet from localStorage");
  } else {
    const seed = crypto.getRandomValues(new Uint8Array(32));
    localStorage.setItem(LOCAL_ZSWAP_SEED_KEY, toHex(seed));
    _keys = ZswapSecretKeys.fromSeed(seed);
    console.log("[InBrowserWallet] Created new wallet, seed saved to localStorage");
  }

  return _keys;
}

/** Get the wallet's coin public key (used for walletProvider). */
export function getLocalCoinPublicKey(): CoinPublicKey {
  return getOrCreateLocalWallet().coinPublicKey;
}

/** Get the wallet's encryption public key (used for walletProvider). */
export function getLocalEncryptionPublicKey(): EncPublicKey {
  return getOrCreateLocalWallet().encryptionPublicKey;
}

/**
 * Get a display-friendly address string for the in-browser wallet.
 * Returns a truncated hex representation of the coin public key.
 */
export function getLocalWalletAddress(): string {
  const cpk = getLocalCoinPublicKey();
  // CoinPublicKey is opaque — convert to string for display
  const raw = String(cpk);
  if (raw.length > 16) {
    return raw.slice(0, 8) + "..." + raw.slice(-8);
  }
  return raw;
}

/**
 * Get the full (non-truncated) coin public key as a string for identity purposes.
 */
export function getLocalWalletAddressFull(): string {
  return String(getLocalCoinPublicKey());
}

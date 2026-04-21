/**
 * zk-time-estimator
 *
 * Standalone module that predicts ZK proof generation time for each circuit
 * in the go-fish Compact contract, calibrated to the machine it runs on.
 *
 * Calibration is lazy and piggybacks on real workload:
 *   - Before any real proof has completed, expectedProof(name) returns the
 *     reference AVE time from REFERENCE_MS (ZKTIME.md).
 *   - When a real proof completes anywhere in the app, the caller invokes
 *     calibrateFromProof(circuitName, measuredMs); each call contributes a
 *     scale sample = measuredMs / REFERENCE_MS[k].ave. The persisted
 *     scaleFactor is the running mean of every sample observed so far.
 *   - Subsequent expectedProof(name) calls return REFERENCE_MS[k].ave × scaleFactor.
 *
 * Pipeline primitives:
 *   1. CIRCUIT_K            — circuit name → k, captured from
 *                             `compact compile +0.30.0 src/game.compact`.
 *   2. REFERENCE_MS         — reference benchmark times per k, from
 *                             ZKTIME.md (WASM prover, 10/14/16-thread runs).
 *   3. fitLogLinear()       — regression on REFERENCE_MS, kept for
 *                             diagnostics and to fall back on k values
 *                             that aren't in the table.
 *   4. expectedProof(name)  — predicted proof time (ms) on this machine.
 *
 * Calibration is persisted to localStorage under `zk-time-estimator.v4`.
 */

// Circuit → k, captured from `compact compile +0.30.0 src/game.compact`.
export const CIRCUIT_K: Readonly<Record<string, number>> = Object.freeze({
  afterGoFish: 14,
  applyMask: 16,
  askForCard: 14,
  checkAndEndGame: 10,
  checkAndScoreBook: 15,
  claimTimeoutWin: 10,
  concede: 10,
  dealCards: 15,
  discoverHand: 16,
  doesGameExist: 9,
  doesPlayerHaveCard: 14,
  doesPlayerHaveSpecificCard: 13,
  get_card_from_point: 6,
  getCardsDealt: 9,
  getCurrentTurn: 9,
  get_deck_size: 9,
  getGamePhase: 9,
  getHandSizes: 9,
  getLastAskedRank: 9,
  getLastAskingPlayer: 9,
  get_player_hand_size: 10,
  getScores: 9,
  get_top_card_index: 9,
  hasDealt: 9,
  hasMaskApplied: 10,
  init_deck: 15,
  isDeckEmpty: 9,
  isGameOver: 9,
  partial_decryption: 12,
  respondToAsk: 15,
  // V4.3: startGame is a small Setup → TurnStart transition circuit split out
  // from dealCards. Estimated at k=10 pending recompile (purely ledger reads
  // + a single phase write, similar shape to claimTimeoutWin / switchTurn).
  startGame: 10,
  switchTurn: 10,
});

export interface ReferencePoint {
  min: number;
  ave: number;
  max: number;
}

// Reference proof-generation times (ms) per k, from ZKTIME.md. These are the
// AVE/MIN/MAX aggregated across benchmark runs on the reference machine
// (WASM prover at 10, 14, 16 threads; HTTP proof server at 9 threads).
export const REFERENCE_MS: Readonly<Record<number, ReferencePoint>> = Object.freeze({
  5:  { min:    42, ave:   291, max:    593 },
  6:  { min:    35, ave:   291, max:    551 },
  7:  { min:    42, ave:   557, max:   1410 },
  8:  { min:    55, ave:   696, max:   1600 },
  9:  { min:    85, ave:   878, max:   1860 },
  10: { min:   136, ave:  1270, max:   2510 },
  11: { min:   226, ave:  2030, max:   3720 },
  12: { min:   429, ave:  3440, max:   6030 },
  13: { min:  1040, ave:  8070, max:  14050 },
  14: { min:  2050, ave: 13190, max:  26410 },
  15: { min:  4060, ave: 25710, max:  51270 },
  16: { min:  7720, ave: 47410, max:  94450 },
  17: { min: 14810, ave: 90820, max: 181020 },
});

const LS_KEY = "zk-time-estimator.v5";
const LS_VERSION = 5;

export interface Regression {
  a: number; // prefactor in t = a * exp(b * k)
  b: number; // growth rate
  r2: number; // R² on the log-transformed data
}

export interface Calibration {
  version: number;
  timestamp: number;
  /** Running mean of scale samples (measuredMs / REFERENCE_MS[k].ave). */
  scaleFactor: number;
  /** Number of real-proof samples folded into scaleFactor. */
  sampleCount: number;
  /** Details of the most recent sample — useful for debugging/UI. */
  lastSample: {
    circuitName: string;
    k: number;
    measuredMs: number;
    referenceAveMs: number;
    sampleScale: number;
    timestamp: number;
  };
  threads: number;
  userAgent?: string;
}

/**
 * Log-linear regression fitting y = a * exp(b * x) via ordinary least
 * squares on (x, ln y). Kept for diagnostics and as a fallback for k
 * values outside the REFERENCE_MS table.
 */
export function fitLogLinear(
  points: ReadonlyArray<{ x: number; y: number }>,
): Regression {
  if (points.length < 2) {
    throw new Error("fitLogLinear: need at least 2 points");
  }
  const n = points.length;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => Math.log(p.y));
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  const b = num / den;
  const a = Math.exp(my - b * mx);
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    const yHat = Math.log(a) + b * xs[i];
    ssRes += (ys[i] - yHat) ** 2;
    ssTot += (ys[i] - my) ** 2;
  }
  const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;
  return { a, b, r2 };
}

/** Regression fit against the REFERENCE_MS AVE column. */
export function referenceRegression(): Regression {
  const points = Object.entries(REFERENCE_MS).map(([k, v]) => ({
    x: Number(k),
    y: v.ave,
  }));
  return fitLogLinear(points);
}

function resolveK(circuitName: string): number {
  const k = CIRCUIT_K[circuitName];
  if (k === undefined) {
    throw new Error(`zk-time-estimator: unknown circuit "${circuitName}"`);
  }
  return k;
}

/**
 * Reference AVE time (ms) for a given k. Falls back to the log-linear
 * regression if k isn't in the table — in practice every go-fish circuit
 * lands inside k ∈ [5, 17], so the fallback is just a safety net.
 */
function referenceAveMs(k: number): number {
  const entry = REFERENCE_MS[k];
  if (entry) return entry.ave;
  const { a, b } = referenceRegression();
  return a * Math.exp(b * k);
}

function readCache(): Calibration | null {
  try {
    const raw = globalThis.localStorage?.getItem(LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Calibration;
    if (parsed.version !== LS_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(c: Calibration): void {
  try {
    globalThis.localStorage?.setItem(LS_KEY, JSON.stringify(c));
  } catch (err) {
    console.warn("[zk-time-estimator] failed to persist calibration", err);
  }
}

/**
 * Fold a single real proof measurement into the persisted calibration.
 * Each call contributes one scale sample — sampleScale = measuredMs /
 * REFERENCE_MS[k].ave — and the stored scaleFactor becomes the running
 * mean of every sample observed so far.
 *
 * scaleFactor = 1 means this machine matches the reference, < 1 means
 * faster, > 1 means slower.
 *
 * Call this from the success path of whichever prover the app uses, once
 * per completed proof.
 */
export function calibrateFromProof(
  circuitName: string,
  measuredMs: number,
): Calibration {
  if (!(measuredMs > 0) || !Number.isFinite(measuredMs)) {
    throw new Error(`calibrateFromProof: invalid measuredMs=${measuredMs}`);
  }
  const k = resolveK(circuitName);
  const referenceAve = referenceAveMs(k);
  const sampleScale = measuredMs / referenceAve;

  const prev = readCache();
  const prevCount = prev?.sampleCount ?? 0;
  const prevScale = prev?.scaleFactor ?? 0;
  const nextCount = prevCount + 1;
  const nextScale = (prevScale * prevCount + sampleScale) / nextCount;

  const calibration: Calibration = {
    version: LS_VERSION,
    timestamp: Date.now(),
    scaleFactor: nextScale,
    sampleCount: nextCount,
    lastSample: {
      circuitName,
      k,
      measuredMs,
      referenceAveMs: referenceAve,
      sampleScale,
      timestamp: Date.now(),
    },
    threads: globalThis.navigator?.hardwareConcurrency ?? 1,
    userAgent: globalThis.navigator?.userAgent,
  };
  writeCache(calibration);
  return calibration;
}

/**
 * Expected proof-generation time (ms) for `circuitName` on this machine.
 *   - No calibration yet → returns REFERENCE_MS[k].ave (ZKTIME.md average).
 *   - After calibration   → returns REFERENCE_MS[k].ave × scaleFactor.
 */
export function expectedProof(circuitName: string): number {
  const k = resolveK(circuitName);
  const ave = referenceAveMs(k);
  const cal = readCache();
  return cal ? ave * cal.scaleFactor : ave;
}

/** Current calibration (or null if none cached). */
export function getCachedCalibration(): Calibration | null {
  return readCache();
}

/** Erase the cached calibration. */
export function clearCalibration(): void {
  try {
    globalThis.localStorage?.removeItem(LS_KEY);
  } catch {
    // ignore
  }
}

/** Full circuit × expected-time table on this machine. */
export function expectedProofTable(): Array<{
  name: string;
  k: number;
  expectedMs: number;
}> {
  const cal = readCache();
  const scale = cal?.scaleFactor ?? 1;
  return Object.entries(CIRCUIT_K)
    .map(([name, k]) => ({
      name,
      k,
      expectedMs: referenceAveMs(k) * scale,
    }))
    .sort((a, b) => a.expectedMs - b.expectedMs);
}

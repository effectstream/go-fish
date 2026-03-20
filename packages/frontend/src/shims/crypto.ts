import * as cryptoBrowserify from "crypto-browserify";

let didLogShimLoad = false;
let didLogTimingSafeEqual = false;

function toUint8Array(value: ArrayLike<number>): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }

  return Uint8Array.from(value);
}

export function timingSafeEqual(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
): boolean {
  const left = toUint8Array(a);
  const right = toUint8Array(b);

  if (left.byteLength !== right.byteLength) {
    throw new RangeError("Input buffers must have the same byte length");
  }

  let diff = 0;
  for (let i = 0; i < left.byteLength; i++) {
    diff |= left[i] ^ right[i];
  }

  if (!didLogTimingSafeEqual) {
    didLogTimingSafeEqual = true;
    console.debug("[crypto-shim] timingSafeEqual invoked", {
      leftLength: left.byteLength,
      rightLength: right.byteLength,
    });
  }

  return diff === 0;
}

if (!didLogShimLoad) {
  didLogShimLoad = true;
  console.debug("[crypto-shim] module loaded", {
    hasCreateHash: typeof (cryptoBrowserify as any).createHash === "function",
    hasPbkdf2Sync: typeof (cryptoBrowserify as any).pbkdf2Sync === "function",
    hasRandomBytes: typeof (cryptoBrowserify as any).randomBytes === "function",
    hasTimingSafeEqual:
      typeof (cryptoBrowserify as any).timingSafeEqual === "function",
  });
}

export * from "crypto-browserify";

export default {
  ...cryptoBrowserify,
  timingSafeEqual,
};

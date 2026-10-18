// Hex and 32-byte helpers for the go-live signer. No network, no key logging.

/** @param {string} hex */
export function hexToBytes(hex) {
  const h = String(hex).trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]*$/.test(h) || h.length % 2 !== 0) throw new Error("invalid hex");
  return Buffer.from(h, "hex");
}

/** @param {Uint8Array} bytes */
export function bytesToHex(bytes) {
  return "0x" + Buffer.from(bytes).toString("hex");
}

/** @param {bigint} n @param {number} [len] */
export function bigToBytes(n, len = 32) {
  if (n < 0n) throw new Error("negative");
  const hex = n.toString(16).padStart(len * 2, "0");
  if (hex.length > len * 2) throw new Error("integer does not fit");
  return Buffer.from(hex, "hex");
}

/** @param {Uint8Array} bytes */
export function bytesToBig(bytes) {
  const hex = Buffer.from(bytes).toString("hex");
  return hex.length ? BigInt("0x" + hex) : 0n;
}

/** Left-pad an address or smaller integer to 32 bytes. @param {string | bigint | Uint8Array} v */
export function word(v) {
  if (typeof v === "bigint") return bigToBytes(v, 32);
  if (typeof v === "string") {
    const b = hexToBytes(v);
    if (b.length > 32) throw new Error("word too wide");
    return Buffer.concat([Buffer.alloc(32 - b.length), b]);
  }
  if (v.length > 32) throw new Error("word too wide");
  return Buffer.concat([Buffer.alloc(32 - v.length), v]);
}

/** @param {Uint8Array[]} parts */
export function concat(parts) {
  return Buffer.concat(parts.map((p) => Buffer.from(p)));
}

/** @param {string} addr */
export function assertAddress(addr) {
  const raw = String(addr).trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) throw new Error(`invalid address: ${raw.slice(0, 12)}`);
  return raw.toLowerCase();
}

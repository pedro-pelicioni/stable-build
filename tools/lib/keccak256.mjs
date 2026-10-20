// Keccak-256 (Ethereum, not NIST SHA3). Padding domain byte is 0x01.
// Checked against the empty-string, "abc" and "hello" vectors in test/go-live-registry/sign.test.mjs.

import { bytesToHex } from "./bytes.mjs";

const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

const ROT = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
];

const MASK64 = (1n << 64n) - 1n;

function rotl(x, n) {
  const s = BigInt(n);
  return ((x << s) | (x >> (64n - s))) & MASK64;
}

function keccakF(a) {
  for (let round = 0; round < 24; round++) {
    const c = new Array(5);
    for (let x = 0; x < 5; x++) c[x] = a[x] ^ a[x + 5] ^ a[x + 10] ^ a[x + 15] ^ a[x + 20];
    const d = new Array(5);
    for (let x = 0; x < 5; x++) d[x] = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
    for (let i = 0; i < 25; i++) a[i] ^= d[i % 5];

    const b = new Array(25);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        b[y + ((2 * x + 3 * y) % 5) * 5] = rotl(a[x + 5 * y], ROT[x][y]);
      }
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        const i = x + 5 * y;
        a[i] = b[i] ^ (~b[((x + 1) % 5) + 5 * y] & b[((x + 2) % 5) + 5 * y]);
        a[i] &= MASK64;
      }
    }
    a[0] ^= RC[round];
  }
  return a;
}

function loadLane(bytes, offset) {
  let n = 0n;
  for (let i = 0; i < 8; i++) n |= BigInt(bytes[offset + i] ?? 0) << (8n * BigInt(i));
  return n;
}

function storeLane(n, out, offset) {
  let x = n;
  for (let i = 0; i < 8; i++) {
    out[offset + i] = Number(x & 0xffn);
    x >>= 8n;
  }
}

/** @param {Uint8Array | string} input UTF-8 string or bytes. @returns {Buffer} 32 bytes */
export function keccak256(input) {
  const msg = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  const rate = 136;
  const paddedLen = Math.floor((msg.length + 1 + rate - 1) / rate) * rate || rate;
  // keccak256 of empty input still needs one block
  const padded = Buffer.alloc(Math.max(paddedLen, rate));
  msg.copy(padded);
  padded[msg.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;

  const state = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) state[i] ^= loadLane(padded, off + i * 8);
    keccakF(state);
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) storeLane(state[i], out, i * 8);
  return out;
}

/** @param {Uint8Array | string} input */
export function keccak256Hex(input) {
  return bytesToHex(keccak256(input));
}

/** EIP-55 checksummed address. @param {string} addr */
export function checksumAddress(addr) {
  const raw = String(addr).replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(raw)) throw new Error("invalid address");
  const hash = keccak256(raw).toString("hex");
  let out = "0x";
  for (let i = 0; i < 40; i++) out += Number.parseInt(hash[i], 16) >= 8 ? raw[i].toUpperCase() : raw[i];
  return out;
}

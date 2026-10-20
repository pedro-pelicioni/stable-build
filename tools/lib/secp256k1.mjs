// Minimal secp256k1 sign and recover for the go-live verifier.
// Affine arithmetic. Signatures are low-s, RFC 6979 (HMAC-SHA256), v in {27, 28}.
// A candidate whose curve x is >= n is skipped so v never needs the rare 29/30 form.
// Anchored in tests to OpenSSL's public key for the public Anvil test key.

import crypto from "node:crypto";
import { bigToBytes, bytesToBig, bytesToHex, concat, hexToBytes } from "./bytes.mjs";
import { keccak256 } from "./keccak256.mjs";

export const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
export const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const Gx = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
const Gy = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;
const G = { x: Gx, y: Gy };
const HALF_N = N >> 1n;

function mod(a, m) {
  const r = a % m;
  return r >= 0n ? r : r + m;
}

function inv(a, m) {
  let t = 0n;
  let newt = 1n;
  let r = m;
  let newr = mod(a, m);
  while (newr !== 0n) {
    const q = r / newr;
    [t, newt] = [newt, t - q * newt];
    [r, newr] = [newr, r - q * newr];
  }
  if (r !== 1n) throw new Error("not invertible");
  return mod(t, m);
}

function add(P1, P2) {
  if (!P1) return P2;
  if (!P2) return P1;
  if (P1.x === P2.x) {
    if (P1.y !== P2.y || P1.y === 0n) return null;
    return dbl(P1);
  }
  const lam = mod((P2.y - P1.y) * inv(P2.x - P1.x, P), P);
  const x = mod(lam * lam - P1.x - P2.x, P);
  const y = mod(lam * (P1.x - x) - P1.y, P);
  return { x, y };
}

function dbl(Pt) {
  if (!Pt || Pt.y === 0n) return null;
  const lam = mod(3n * Pt.x * Pt.x * inv(2n * Pt.y, P), P);
  const x = mod(lam * lam - 2n * Pt.x, P);
  const y = mod(lam * (Pt.x - x) - Pt.y, P);
  return { x, y };
}

function mul(Pt, k) {
  let R = null;
  let Q = Pt;
  let n = k;
  while (n > 0n) {
    if (n & 1n) R = add(R, Q);
    Q = dbl(Q);
    n >>= 1n;
  }
  return R;
}

function decompress(x, parity) {
  if (x >= P) throw new Error("x out of range");
  const y2 = mod(mod(x * x, P) * x + 7n, P);
  let y = modPow(y2, (P + 1n) / 4n, P);
  if (mod(y * y, P) !== y2) throw new Error("point not on curve");
  if ((y & 1n) !== BigInt(parity)) y = mod(-y, P);
  return { x, y };
}

function modPow(base, exp, m) {
  let result = 1n;
  let b = mod(base, m);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = mod(result * b, m);
    b = mod(b * b, m);
    e >>= 1n;
  }
  return result;
}

function hmac(key, ...parts) {
  const h = crypto.createHmac("sha256", key);
  for (const p of parts) h.update(p);
  return h.digest();
}

/** RFC 6979 k for a 32-byte message hash and a 32-byte private key. */
function rfc6979(digest, priv) {
  const x = bigToBytes(bytesToBig(priv), 32);
  const h1 = Buffer.from(digest);
  let V = Buffer.alloc(32, 0x01);
  let K = Buffer.alloc(32, 0x00);
  K = hmac(K, V, Buffer.from([0x00]), x, h1);
  V = hmac(K, V);
  K = hmac(K, V, Buffer.from([0x01]), x, h1);
  V = hmac(K, V);
  for (let i = 0; i < 64; i++) {
    let T = Buffer.alloc(0);
    while (T.length < 32) {
      V = hmac(K, V);
      T = Buffer.concat([T, V]);
    }
    const k = bytesToBig(T.subarray(0, 32));
    if (k > 0n && k < N) {
      const R = mul(G, k);
      if (R && mod(R.x, N) !== 0n && R.x < N) return { k, R };
    }
    K = hmac(K, V, Buffer.from([0x00]));
    V = hmac(K, V);
  }
  throw new Error("rfc6979 failed");
}

function parsePriv(priv) {
  const b = typeof priv === "string" ? hexToBytes(priv) : Buffer.from(priv);
  if (b.length !== 32) throw new Error("private key must be 32 bytes");
  const d = bytesToBig(b);
  if (d <= 0n || d >= N) throw new Error("private key out of range");
  return { bytes: b, d };
}

/** Uncompressed public key point. @param {string | Uint8Array} priv */
export function publicKey(priv) {
  const { d } = parsePriv(priv);
  const Q = mul(G, d);
  if (!Q) throw new Error("public key at infinity");
  return Q;
}

/** Last 20 bytes of keccak256(x || y), lowercase 0x address. */
export function addressFromPrivate(priv) {
  return addressFromPoint(publicKey(priv));
}

function addressFromPoint(Q) {
  const hash = keccak256(concat([bigToBytes(Q.x, 32), bigToBytes(Q.y, 32)]));
  return "0x" + hash.subarray(12).toString("hex");
}

/**
 * Sign a 32-byte digest. Returns { r, s, v, signature } where signature is 65 bytes
 * and v is 27 or 28. s is in the lower half of the curve order.
 * @param {Uint8Array} digest
 * @param {string | Uint8Array} priv
 */
export function signDigest(digest, priv) {
  const msg = Buffer.from(digest);
  if (msg.length !== 32) throw new Error("digest must be 32 bytes");
  const { bytes, d } = parsePriv(priv);
  const { k, R } = rfc6979(msg, bytes);
  const r = mod(R.x, N);
  const z = bytesToBig(msg);
  let s = mod(inv(k, N) * mod(z + r * d, N), N);
  if (s === 0n) throw new Error("bad signature");
  let recid = (R.y & 1n) === 1n ? 1 : 0;
  if (s > HALF_N) {
    s = N - s;
    recid ^= 1;
  }
  const v = 27 + recid;
  const signature = concat([bigToBytes(r, 32), bigToBytes(s, 32), Buffer.from([v])]);
  return { r, s, v, signature, signatureHex: bytesToHex(signature) };
}

/**
 * Recover the signer address (lowercase) from a 32-byte digest and a 65-byte signature.
 * Rejects high-s and v outside 27/28 (after accepting 0/1 as an alias of 27/28).
 * @param {Uint8Array} digest
 * @param {Uint8Array} signature
 */
export function recoverAddress(digest, signature) {
  const sig = Buffer.from(signature);
  const msg = Buffer.from(digest);
  if (msg.length !== 32 || sig.length !== 65) throw new Error("bad signature length");
  const r = bytesToBig(sig.subarray(0, 32));
  const s = bytesToBig(sig.subarray(32, 64));
  let v = sig[64];
  if (v < 27) v += 27;
  if (v !== 27 && v !== 28) throw new Error("bad recovery id");
  if (r === 0n || r >= N || s === 0n || s > HALF_N) throw new Error("malleable or zero signature");
  const recid = v - 27;
  const x = r + BigInt(recid >> 1) * N;
  const R = decompress(x, recid & 1);
  const z = bytesToBig(msg);
  const rInv = inv(r, N);
  const sR = mul(R, s);
  const zG = mul(G, z);
  const neg = zG ? { x: zG.x, y: mod(-zG.y, P) } : null;
  const Q = mulPoint(add(sR, neg), rInv);
  if (!Q) throw new Error("recover failed");
  return addressFromPoint(Q);
}

function mulPoint(Pt, k) {
  return mul(Pt, k);
}

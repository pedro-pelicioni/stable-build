#!/usr/bin/env node
// Sign a go-live badge for GoLiveRegistry.
//
// Reads the report (or the go-live evidence collector), hashes it, builds the
// 14-gate bitmap, and signs EIP-712 typed data with STABLE_BUILD_VERIFIER_KEY.
// The key is never printed and must not live in a VITE_* variable.
//
//   node tools/go-live-sign.mjs \
//     --report docs/go-live-report.md \
//     --project 0xProject --registry 0xRegistry \
//     --chain-id 5042 --expiry 1893456000 --nonce 1 --fee 10000
//
// Exit 0 when a signature is produced. Exit 1 when a gate is fail or unknown
// (the JSON is still printed, without a signature). Exit 2 on usage errors.
// Nothing is broadcast. `value` in the payload is always "0": the fee moves
// through the 6-decimal USDC ERC-20, not native value.

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertAddress, bytesToHex, concat, hexToBytes, word } from "./lib/bytes.mjs";
import { checksumAddress, keccak256 } from "./lib/keccak256.mjs";
import { addressFromPrivate, recoverAddress, signDigest } from "./lib/secp256k1.mjs";

export const REGISTRY_NAME = "GoLiveRegistry";
export const REGISTRY_VERSION = "1";
export const USDC = "0x3600000000000000000000000000000000000000";
export const MAX_FEE = 10_000_000n;
export const GATE_COUNT = 14;
export const DOMAIN_TYPE = "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";
export const REGISTRATION_TYPE =
  "Registration(address project,uint256 chainId,bytes32 reportHash,uint16 gates,uint64 expiry,uint256 nonce)";

const DOMAIN_TYPEHASH = keccak256(DOMAIN_TYPE);
const REGISTRATION_TYPEHASH = keccak256(REGISTRATION_TYPE);
const NAME_HASH = keccak256(REGISTRY_NAME);
const VERSION_HASH = keccak256(REGISTRY_VERSION);
const REGISTER_SELECTOR = keccak256("register(address,uint256,bytes32,uint16,uint64,uint256,bytes)").subarray(0, 4);
const APPROVE_SELECTOR = keccak256("approve(address,uint256)").subarray(0, 4);

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..");

/** @param {Uint8Array | string} input */
export function keccak256Hex(input) {
  return bytesToHex(keccak256(input));
}

/**
 * EIP-712 digest. `gates` and `expiry` are encoded as uint256, matching abi.encode.
 * @param {object} p
 */
export function hashRegistration(p) {
  const domainSeparator = keccak256(
    concat([
      DOMAIN_TYPEHASH,
      NAME_HASH,
      VERSION_HASH,
      word(BigInt(p.domainChainId)),
      word(assertAddress(p.verifyingContract)),
    ]),
  );
  const structHash = keccak256(
    concat([
      REGISTRATION_TYPEHASH,
      word(assertAddress(p.project)),
      word(BigInt(p.chainId)),
      word(p.reportHash),
      word(BigInt(p.gates)),
      word(BigInt(p.expiry)),
      word(BigInt(p.nonce)),
    ]),
  );
  return keccak256(concat([Buffer.from([0x19, 0x01]), domainSeparator, structHash]));
}

/** Bit 0 is G1. Only `pass` sets a bit. `fail`, `unknown` and `n/a` stay clear. */
export function bitmapFromStatuses(statuses) {
  let bits = 0;
  for (let i = 1; i <= GATE_COUNT; i++) {
    const s = String(statuses[i] ?? statuses[`G${i}`] ?? "").trim().toLowerCase();
    if (s === "pass") bits |= 1 << (i - 1);
  }
  return bits;
}

/** @param {string} markdown */
export function statusesFromReport(markdown) {
  const statuses = {};
  for (const line of String(markdown).split(/\r?\n/)) {
    const m = /^\|\s*G(\d{1,2})\b[^|]*\|\s*\**\s*(pass|fail|unknown|n\/a)\b/i.exec(line);
    if (!m) continue;
    const n = Number(m[1]);
    if (n >= 1 && n <= GATE_COUNT) statuses[`G${n}`] = m[2].toLowerCase();
  }
  return statuses;
}

/** @param {string | object} evidence JSON text or object from evidence.mjs */
export function statusesFromEvidence(evidence) {
  const json = typeof evidence === "string" ? JSON.parse(evidence) : evidence;
  const statuses = {};
  for (const g of json.gates || []) {
    const m = /^G(\d{1,2})$/.exec(String(g.id || ""));
    if (!m) continue;
    const n = Number(m[1]);
    if (n >= 1 && n <= GATE_COUNT) statuses[`G${n}`] = String(g.status || "").toLowerCase();
  }
  return statuses;
}

/** Gates that are missing, `fail` or `unknown`. `n/a` is allowed and does not set a bit. */
export function gateProblems(statuses) {
  const problems = [];
  for (let i = 1; i <= GATE_COUNT; i++) {
    const s = statuses[`G${i}`];
    if (!s) problems.push(`G${i} missing`);
    else if (s === "fail" || s === "unknown") problems.push(`G${i} ${s}`);
    else if (s !== "pass" && s !== "n/a") problems.push(`G${i} ${s}`);
  }
  return problems;
}

export function encodeRegisterCall(message, signatureHex) {
  const sig = hexToBytes(signatureHex);
  const head = [
    word(assertAddress(message.project)),
    word(BigInt(message.chainId)),
    word(message.reportHash),
    word(BigInt(message.gates)),
    word(BigInt(message.expiry)),
    word(BigInt(message.nonce)),
    word(224n),
  ];
  const padded = Buffer.concat([sig, Buffer.alloc((32 - (sig.length % 32)) % 32)]);
  return bytesToHex(concat([REGISTER_SELECTOR, ...head, word(BigInt(sig.length)), padded]));
}

export function encodeApproveCall(spender, amount) {
  return bytesToHex(concat([APPROVE_SELECTOR, word(assertAddress(spender)), word(BigInt(amount))]));
}

/**
 * Build the JSON payload. `privateKey` is optional; when present it is used to
 * sign and is not copied into the result.
 */
export function buildPayload({
  project,
  registry,
  chainId,
  expiry,
  nonce,
  fee,
  reportBytes,
  reportHashSource,
  statuses,
  privateKey,
  allowPartial,
}) {
  const problems = gateProblems(statuses);
  const gates = bitmapFromStatuses(statuses);
  const reportHash = bytesToHex(keccak256(reportBytes));
  const message = {
    project: checksumAddress(project),
    chainId: String(chainId),
    reportHash,
    gates: String(gates),
    expiry: String(expiry),
    nonce: String(nonce),
  };
  const digest = hashRegistration({
    verifyingContract: registry,
    domainChainId: chainId,
    project,
    chainId,
    reportHash,
    gates,
    expiry,
    nonce,
  });
  const blocked = [];
  if (!allowPartial && problems.length) blocked.push(...problems);
  if (gates === 0) blocked.push("no gate passed");
  if (fee > MAX_FEE) blocked.push(`fee ${fee} is above ${MAX_FEE} (10 USDC, 6 decimals)`);

  const payload = {
    purpose: "GoLiveRegistry.register",
    usdc: checksumAddress(USDC),
    usdcDecimals: 6,
    nativeValue: "0",
    fee: String(fee),
    domain: {
      name: REGISTRY_NAME,
      version: REGISTRY_VERSION,
      chainId: String(chainId),
      verifyingContract: checksumAddress(registry),
    },
    message,
    gates: { ...statuses },
    bitmap: "0x" + gates.toString(16),
    reportHashSource,
    digest: bytesToHex(digest),
    signed: false,
  };
  if (blocked.length) {
    payload.blocked = blocked;
    return payload;
  }
  if (!privateKey) {
    payload.note = "unsigned: set STABLE_BUILD_VERIFIER_KEY to sign";
    return payload;
  }
  const signed = signDigest(digest, privateKey);
  const recovered = recoverAddress(digest, signed.signature);
  const verifier = addressFromPrivate(privateKey);
  if (recovered !== verifier) throw new Error("signature did not recover to the verifier");
  payload.signed = true;
  payload.verifier = checksumAddress(verifier);
  payload.signature = signed.signatureHex;
  if (fee > 0n) {
    payload.approve = {
      to: checksumAddress(USDC),
      data: encodeApproveCall(registry, fee),
      value: "0",
    };
  }
  payload.register = {
    to: checksumAddress(registry),
    data: encodeRegisterCall(message, signed.signatureHex),
    value: "0",
  };
  payload.note =
    "Approve `fee` base units (6 decimals) on the USDC ERC-20, then send `register`. Do not attach native value.";
  return payload;
}

function refuseViteKeys() {
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("VITE_")) continue;
    if (/^(0x)?[0-9a-fA-F]{64}$/.test(String(v ?? "").trim())) {
      console.error(`refusing to run: ${k} looks like a private key. Never put a key in a VITE_* variable.`);
      return false;
    }
  }
  return true;
}

function readKey() {
  const raw = process.env.STABLE_BUILD_VERIFIER_KEY;
  if (!raw) return null;
  const hex = String(raw).trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    console.error("STABLE_BUILD_VERIFIER_KEY must be 32 bytes of hex");
    return false;
  }
  return hex.toLowerCase();
}

function usage() {
  console.log(`usage: node tools/go-live-sign.mjs --project 0x --registry 0x --chain-id N --expiry UNIX --nonce N [--report FILE] [--from-evidence] [--dir DIR] [--fee 10000] [--allow-partial] [--unsigned]

STABLE_BUILD_VERIFIER_KEY   32-byte hex verifier key. Never a VITE_* variable. Omitted with --unsigned.
--report FILE                bytes that are hashed (default: <dir>/docs/go-live-report.md)
--from-evidence              gate statuses come from evidence.mjs. The report file is still hashed when it exists.
--fee N                      USDC base units, 6 decimals (default 10000 = 0.01 USDC). Not 18-decimal native units.
--allow-partial              sign even if a gate is fail, unknown or missing
--unsigned                   digest and bitmap only; do not read a key`);
}

export function main(argv, env = process.env) {
  // `env` is accepted so tests can pass a copy. The process environment is what refuseViteKeys reads
  // when called from the CLI; tests call buildPayload directly.
  void env;
  if (!refuseViteKeys()) return 2;
  const opt = {
    dir: ".",
    report: null,
    fromEvidence: false,
    project: null,
    registry: null,
    chainId: null,
    expiry: null,
    nonce: null,
    fee: 10_000n,
    allowPartial: false,
    unsigned: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`missing value for ${a}`);
      return argv[++i];
    };
    if (a === "--help" || a === "-h") opt.help = true;
    else if (a === "--from-evidence") opt.fromEvidence = true;
    else if (a === "--allow-partial") opt.allowPartial = true;
    else if (a === "--unsigned") opt.unsigned = true;
    else if (a === "--dir") opt.dir = next();
    else if (a.startsWith("--dir=")) opt.dir = a.slice("--dir=".length);
    else if (a === "--report") opt.report = next();
    else if (a.startsWith("--report=")) opt.report = a.slice("--report=".length);
    else if (a === "--project") opt.project = next();
    else if (a.startsWith("--project=")) opt.project = a.slice("--project=".length);
    else if (a === "--registry") opt.registry = next();
    else if (a.startsWith("--registry=")) opt.registry = a.slice("--registry=".length);
    else if (a === "--chain-id") opt.chainId = next();
    else if (a.startsWith("--chain-id=")) opt.chainId = a.slice("--chain-id=".length);
    else if (a === "--expiry") opt.expiry = next();
    else if (a.startsWith("--expiry=")) opt.expiry = a.slice("--expiry=".length);
    else if (a === "--nonce") opt.nonce = next();
    else if (a.startsWith("--nonce=")) opt.nonce = a.slice("--nonce=".length);
    else if (a === "--fee") opt.fee = BigInt(next());
    else if (a.startsWith("--fee=")) opt.fee = BigInt(a.slice("--fee=".length));
    else {
      console.error(`unknown option: ${a}`);
      return 2;
    }
  }
  if (opt.help) {
    usage();
    return 0;
  }
  try {
    if (!opt.project || !opt.registry || opt.chainId == null || opt.expiry == null || opt.nonce == null) {
      usage();
      return 2;
    }
    const dir = path.resolve(opt.dir);
    const reportPath = path.resolve(dir, opt.report || path.join("docs", "go-live-report.md"));
    let reportBytes = null;
    let reportHashSource = null;
    try {
      reportBytes = readFileSync(reportPath);
      reportHashSource = path.relative(dir, reportPath).split(path.sep).join("/") || reportPath;
    } catch {
      reportBytes = null;
    }
    let statuses;
    if (opt.fromEvidence) {
      const script = path.join(REPO_ROOT, "plugins", "stable-build", "skills", "go-live", "scripts", "evidence.mjs");
      const child = spawnSync(process.execPath, [script, `--dir=${dir}`, "--format=json"], {
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      });
      if (!child.stdout) {
        console.error(child.stderr || "evidence collector produced no output");
        return 2;
      }
      statuses = statusesFromEvidence(child.stdout);
      if (!reportBytes) {
        reportBytes = Buffer.from(child.stdout, "utf8");
        reportHashSource = "evidence.mjs stdout";
      }
    } else if (!reportBytes) {
      console.error(`report not found: ${reportPath}`);
      return 2;
    } else {
      statuses = statusesFromReport(reportBytes.toString("utf8"));
    }
    let key = null;
    if (!opt.unsigned) {
      key = readKey();
      if (key === false) return 2;
      if (key == null) {
        console.error("set STABLE_BUILD_VERIFIER_KEY, or pass --unsigned");
        return 2;
      }
    }
    const chainId = BigInt(opt.chainId);
    const expiry = BigInt(opt.expiry);
    const nonce = BigInt(opt.nonce);
    if (chainId < 0n || expiry < 0n || nonce < 0n || opt.fee < 0n) {
      console.error("chain id, expiry, nonce and fee must be non-negative integers");
      return 2;
    }
    const payload = buildPayload({
      project: opt.project,
      registry: opt.registry,
      chainId,
      expiry,
      nonce,
      fee: opt.fee,
      reportBytes,
      reportHashSource,
      statuses,
      privateKey: key,
      allowPartial: opt.allowPartial,
    });
    console.log(JSON.stringify(payload, null, 2));
    return payload.blocked ? 1 : 0;
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.error(msg.replace(/[0-9a-fA-F]{64}/g, "<redacted>"));
    return 2;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) process.exitCode = main(process.argv.slice(2));

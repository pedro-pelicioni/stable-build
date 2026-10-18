// Signer and deploy-script guards for the go-live registry.
// The signing key in this file is Anvil's published account 0. It is not a secret.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  USDC,
  bitmapFromStatuses,
  buildPayload,
  encodeRegisterCall,
  hashRegistration,
  keccak256Hex,
  main,
  statusesFromReport,
} from "../../tools/go-live-sign.mjs";
import { addressFromPrivate, recoverAddress } from "../../tools/lib/secp256k1.mjs";
import { hexToBytes } from "../../tools/lib/bytes.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ANVIL_TEST_KEY = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const VECTOR = JSON.parse(
  readFileSync(path.join(ROOT, "contracts/go-live-registry/test/vectors/registration.json"), "utf8"),
);

function report(statuses) {
  const lines = ["| Gate | Status |", "|---|---|"];
  for (let i = 1; i <= 14; i++) lines.push(`| G${i} | ${statuses[i - 1]} |`);
  return lines.join("\n") + "\n";
}

describe("keccak and the shared registration vector", () => {
  test("keccak256 matches the empty, abc and hello vectors", () => {
    assert.equal(keccak256Hex(""), "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
    assert.equal(keccak256Hex("abc"), "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
    assert.equal(keccak256Hex("hello"), "0x1c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8");
  });

  test("the public test key recovers to the vector verifier", () => {
    assert.equal(addressFromPrivate(ANVIL_TEST_KEY), VECTOR.verifier);
  });

  test("hashRegistration matches the contract digest and the signature recovers", () => {
    const digest = hashRegistration({
      verifyingContract: VECTOR.verifyingContract,
      domainChainId: BigInt(VECTOR.domainChainId),
      project: VECTOR.project,
      chainId: BigInt(VECTOR.chainId),
      reportHash: VECTOR.reportHash,
      gates: BigInt(VECTOR.gates),
      expiry: BigInt(VECTOR.expiry),
      nonce: BigInt(VECTOR.nonce),
    });
    assert.equal(keccak256Hex(VECTOR.preimage), VECTOR.reportHash);
    assert.equal("0x" + Buffer.from(digest).toString("hex"), VECTOR.digest);
    assert.equal(recoverAddress(digest, hexToBytes(VECTOR.signature)), VECTOR.verifier);
  });

  test("RFC 6979 reproduces the shared signature bytes", () => {
    const allPass = report(Array.from({ length: 14 }, () => "pass"));
    const payload = buildPayload({
      project: VECTOR.project,
      registry: VECTOR.verifyingContract,
      chainId: BigInt(VECTOR.chainId),
      expiry: BigInt(VECTOR.expiry),
      nonce: BigInt(VECTOR.nonce),
      fee: 10_000n,
      reportBytes: Buffer.from(VECTOR.preimage, "utf8"),
      reportHashSource: "vector",
      statuses: statusesFromReport(allPass),
      privateKey: ANVIL_TEST_KEY,
      allowPartial: false,
    });
    assert.equal(payload.signed, true);
    assert.equal(payload.digest, VECTOR.digest);
    assert.equal(payload.signature, VECTOR.signature);
    assert.equal(payload.verifier.toLowerCase(), VECTOR.verifier);
    assert.equal(payload.usdcDecimals, 6);
    assert.equal(payload.nativeValue, "0");
    assert.equal(payload.register.value, "0");
    assert.equal(payload.approve.value, "0");
    assert.equal(payload.approve.to.toLowerCase(), USDC);
    assert.equal(payload.message.gates, "16383");
    assert.equal(payload.message.reportHash, VECTOR.reportHash);
    assert.ok(!JSON.stringify(payload).includes(ANVIL_TEST_KEY));
    const digest = hexToBytes(payload.digest);
    assert.equal(recoverAddress(digest, hexToBytes(payload.signature)), VECTOR.verifier);
    assert.equal(encodeRegisterCall(payload.message, payload.signature), payload.register.data);
    assert.equal(payload.register.data.slice(0, 10), keccak256Hex("register(address,uint256,bytes32,uint16,uint64,uint256,bytes)").slice(0, 10));
  });
});

describe("gate bitmap", () => {
  test("only pass sets a bit; n/a stays clear", () => {
    const statuses = statusesFromReport(report(["pass", "n/a", "pass", "pass", "pass", "pass", "pass", "pass", "pass", "pass", "pass", "pass", "pass", "pass"]));
    assert.equal(bitmapFromStatuses(statuses), 16383 ^ 2);
    const payload = buildPayload({
      project: VECTOR.project,
      registry: VECTOR.verifyingContract,
      chainId: 5042n,
      expiry: 1893456000n,
      nonce: 2n,
      fee: 0n,
      reportBytes: Buffer.from("partial"),
      reportHashSource: "partial",
      statuses,
      privateKey: ANVIL_TEST_KEY,
      allowPartial: false,
    });
    assert.equal(payload.signed, true);
    assert.equal(payload.approve, undefined);
    assert.equal(payload.register.value, "0");
  });

  test("fail and unknown block the signature unless allow-partial is set", () => {
    const statuses = statusesFromReport(report(Array.from({ length: 14 }, (_, i) => (i === 3 ? "fail" : "pass"))));
    const blocked = buildPayload({
      project: VECTOR.project,
      registry: VECTOR.verifyingContract,
      chainId: 5042n,
      expiry: 1893456000n,
      nonce: 3n,
      fee: 10_000n,
      reportBytes: Buffer.from("blocked"),
      reportHashSource: "blocked",
      statuses,
      privateKey: ANVIL_TEST_KEY,
      allowPartial: false,
    });
    assert.equal(blocked.signed, false);
    assert.ok(blocked.blocked.includes("G4 fail"));
    assert.equal(blocked.signature, undefined);

    const allowed = buildPayload({
      project: VECTOR.project,
      registry: VECTOR.verifyingContract,
      chainId: 5042n,
      expiry: 1893456000n,
      nonce: 3n,
      fee: 10_000n,
      reportBytes: Buffer.from("blocked"),
      reportHashSource: "blocked",
      statuses,
      privateKey: ANVIL_TEST_KEY,
      allowPartial: true,
    });
    assert.equal(allowed.signed, true);
    assert.equal(recoverAddress(hexToBytes(allowed.digest), hexToBytes(allowed.signature)), VECTOR.verifier);
  });
});

describe("CLI", () => {
  const cli = path.join(ROOT, "tools/go-live-sign.mjs");

  function run(args, env) {
    return spawnSync(process.execPath, [cli, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
  }

  test("--unsigned prints a digest and does not read a key", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "go-live-sign-"));
    writeFileSync(path.join(dir, "docs-report.md"), report(Array.from({ length: 14 }, () => "pass")));
    const child = run(
      [
        "--unsigned",
        "--report", path.join(dir, "docs-report.md"),
        "--project", VECTOR.project,
        "--registry", VECTOR.verifyingContract,
        "--chain-id", "5042",
        "--expiry", "1893456000",
        "--nonce", "9",
        "--fee", "10000",
      ],
      { STABLE_BUILD_VERIFIER_KEY: "0x" + ANVIL_TEST_KEY },
    );
    assert.equal(child.status, 0, child.stderr);
    const payload = JSON.parse(child.stdout);
    assert.equal(payload.signed, false);
    assert.equal(payload.signature, undefined);
    assert.equal(payload.nativeValue, "0");
    assert.ok(!child.stdout.includes(ANVIL_TEST_KEY));
    assert.ok(!child.stderr.includes(ANVIL_TEST_KEY));
  });

  test("a failing gate exits 1 and omits the signature", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "go-live-sign-"));
    const body = report(Array.from({ length: 14 }, (_, i) => (i === 0 ? "unknown" : "pass")));
    writeFileSync(path.join(dir, "docs-report.md"), body);
    const child = run(
      [
        "--report", path.join(dir, "docs-report.md"),
        "--project", VECTOR.project,
        "--registry", VECTOR.verifyingContract,
        "--chain-id", "5042",
        "--expiry", "1893456000",
        "--nonce", "4",
      ],
      { STABLE_BUILD_VERIFIER_KEY: ANVIL_TEST_KEY },
    );
    assert.equal(child.status, 1, child.stderr);
    const payload = JSON.parse(child.stdout);
    assert.equal(payload.signed, false);
    assert.ok(payload.blocked.includes("G1 unknown"));
    assert.ok(!child.stdout.includes(ANVIL_TEST_KEY));
  });

  test("a VITE_ variable that looks like a key is refused and not printed", () => {
    const code = main(["--help"], process.env);
    assert.equal(code, 0);
    const previous = process.env.VITE_SIGNER;
    process.env.VITE_SIGNER = "0x" + ANVIL_TEST_KEY;
    try {
      const child = run(["--unsigned", "--project", VECTOR.project], { VITE_SIGNER: "0x" + ANVIL_TEST_KEY });
      assert.equal(child.status, 2);
      assert.match(child.stderr, /VITE_SIGNER/);
      assert.ok(!child.stderr.includes(ANVIL_TEST_KEY));
      assert.ok(!child.stdout.includes(ANVIL_TEST_KEY));
    } finally {
      if (previous === undefined) delete process.env.VITE_SIGNER;
      else process.env.VITE_SIGNER = previous;
    }
  });
});

describe("deploy.sh guards", () => {
  const script = path.join(ROOT, "contracts/go-live-registry/script/deploy.sh");

  function run(args, env) {
    return spawnSync("bash", [script, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
  }

  test("help exits 0", () => {
    const child = run(["--help"], {});
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /testnet\|mainnet/);
  });

  test("CI cannot broadcast", () => {
    const child = run(["--network", "testnet", "--broadcast"], { CI: "true" });
    assert.equal(child.status, 1);
    assert.match(child.stderr, /refusing to broadcast in CI/);
  });

  test("mainnet broadcast needs the typed phrase", () => {
    const child = run(["--network", "mainnet", "--broadcast"], { CI: "", GITHUB_ACTIONS: "", STABLE_BUILD_MAINNET_CONFIRM: "send real usdc" });
    assert.equal(child.status, 1);
    assert.match(child.stderr, /SEND REAL USDC/);
  });

  test("a VITE_ key is refused before any deploy tool runs", () => {
    const child = run(["--network", "testnet"], {
      CI: "",
      GITHUB_ACTIONS: "",
      VITE_DEPLOY: ANVIL_TEST_KEY,
    });
    assert.equal(child.status, 2);
    assert.match(child.stderr, /VITE_DEPLOY/);
    assert.ok(!child.stderr.includes(ANVIL_TEST_KEY));
  });

  test("missing addresses exit before arc-forge", () => {
    const child = run(["--network", "testnet"], {
      CI: "",
      GITHUB_ACTIONS: "",
      STABLE_BUILD_DEPLOYER_KEY: "",
      STABLE_BUILD_VERIFIER: "",
      STABLE_BUILD_TREASURY: "",
      VITE_DEPLOY: "",
    });
    assert.equal(child.status, 1);
    assert.match(child.stderr, /missing STABLE_BUILD_DEPLOYER_KEY/);
  });
});

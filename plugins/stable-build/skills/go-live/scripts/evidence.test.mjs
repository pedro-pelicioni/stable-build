// Tests for evidence.mjs gates that the review found too lenient or too strict (G1, G3, G4, G6, G7, G12).
// Each case builds a small project in a temp dir and reads the JSON report. Offline: no --online.
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE = path.join(HERE, "evidence.mjs");
const MAIN_FWD = "CBZL2IH7F6BIDAA3WBNXYKIXSATJGMSW7K5P5MJ6STX5RXN47TZJDF5T";

const roots = [];
after(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }); });

function project(files) {
  const root = mkdtempSync(path.join(os.tmpdir(), "sb-golive-"));
  roots.push(root);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  }
  return root;
}

function gates(files) {
  const root = project(files);
  // --plugin-root points at a directory without the guard, so G2 is "unknown" and fast
  const p = spawnSync(process.execPath, [EVIDENCE, `--dir=${root}`, "--format=json", `--plugin-root=${root}`],
    { encoding: "utf8", env: { PATH: process.env.PATH, HOME: root } });
  assert.ok(p.stdout, p.stderr);
  return Object.fromEntries(JSON.parse(p.stdout).gates.map((g) => [g.id, g]));
}

const SOL = { "contracts/V.sol": "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20;\ncontract V {}\n" };
const MAINNET = { "src/chain.ts": 'import { arc } from "viem/chains";\nexport const chain = arc;\n' };

describe("G1 Arc Foundry must run in Arc mode", () => {
  test("bare arc-forge test / arc-anvil with no Arc profile fails", () => {
    const g = gates({ ...SOL, "foundry.toml": '[profile.default]\nsrc = "contracts"\n',
      "package.json": '{ "scripts": { "test:contracts": "arc-forge test", "node": "arc-anvil" } }\n' });
    assert.equal(g.G1.status, "fail", g.G1.notes);
  });
  test("FOUNDRY_PROFILE=arc without [profile.arc] network = \"arc\" fails", () => {
    const g = gates({ ...SOL, "foundry.toml": '[profile.default]\nsrc = "contracts"\n',
      "package.json": '{ "scripts": { "test:contracts": "FOUNDRY_PROFILE=arc arc-forge test" } }\n' });
    assert.equal(g.G1.status, "fail", g.G1.notes);
  });
  test("FOUNDRY_PROFILE=arc with [profile.arc] network = \"arc\" passes", () => {
    const g = gates({ ...SOL, "foundry.toml": '[profile.default]\nsrc = "contracts"\n\n[profile.arc]\nnetwork = "arc"\n',
      "package.json": '{ "scripts": { "test:contracts": "FOUNDRY_PROFILE=arc arc-forge test" } }\n' });
    assert.equal(g.G1.status, "pass", g.G1.notes);
  });
  test("--network arc passes; a default profile with network = \"arc\" passes a bare command", () => {
    assert.equal(gates({ ...SOL, "foundry.toml": "[profile.default]\n", "scripts/test.sh": "#!/bin/sh\narc-forge test --network arc\narc-anvil --network arc &\n" }).G1.status, "pass");
    assert.equal(gates({ ...SOL, "foundry.toml": '[profile.default]\nnetwork = "arc"\n', "scripts/test.sh": "#!/bin/sh\narc-forge test\n" }).G1.status, "pass");
  });
  test("naming the tool in docs is not a command", () => {
    const g = gates({ ...SOL, "foundry.toml": '[profile.arc]\nnetwork = "arc"\n', "README.md": "Install Arc Foundry (`arc-forge`, `arc-anvil`).\n\nRun `FOUNDRY_PROFILE=arc arc-forge test`.\n" });
    assert.equal(g.G1.status, "pass", g.G1.notes);
  });
  test("no foundry.toml: a profile cannot be confirmed (unknown); an Arc fork passes", () => {
    assert.equal(gates({ ...SOL, "scripts/test.sh": "#!/bin/sh\nFOUNDRY_PROFILE=arc arc-forge test\n" }).G1.status, "unknown");
    assert.equal(gates({ ...SOL, "scripts/test.sh": "#!/bin/sh\narc-anvil --fork-url $ARC_RPC_URL\narc-forge test --fork-url https://rpc.testnet.arc.io\n" }).G1.status, "pass");
  });
});

describe("G12 Stellar burns need CctpForwarder in both fields", () => {
  test("viem positional burn to a user recipient fails even with the mainnet strkey present", () => {
    const g = gates({ ...MAINNET, "src/stellar.ts": `const CCTP_FORWARDER_MAINNET = "${MAIN_FWD}";\n` +
      "export const burn = (tm: any, amount: bigint, userG: `0x${string}`, fwd: `0x${string}`, usdc: `0x${string}`, hook: `0x${string}`) =>\n" +
      "  tm.write.depositForBurnWithHook([amount, 27, userG, usdc, fwd, 0n, 1000, hook]);\n" });
    assert.equal(g.G12.status, "fail", g.G12.notes);
  });
  test("object form with a user mintRecipient fails", () => {
    const g = gates({ ...MAINNET, "src/stellar.ts": `const FORWARDER = "${MAIN_FWD}";\n` +
      "export const params = (amount: bigint, user: `0x${string}`, fwd: `0x${string}`) => ({\n  amount, destinationDomain: 27, mintRecipient: user, destinationCaller: fwd,\n});\n" });
    assert.equal(g.G12.status, "fail", g.G12.notes);
  });
  test("both fields resolve to the mainnet forwarder: pass; only a forwarder-named parameter: unknown", () => {
    const ok = gates({ ...MAINNET, "src/stellar.ts": `const CCTP_FORWARDER_B32 = toBytes32("${MAIN_FWD}");\n` +
      "export const burn = (tm: any, amount: bigint, usdc: `0x${string}`) =>\n  tm.write.depositForBurn([amount, 27, CCTP_FORWARDER_B32, usdc, CCTP_FORWARDER_B32, 0n, 1000]);\n" });
    assert.equal(ok.G12.status, "pass", ok.G12.notes);
    const maybe = gates({ ...MAINNET, "src/stellar.ts": `export const ID = "${MAIN_FWD}";\n` +
      "export const burn = (tm: any, amount: bigint, forwarder: `0x${string}`, usdc: `0x${string}`) =>\n  tm.depositForBurn(amount, 27, forwarder, usdc, forwarder, 0n, 1000);\n" });
    assert.equal(maybe.G12.status, "unknown", maybe.G12.notes);
  });
  test("no domain-27 burn: n/a", () => {
    assert.equal(gates({ ...MAINNET, "src/x.ts": "export const stellarNote = 'not a burn';\n" }).G12.status, "n/a");
  });
});

describe("G3, G4, G6, G7", () => {
  test("G3: testnet USYC / TokenMinterV2 / CrossChainTokenService addresses are not a pass", () => {
    const g = gates({ ...MAINNET, "src/config.ts": 'export const USYC = "0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C";\nexport const MINTER = "0xb43db544E2c27092c107639Ad201b3dEfAbcF192";\n' });
    assert.equal(g.G3.status, "unknown", g.G3.notes);
    assert.match(g.G3.notes, /USYC \(testnet\)/);
  });
  test("G4: README prose about Arc Studio and mainnet is not a deploy path; an arc-studio run on mainnet is", () => {
    const prose = gates({ ...SOL, "README.md": "Note: arc-studio cannot deploy to mainnet; use arc-forge for mainnet.\n" });
    assert.notEqual(prose.G4.status, "fail", prose.G4.notes);
    const deploy = gates({ ...SOL, "scripts/deploy.sh": '#!/bin/sh\narc-studio run "deploy the vault to mainnet"\n' });
    assert.equal(deploy.G4.status, "fail", deploy.G4.notes);
  });
  test("G6: a 1 gwei tip next to a floored maxFeePerGas passes; 0 fails; Hardhat's in-process network is skipped", () => {
    const ok = gates({ ...MAINNET, "src/fees.ts": 'import { parseGwei } from "viem";\nconst FLOOR = parseGwei("20");\nexport const fees = (base: bigint) => ({ maxFeePerGas: base * 2n > FLOOR ? base * 2n : FLOOR, maxPriorityFeePerGas: parseGwei("1") });\n' });
    assert.equal(ok.G6.status, "pass", ok.G6.notes);
    const zero = gates({ ...MAINNET, "src/send.ts": "export const tx = { to: '0x0', maxFeePerGas: 0n };\n" });
    assert.equal(zero.G6.status, "fail", zero.G6.notes);
    const hh = gates({ ...MAINNET, "hardhat.config.ts": "export default { networks: { hardhat: { gasPrice: 0 }, arc: { url: 'https://rpc.mainnet.arc.io' } } };\n" });
    assert.equal(hh.G6.status, "pass", hh.G6.notes);
  });
  test("G7: reading both views in Promise.all is unknown; adding them on one line fails", () => {
    const read = gates({ "src/b.ts": "export const r = async (c: any, u: any, a: any) => { const [n, e] = await Promise.all([c.getBalance({ address: a }), u.read.balanceOf([a])]); return n; };\n" });
    assert.equal(read.G7.status, "unknown", read.G7.notes);
    const sum = gates({ "src/b.ts": "export const r = async (c: any, u: any, a: any) => (await c.getBalance({ address: a })) + (await u.read.balanceOf([a]));\n" });
    assert.equal(sum.G7.status, "fail", sum.G7.notes);
  });
});

describe("G14 program eligibility", () => {
  // A plugin root with only data/programs.json, so the gate reads these programs and nothing else.
  function g14(files, items) {
    const root = project(files);
    const plugin = project({ "data/programs.json": JSON.stringify({ items }) });
    const p = spawnSync(process.execPath, [EVIDENCE, `--dir=${root}`, "--format=json", `--plugin-root=${plugin}`],
      { encoding: "utf8", env: { PATH: process.env.PATH, HOME: root } });
    assert.ok(p.stdout, p.stderr);
    const r = JSON.parse(p.stdout);
    return { gate: r.gates.find((g) => g.id === "G14"), programs: r.programs };
  }
  const MICRO = { id: "m", name: "Microgrants", kind: "grant", valid_until: "2099-01-01", requires: { mainnet: true, public_repo: true }, source_url: "https://example.invalid/m" };
  const CLOSED = { ...MICRO, id: "c", name: "Closed cohort", kind: "accelerator", applications_closed: "2000-01-01", requires: { mainnet: true, public_repo: false } };

  test("an open mainnet + public-repo program and an unpublished app is not a pass, and says what is missing", () => {
    const { gate } = g14(MAINNET, [MICRO]);
    assert.equal(gate.status, "unknown", gate.notes);
    assert.match(gate.notes, /requirement not met: public repo \(no git remote `origin`\)/);
    assert.match(gate.notes, /requirement unconfirmed: deployed and working on Arc mainnet/);
    const nomain = g14({ "src/a.ts": "export const a = 1;\n" }, [MICRO]).gate;
    assert.match(nomain.notes, /requirement not met: deployed and working on Arc mainnet \(no mainnet config found\)/);
  });

  test("no open program that requires mainnet: clean wording passes; closed applications do not count as open", () => {
    assert.equal(g14(MAINNET, []).gate.status, "pass");
    const { gate, programs } = g14(MAINNET, [CLOSED]);
    assert.deepEqual(programs, []);
    assert.equal(gate.status, "pass", gate.notes);
  });
});

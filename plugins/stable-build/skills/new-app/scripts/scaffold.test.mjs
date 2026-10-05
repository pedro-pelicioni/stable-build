// node --test plugins/stable-build/skills/new-app/scripts/scaffold.test.mjs
// Fast checks only: no npm install, no network. The full template check
// (npm install + vitest + vite build in a temp copy) is documented in SKILL.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STARTERS, scaffold, validateName } from "./scaffold.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "scaffold.mjs");
const TEMPLATE = path.resolve(HERE, "..", "templates", "payouts");

function tmp() {
  return mkdtempSync(path.join(tmpdir(), "sb-new-app-"));
}

test("lists the payouts starter", () => {
  const out = JSON.parse(execFileSync(process.execPath, [SCRIPT, "--list", "--json"], { encoding: "utf8" }));
  assert.deepEqual(out.map((s) => s.id), ["payouts"]);
  assert.ok(out[0].docs.includes("https://docs.arc.io/arc/tutorials/batch-usdc-transfers"));
  assert.equal(STARTERS.payouts.templateVersion, 1);
});

test("scaffolds into a new directory, fills the name and writes project.json", () => {
  const root = tmp();
  try {
    const dir = path.join(root, "acme-payroll");
    const r = scaffold({ starter: "payouts", dir, name: "acme-payroll" });
    assert.equal(r.dir, path.resolve(dir));
    const project = JSON.parse(readFileSync(path.join(dir, ".stable-build", "project.json"), "utf8"));
    assert.deepEqual(project, { template: "payouts", templateVersion: 1, network: "testnet", app: "acme-payroll" });
    assert.equal(JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).name, "acme-payroll");
    assert.match(readFileSync(path.join(dir, "README.md"), "utf8"), /^# acme-payroll/);
    for (const f of ["AGENTS.md", "CLAUDE.md", ".gitignore", ".env.example", ".stable-build/guard.json", ".github/workflows/pages.yml", "src/core/plan.ts", "scripts/payout.ts", "scripts/e2e-testnet.ts", "test/fixtures/receipt-batch-2rows.json"])
      assert.ok(existsSync(path.join(dir, f)), `${f} copied`);
    assert.ok(!existsSync(path.join(dir, "node_modules")));
    const all = r.files.map((f) => readFileSync(path.join(dir, f), "utf8")).join("\n");
    assert.ok(!all.includes("{{APP_NAME}}"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("accepts an existing empty directory", () => {
  const root = tmp();
  try {
    scaffold({ starter: "payouts", dir: root, name: "empty-ok" });
    assert.ok(existsSync(path.join(root, "package.json")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refuses a non-empty directory and leaves it untouched (exit 2)", () => {
  const root = tmp();
  try {
    writeFileSync(path.join(root, "notes.txt"), "keep me");
    const res = spawnSync(process.execPath, [SCRIPT, "--starter", "payouts", "--dir", root, "--name", "x-app", "--json"], { encoding: "utf8" });
    assert.equal(res.status, 2);
    assert.equal(JSON.parse(res.stdout).ok, false);
    assert.deepEqual(readdirSync(root), ["notes.txt"]);
    assert.equal(readFileSync(path.join(root, "notes.txt"), "utf8"), "keep me");
    // A directory that only holds hidden files (e.g. .git) is not empty either.
    rmSync(path.join(root, "notes.txt"));
    writeFileSync(path.join(root, ".git"), "");
    assert.throws(() => scaffold({ starter: "payouts", dir: root, name: "x-app" }), /not empty/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("validates names and starters", () => {
  assert.equal(validateName("my-app"), null);
  for (const bad of ["My-App", "-x", "x-", "a b", "../x", "a--b", "", "x".repeat(51), "{{APP_NAME}}"]) assert.notEqual(validateName(bad), null, bad);
  const root = tmp();
  try {
    assert.throws(() => scaffold({ starter: "nope", dir: path.join(root, "a"), name: "a" }), /unknown starter/);
    assert.throws(() => scaffold({ starter: "payouts", dir: path.join(root, "a"), name: "Bad Name" }), /lowercase/);
    assert.throws(() => scaffold({ starter: "payouts", dir: path.join(TEMPLATE, "src"), name: "a" }), /plugin folder/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refuses a new directory inside the template or the plugin, and copies nothing (exit 1)", () => {
  const PLUGIN = path.resolve(HERE, "..", "..", "..");
  const before = readdirSync(TEMPLATE).sort();
  for (const dir of [
    path.join(TEMPLATE, "inner"),                 // would copy the template into itself
    path.join(TEMPLATE, "..", "newsub"),          // a new starter-like folder under templates/
    path.join(HERE, "..", "demo-payouts"),        // next to SKILL.md (agent ran from the skill folder)
    path.join(PLUGIN, "deep", "new", "app"),      // several levels that do not exist yet
  ]) {
    const res = spawnSync(process.execPath, [SCRIPT, "--starter", "payouts", "--dir", dir, "--name", "x-app", "--json"], { encoding: "utf8" });
    assert.equal(res.status, 1, `${dir}: ${res.stdout}${res.stderr}`);
    assert.match(JSON.parse(res.stdout).error, /plugin folder/);
    assert.equal(existsSync(dir), false, `${dir} was created`);
  }
  assert.deepEqual(readdirSync(TEMPLATE).sort(), before);
});

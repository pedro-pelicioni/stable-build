// node --test test/guard/guard.test.mjs
// Guard tests: fixtures, payload shapes, exit-code matrix (hook mode always exits 0 and reports findings as
// advisory JSON: hookSpecificOutput.additionalContext + systemMessage), suppression, session notice, consent, perf.
// Every run uses a temporary HOME and STABLE_BUILD_HOME; the real ~/.stable-build is never read or written.
// Optional: STABLE_BUILD_DOCS_SNAPSHOT=<file>[:<file>...] checks each evidence quote against local docs
// snapshots (llms-full.txt style). Optional: STABLE_BUILD_PERF_BUDGET_MS overrides the 150 ms p95 budget.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync, rmSync, symlinkSync, cpSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const PLUGIN = path.join(REPO, "plugins", "stable-build");
const RUN = path.join(PLUGIN, "scripts", "run.sh");
const GUARD = path.join(PLUGIN, "scripts", "guard.mjs");
const SESSION = path.join(PLUGIN, "scripts", "session-start.mjs");
const HOOKS = path.join(PLUGIN, "hooks", "hooks.json");
const SKILL = path.join(PLUGIN, "skills", "gotchas", "SKILL.md");
const CATALOG = JSON.parse(readFileSync(path.join(PLUGIN, "data", "gotchas.json"), "utf8"));
const FIXTURES = path.join(HERE, "fixtures");
const PAYLOADS = path.join(HERE, "payloads");
const SUFFIX = "advisory: the edit was applied; silence with `stable-build-ignore <id>`";

const { RULES, RULE_IDS } = await import(pathToFileURL(path.join(PLUGIN, "scripts", "guard", "rules.mjs")));
const { normalizePayload } = await import(pathToFileURL(path.join(PLUGIN, "scripts", "guard", "input.mjs")));
const guard = await import(pathToFileURL(GUARD));
const { arcMarker } = await import(pathToFileURL(path.join(PLUGIN, "scripts", "guard", "project.mjs")));

// ---------- sandbox helpers ----------

const tmpRoots = [];
function tmp(prefix = "sb-guard-") {
  const d = mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(d);
  return d;
}
after(() => { for (const d of tmpRoots) rmSync(d, { recursive: true, force: true }); });

/** A fake HOME with optional consent. Returns { home, env }. */
function sandbox({ consent = true, configText } = {}) {
  const home = tmp();
  const sbHome = path.join(home, ".stable-build");
  mkdirSync(sbHome, { recursive: true });
  if (configText != null) writeFileSync(path.join(sbHome, "config.json"), configText);
  else if (consent) writeFileSync(path.join(sbHome, "config.json"), JSON.stringify({ schemaVersion: 1, guard: true, consentAt: "2026-10-04T00:00:00Z" }));
  const env = {
    PATH: process.env.PATH, HOME: home, STABLE_BUILD_HOME: sbHome,
    CLAUDE_CONFIG_DIR: path.join(home, ".claude"), CODEX_HOME: path.join(home, ".codex"),
  };
  return { home, env };
}

/** A project inside the sandbox HOME. arc: "project.json" | "readme" | false. */
function project(home, { arc = "project.json", files = {}, guardJson } = {}) {
  const root = path.join(home, `proj-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(path.join(root, "src"), { recursive: true });
  if (arc === "project.json" || guardJson) mkdirSync(path.join(root, ".stable-build"), { recursive: true });
  if (arc === "project.json") writeFileSync(path.join(root, ".stable-build", "project.json"), '{"template":"payouts","templateVersion":1,"network":"testnet"}\n');
  if (arc === "readme") writeFileSync(path.join(root, "README.md"), "# demo\n\nRPC: https://rpc.testnet.arc.io (chain 5042002)\n");
  writeFileSync(path.join(root, "package.json"), '{"name":"demo","private":true}\n');
  if (guardJson) writeFileSync(path.join(root, ".stable-build", "guard.json"), JSON.stringify(guardJson));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  }
  return root;
}

function payload(name, root) {
  return readFileSync(path.join(PAYLOADS, `${name}.json`), "utf8").replaceAll("__ROOT__", root);
}

function writePayload(root, rel, content) {
  return JSON.stringify({
    session_id: "t", cwd: root, hook_event_name: "PostToolUse", tool_name: "Write",
    tool_input: { file_path: path.join(root, rel), content },
  });
}

function runSh(input, env, script = "guard") {
  return spawnSync("/bin/sh", [RUN, script], { input, env, encoding: "utf8" });
}

/**
 * The advisory JSON a hook run with findings prints on stdout. Checks the whole shape: exactly
 * systemMessage (one short line for the user) and hookSpecificOutput {hookEventName, additionalContext}
 * (the findings for the agent, at most 2,000 characters, ending with the advisory suffix).
 */
function advisory(stdout) {
  assert.ok(stdout && stdout.trim(), "expected advisory JSON on stdout");
  assert.ok(stdout.trim().startsWith("{") && stdout.trim().endsWith("}"), stdout);
  assert.equal(stdout.trim().split("\n").length, 1, "one JSON object on one line");
  const j = JSON.parse(stdout);
  assert.deepEqual(Object.keys(j).sort(), ["hookSpecificOutput", "systemMessage"]);
  assert.deepEqual(Object.keys(j.hookSpecificOutput).sort(), ["additionalContext", "hookEventName"]);
  assert.equal(j.hookSpecificOutput.hookEventName, "PostToolUse");
  const ctx = j.hookSpecificOutput.additionalContext;
  assert.equal(typeof ctx, "string");
  assert.ok(ctx.length <= 2000, `additionalContext length ${ctx.length}`);
  assert.ok(ctx.endsWith(SUFFIX));
  assert.match(ctx, /^stable-build guard: \d+ Arc gotchas? in the lines just written \(\d+ error, \d+ warn\)\./);
  const notice = j.systemMessage;
  assert.equal(typeof notice, "string");
  assert.ok(notice.length <= 200, `systemMessage length ${notice.length}`);
  assert.doesNotMatch(notice, /[\n\r]/);
  assert.match(notice, /^stable-build guard: \d+ Arc gotchas? .*\(.+\) — advisory, edit kept$/);
  assert.doesNotMatch(notice, /\berror\b|block/i, "the user notice never presents as an error");
  return { ctx, notice, json: j };
}

/** Rule ids listed in the agent text of a hookMode() result (empty when there is no output). */
const ctxIds = (r) => (r.stdout ? [...advisory(r.stdout).ctx.matchAll(/\] ([a-z0-9-]+) at/g)].map((m) => m[1]) : []);

// The file every payload in payloads/ produces (post-edit state on disk).
const PAY_TS = JSON.parse(readFileSync(path.join(PAYLOADS, "claude-write.json"), "utf8")).tool_input.content;

const WARN_ONLY = `import { createPublicClient, http, parseAbiItem } from "viem";
const client = createPublicClient({ transport: http() });
const USDC_ADDRESS = "0x3600000000000000000000000000000000000000";
export const logs = (fromBlock: bigint, toBlock: bigint) => client.getLogs({
  address: USDC_ADDRESS,
  event: parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)"),
  fromBlock,
  toBlock,
});
`;

// ---------- catalog ----------

describe("catalog (data/gotchas.json)", () => {
  test("has exactly the 10 rule ids implemented in rules.mjs", () => {
    const ids = CATALOG.rules.map((r) => r.id);
    assert.equal(ids.length, 10);
    assert.equal(new Set(ids).size, 10);
    assert.deepEqual([...ids].sort(), [...RULE_IDS].sort());
  });

  test("every rule is complete, sourced and concise", () => {
    for (const r of CATALOG.rules) {
      assert.match(r.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, r.id);
      assert.doesNotMatch(r.id, /\barc\b|bmad/i, r.id);
      assert.ok(["error", "warn"].includes(r.severity), r.id);
      for (const k of ["title", "flags", "message", "fix"]) assert.ok(typeof r[k] === "string" && r[k].length > 10, `${r.id}.${k}`);
      assert.ok(r.message.length <= 200, `${r.id} message too long (${r.message.length})`);
      assert.ok(r.fix.length <= 200, `${r.id} fix too long (${r.fix.length})`);
      assert.deepEqual([...r.appliesTo].sort(), [...RULES[r.id].kinds].sort(), `${r.id} appliesTo`);
      assert.match(r.evidence.url, /^https:\/\/(docs\.arc\.io|developers\.circle\.com)\//, r.id);
      assert.ok(r.evidence.quote.length >= 20, r.id);
      assert.match(r.evidence.verified_at, /^\d{4}-\d{2}-\d{2}$/, r.id);
      for (const [k, v] of Object.entries(r.variants || {})) {
        assert.ok(["error", "warn"].includes(v.severity), `${r.id}/${k}`);
        assert.ok(v.message.length <= 200, `${r.id}/${k}`);
        if (v.fix != null) assert.ok(v.fix.length <= 200, `${r.id}/${k} fix too long (${v.fix.length})`);
        if (v.evidence != null) {
          assert.match(v.evidence.url, /^https:\/\/(docs\.arc\.io|developers\.circle\.com)\//, `${r.id}/${k}`);
          assert.ok(v.evidence.quote.length >= 20 && v.evidence.quote.length <= 300, `${r.id}/${k}`);
          assert.match(v.evidence.verified_at, /^\d{4}-\d{2}-\d{2}$/, `${r.id}/${k}`);
        }
      }
      for (const u of r.see_also || []) assert.match(u, /^https:\/\//);
    }
    assert.equal(CATALOG.suffix, SUFFIX);
  });

  test("no investment or hype wording", () => {
    const text = JSON.stringify(CATALOG) + readFileSync(SKILL, "utf8");
    assert.doesNotMatch(text, /\b(yield|APR|APY|ROI|guaranteed|revolutionary)\b/i);
  });

  const snap = process.env.STABLE_BUILD_DOCS_SNAPSHOT;
  test("evidence quotes appear verbatim in the docs snapshot", { skip: snap ? false : "set STABLE_BUILD_DOCS_SNAPSHOT to check quotes offline (CI checks live pages)" }, () => {
    const files = snap.split(path.delimiter).filter(Boolean);
    const all = files.map((f) => readFileSync(f, "utf8")).join("\n");
    const norm = (s) => s.replace(/\s+/g, " ");
    const items = CATALOG.rules.flatMap((r) => [{ id: r.id, ev: r.evidence },
      ...Object.entries(r.variants || {}).filter(([, v]) => v.evidence).map(([k, v]) => ({ id: `${r.id}/${k}`, ev: v.evidence }))]);
    for (const { id, ev } of items) {
      const marker = `Source: ${ev.url}\n`;
      const i = all.indexOf(marker);
      let page = all;
      if (i >= 0) {
        const j = all.indexOf("\nSource: ", i + marker.length);
        page = all.slice(i, j < 0 ? undefined : j);
      }
      assert.ok(norm(page).includes(norm(ev.quote)), `${id}: quote not found under ${ev.url}`);
    }
  });
});

// ---------- fixtures ----------

function fixtureEntries(id) {
  const dir = path.join(FIXTURES, id);
  return readdirSync(dir).filter((n) => /^(bad|good)-/.test(n)).map((n) => ({ name: n, path: path.join(dir, n) }));
}

describe("fixtures", () => {
  for (const id of RULE_IDS) {
    describe(id, () => {
      const entries = fixtureEntries(id);
      test("has at least 2 bad and 2 good fixtures", () => {
        assert.ok(entries.filter((e) => e.name.startsWith("bad-")).length >= 2);
        assert.ok(entries.filter((e) => e.name.startsWith("good-")).length >= 2);
      });
      for (const e of entries) {
        test(e.name, () => {
          const r = guard.scan([e.path], { HOME: tmp(), PATH: process.env.PATH });
          const ids = r.findings.map((f) => f.id);
          if (e.name.startsWith("bad-")) assert.ok(ids.includes(id), `${id} did not fire on ${e.name}: ${JSON.stringify(ids)}`);
          else assert.deepEqual(ids, [], `good fixture ${e.name} produced findings: ${JSON.stringify(r.findings)}`);
        });
      }
    });
  }

  test("variants reported for the review regressions", () => {
    const expect = {
      "cctp-stellar-no-forwarder/bad-5.ts": [undefined],
      "cctp-stellar-no-forwarder/bad-6.ts": [undefined],
      "cctp-stellar-no-forwarder/bad-7.ts": ["recipient-not-forwarder"],
      "cctp-stellar-no-forwarder/bad-4.ts": ["zero-caller"],
      "upstream-foundry/bad-5.sh": ["arc-mode-off", "arc-mode-off"],
      "upstream-foundry/bad-6": ["arc-mode-off"],
      "getlogs-unpaged/bad-5.ts": ["span"],
      "getlogs-unpaged/bad-6.ts": ["span"],
      "getlogs-unpaged/bad-7.ts": ["span"],
      "transfer-filter-no-emitter/bad-3.ts": ["usdc-only"],
      "transfer-filter-no-emitter/bad-4.ts": ["both-emitters"],
      "transfer-filter-no-emitter/bad-5.ts": ["both-emitters"],
      "transfer-filter-no-emitter/bad-6.ts": ["split-emitters"],
      "transfer-filter-no-emitter/bad-7.ts": ["both-emitters"],
    };
    for (const [rel, variants] of Object.entries(expect)) {
      const r = guard.scan([path.join(FIXTURES, rel)], { HOME: tmp(), PATH: process.env.PATH });
      const [id] = rel.split("/");
      assert.deepEqual(r.findings.filter((f) => f.id === id).map((f) => f.variant ?? undefined), variants, rel);
    }
  });

  test("CLI --scan of the fixtures dir reports all 10 ids and exits 1", () => {
    const home = tmp();
    const p = spawnSync(process.execPath, [GUARD, "--scan", FIXTURES, "--json"], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: home } });
    assert.equal(p.status, 1, p.stderr);
    const r = JSON.parse(p.stdout);
    assert.deepEqual([...new Set(r.findings.map((f) => f.id))].sort(), [...RULE_IDS].sort());
    assert.ok(r.findings.every((f) => /^(bad|good)-/.test(f.file.split(/[\\/]/)[1])));
    assert.ok(r.findings.every((f) => f.file.split(/[\\/]/)[1].startsWith("bad-")), "a good fixture produced a finding");
  });

  test("CLI --scan text mode exits 0 on a clean tree", () => {
    const dir = path.join(FIXTURES, "fee-below-floor", "good-1.ts");
    const p = spawnSync(process.execPath, [GUARD, "--scan", dir], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: tmp() } });
    assert.equal(p.status, 0);
    assert.match(p.stdout, /0 finding\(s\)/);
    // the hint must work from the user's project directory, so it names the script by absolute path
    assert.ok(p.stdout.includes(`Explain one: node ${JSON.stringify(GUARD)} --explain <id>`), p.stdout);
  });

  test("CLI --scan <subdir> text mode prints paths that open from the current directory", () => {
    const home = tmp();
    const root = project(home, { files: { "src/core/logs.ts": WARN_ONLY } });
    const env = { PATH: process.env.PATH, HOME: home };
    const p = spawnSync(process.execPath, [GUARD, "--scan", "./src"], { cwd: root, encoding: "utf8", env });
    assert.match(p.stdout, new RegExp(`^${path.join("src", "core", "logs.ts").replace(/\\/g, "\\\\")}:4  warn  transfer-filter-no-emitter`, "m"), p.stdout);
    // outside the current directory: absolute paths; --json keeps root-relative paths
    const q = spawnSync(process.execPath, [GUARD, "--scan", path.join(root, "src")], { cwd: tmp(), encoding: "utf8", env });
    assert.ok(q.stdout.split("\n").some((l) => l.startsWith(`${path.join(root, "src", "core", "logs.ts")}:4 `)), q.stdout);
    const j = JSON.parse(spawnSync(process.execPath, [GUARD, "--scan", "./src", "--json"], { cwd: root, encoding: "utf8", env }).stdout);
    assert.equal(j.findings[0].file, path.join("core", "logs.ts"));
  });
});

// ---------- payload shapes ----------

describe("payload normalization", () => {
  test("Claude Write / Edit / MultiEdit and Codex apply_patch", () => {
    const root = "/w";
    const w = normalizePayload(JSON.parse(payload("claude-write", root)));
    assert.equal(w.length, 1);
    assert.equal(w[0].file, "/w/src/pay.ts");
    assert.equal(w[0].line, 1);
    const e = normalizePayload(JSON.parse(payload("claude-edit", root)));
    assert.deepEqual(e.map((c) => c.text), ['    value: parseUnits(amount, 6),\n    maxFeePerGas: parseGwei("1"),']);
    const m = normalizePayload(JSON.parse(payload("claude-multiedit", root)));
    assert.deepEqual(m.map((c) => c.text), ["value: parseUnits(amount, 6),", 'maxFeePerGas: parseGwei("1"),']);
    const c = normalizePayload(JSON.parse(payload("codex-apply-patch", root)));
    assert.deepEqual(c.map((x) => [x.file, x.text]), [["/w/src/pay.ts", '    value: parseUnits(amount, 6),\n    maxFeePerGas: parseGwei("1"),']]);
  });

  test("apply_patch: Add File, Move to, Delete File, several hunks, CRLF, argv form", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: a/new.ts",
      "+line one",
      "+line two",
      "*** Update File: b/old.ts",
      "*** Move to: b/renamed.ts",
      "@@",
      " ctx",
      "+added 1",
      "-removed",
      " ctx",
      "+added 2",
      "*** Delete File: c/gone.ts",
      "*** End Patch",
    ].join("\r\n");
    const out = normalizePayload({ cwd: "/r", tool_name: "apply_patch", tool_input: { command: ["apply_patch", patch] } });
    assert.deepEqual(out.map((x) => [x.file, x.text, x.line]), [
      ["/r/a/new.ts", "line one\nline two", 1],
      ["/r/b/renamed.ts", "added 1", null],
      ["/r/b/renamed.ts", "added 2", null],
    ]);
  });

  test("ignores unrelated or malformed payloads", () => {
    assert.deepEqual(normalizePayload(null), []);
    assert.deepEqual(normalizePayload({ tool_name: "Read", tool_input: { file_path: "/x.ts" } }), []);
    assert.deepEqual(normalizePayload({ tool_name: "Bash", tool_input: { command: "ls" } }), []);
    assert.deepEqual(normalizePayload({ tool_name: "Edit", tool_input: { file_path: 3, new_string: "x" } }), []);
    assert.deepEqual(normalizePayload({ tool_name: "MultiEdit", tool_input: { file_path: "/x.ts", edits: "nope" } }), []);
  });

  test("the four payload shapes produce the same findings", () => {
    const { home, env } = sandbox();
    const root = project(home, { files: { "src/pay.ts": PAY_TS } });
    const results = ["claude-write", "claude-edit", "claude-multiedit", "codex-apply-patch"].map((n) => {
      const r = guard.hookMode(payload(n, root), env);
      assert.equal(r.stderr, undefined, n);
      return { n, code: r.code, ...advisory(r.stdout) };
    });
    for (const r of results) {
      assert.equal(r.code, 0, `${r.n} exit`);
      assert.match(r.ctx, /\[error\] usdc-native-value-6dp at src\/pay\.ts:7/, r.n);
      assert.match(r.ctx, /\[error\] fee-below-floor at src\/pay\.ts:8/, r.n);
      assert.equal(r.notice, "stable-build guard: 2 Arc gotchas in src/pay.ts (usdc-native-value-6dp, fee-below-floor) — advisory, edit kept", r.n);
    }
    assert.equal(new Set(results.map((r) => r.ctx)).size, 1, "messages differ between payload shapes");
    assert.equal(new Set(results.map((r) => r.notice)).size, 1, "notices differ between payload shapes");
  });
});

// ---------- exit-code matrix (through run.sh) ----------

describe("exit-code matrix via run.sh", () => {
  test("error -> exit 0 + advisory JSON (additionalContext + systemMessage), nothing on stderr", () => {
    const { home, env } = sandbox();
    const root = project(home, { files: { "src/pay.ts": PAY_TS } });
    const p = runSh(payload("claude-edit", root), env);
    assert.equal(p.status, 0, p.stderr);
    assert.equal(p.stderr, "");
    const { ctx, notice } = advisory(p.stdout);
    assert.match(ctx, /\[error\] usdc-native-value-6dp at src\/pay\.ts:7: .+ Fix: .+ Docs: https:\/\/docs\.arc\.io\//);
    assert.match(ctx, /\[error\] fee-below-floor at src\/pay\.ts:8/);
    assert.match(ctx, /\(2 error, 0 warn\)/);
    assert.equal(notice, "stable-build guard: 2 Arc gotchas in src/pay.ts (usdc-native-value-6dp, fee-below-floor) — advisory, edit kept");
  });

  test("warn only -> exit 0 + the same advisory JSON shape", () => {
    const { home, env } = sandbox();
    const root = project(home, { files: { "src/logs.ts": WARN_ONLY } });
    const p = runSh(writePayload(root, "src/logs.ts", WARN_ONLY), env);
    assert.equal(p.status, 0, p.stderr);
    assert.equal(p.stderr, "");
    const { ctx, notice } = advisory(p.stdout);
    assert.match(ctx, /\[warn\] transfer-filter-no-emitter at src\/logs\.ts:4/);
    assert.match(ctx, /\(0 error, 1 warn\)/);
    assert.equal(notice, "stable-build guard: 1 Arc gotcha in src/logs.ts (transfer-filter-no-emitter) — advisory, edit kept");
  });

  test("no hook path exits 2: every bad fixture, as a Write in an Arc project, gives exit 0 + advisory JSON", () => {
    const { home, env } = sandbox();
    const root = project(home);
    const severities = new Set();
    const fired = new Set();
    for (const id of RULE_IDS) {
      for (const e of fixtureEntries(id).filter((x) => x.name.startsWith("bad-") && statSync(x.path).isFile())) {
        const rel = e.name.endsWith(".yml") ? `.github/workflows/${id}-${e.name}` : `src/${id}/${e.name}`;
        const text = readFileSync(e.path, "utf8");
        mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        writeFileSync(path.join(root, rel), text);
        const r = guard.hookMode(writePayload(root, rel, text), env);
        assert.equal(r.code, 0, rel);
        assert.equal(r.stderr, undefined, rel);
        if (!r.stdout) continue;
        const { ctx } = advisory(r.stdout);
        for (const m of ctx.matchAll(/^- \[(error|warn)\] ([a-z0-9-]+) at /gm)) { severities.add(m[1]); fired.add(m[2]); }
      }
    }
    assert.deepEqual([...severities].sort(), ["error", "warn"], "both severities went through the advisory path");
    assert.deepEqual([...fired].sort(), [...RULE_IDS].sort(), "every rule went through the advisory path");
    // the same through the launcher and through node directly, plus the fail-open paths
    const pay = project(home, { files: { "src/pay.ts": PAY_TS } });
    const inputs = [payload("claude-edit", pay), payload("codex-apply-patch", pay), "{not json", "", '{"tool_input": 5}'];
    for (const input of inputs) {
      for (const p of [runSh(input, env), spawnSync(process.execPath, [GUARD], { input, env, encoding: "utf8" }),
        runSh(input, { ...env, STABLE_BUILD_GUARD_SELFTEST: "throw" })]) {
        assert.equal(p.status, 0, input.slice(0, 40));
        assert.equal(p.stderr, "", input.slice(0, 40));
        if (p.stdout) advisory(p.stdout);
      }
    }
  });

  test("an Edit of only the address line still checks the enclosing Transfer filter", () => {
    const { home, env } = sandbox();
    const file = WARN_ONLY.replace("address: USDC_ADDRESS,", "address: [USDC_ADDRESS, SYSTEM],")
      .replace('const USDC_ADDRESS', 'const SYSTEM = "0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE";\nconst USDC_ADDRESS');
    const root = project(home, { files: { "src/logs.ts": file } });
    const input = JSON.stringify({
      session_id: "t", cwd: root, hook_event_name: "PostToolUse", tool_name: "Edit",
      tool_input: { file_path: path.join(root, "src/logs.ts"), old_string: "  address: USDC_ADDRESS,", new_string: "  address: [USDC_ADDRESS, SYSTEM]," },
    });
    const p = runSh(input, env);
    assert.equal(p.status, 0, p.stderr);
    const { ctx } = advisory(p.stdout);
    assert.match(ctx, /\[error\] transfer-filter-no-emitter/);
    assert.match(ctx, /Fix: Drop 0x3600… and query only the system emitter/);
  });

  test("usdc-only warning tells the agent to replace 0x3600…, not to add a second emitter", () => {
    const { home, env } = sandbox();
    const root = project(home, { files: { "src/logs.ts": WARN_ONLY } });
    const p = runSh(writePayload(root, "src/logs.ts", WARN_ONLY), env);
    const { ctx } = advisory(p.stdout);
    assert.match(ctx, /Fix: Replace 0x3600… with the system emitter/);
    assert.match(ctx, /Do not query both/);
    // the docs quote behind the variant travels with it, so the agent can act without fetching the page
    const ev = CATALOG.rules.find((r) => r.id === "transfer-filter-no-emitter").variants["usdc-only"].evidence;
    assert.ok(ctx.includes(` Docs: ${ev.url} says "${ev.quote}" (checked ${ev.verified_at})`), ctx);
  });

  test("each finding carries its rule's docs quote; over budget, quotes go first from the last finding, then links", () => {
    const base = "/p";
    const f = (id, file, line, variant) => ({ id, file: path.join(base, file), line, variant });
    const two = guard.formatHookMessage([f("usdc-native-value-6dp", "a.ts", 1), f("fee-below-floor", "a.ts", 2)], base);
    for (const id of ["usdc-native-value-6dp", "fee-below-floor"]) {
      const r = CATALOG.rules.find((x) => x.id === id);
      assert.ok(two.includes(`Docs: ${r.evidence.url} says "${r.evidence.quote}" (checked ${r.evidence.verified_at})`), id);
    }
    const ids = ["usdc-native-value-6dp", "usdc-erc20-amount-18dp", "usdc-balance-summed", "fee-below-floor", "cctp-stellar-no-forwarder"];
    const shape = (n) => {
      const msg = guard.formatHookMessage(ids.slice(0, n).map((id, i) => f(id, "a.ts", i + 1)), base);
      assert.ok(msg.length <= 2000, `${n}: length ${msg.length}`);
      assert.ok(msg.endsWith(SUFFIX), `${n}`);
      const lines = msg.split("\n").filter((l) => l.startsWith("- ["));
      assert.equal(lines.length, n);
      for (const l of lines) assert.match(l, / Fix: /);
      return lines.map((l) => (/ says "/.test(l) ? "Q" : / Docs: https:/.test(l) ? "L" : "-")).join("");
    };
    assert.equal(shape(3), "QQQ");
    assert.equal(shape(4), "QQQL", "the last finding's quote goes first");
    assert.equal(shape(5), "LLLLL", "links stay once every quote is out");
  });

  test("clean edit -> exit 0, no output", () => {
    const { home, env } = sandbox();
    const ok = PAY_TS.replace("parseUnits(amount, 6)", "parseUnits(amount, 18)").replace('parseGwei("1")', 'parseGwei("20")');
    const root = project(home, { files: { "src/pay.ts": ok } });
    const p = runSh(writePayload(root, "src/pay.ts", ok), env);
    assert.equal(p.status, 0);
    assert.equal(p.stdout + p.stderr, "");
  });

  test("bad JSON -> exit 0, no output", () => {
    const { env } = sandbox();
    for (const input of ["{not json", "", "null", "[]", '{"tool_input": 5}']) {
      const p = runSh(input, env);
      assert.equal(p.status, 0, input);
      assert.equal(p.stdout + p.stderr, "", input);
    }
  });

  test("non-Arc project -> exit 0, no output", () => {
    const { home, env } = sandbox();
    const root = project(home, { arc: false, files: { "src/pay.ts": PAY_TS } });
    const p = runSh(payload("claude-write", root), env);
    assert.equal(p.status, 0);
    assert.equal(p.stdout + p.stderr, "");
  });

  test("Arc marker in the edited file alone enables the guard", () => {
    const { home, env } = sandbox();
    const text = `import { arcTestnet } from "viem/chains";\n${PAY_TS}`;
    const root = project(home, { arc: false, files: { "src/pay.ts": text } });
    const p = runSh(writePayload(root, "src/pay.ts", text), env);
    assert.equal(p.status, 0);
    assert.match(advisory(p.stdout).ctx, /usdc-native-value-6dp/);
  });

  test("viem's default Arc Testnet RPC hosts and ArcScan mark a file as Arc", () => {
    const urls = [
      "https://rpc.testnet.arc.network", "https://rpc.quicknode.testnet.arc.network",
      "https://rpc.blockdaemon.testnet.arc.network", "wss://rpc.testnet.arc.network", "https://testnet.arcscan.app/tx/0x1",
    ];
    for (const url of urls) assert.ok(arcMarker(`const u = "${url}";`), url);
    for (const other of ["https://docs.arc.network", "https://example.com/arc.network", "https://arcscan.application.dev"]) {
      assert.equal(arcMarker(`const u = "${other}";`), null, other);
    }
    const { home, env } = sandbox();
    for (const url of [urls[0], urls[4]]) {
      const text = `const RPC_URL = "${url}";\n${PAY_TS}`;
      const root = project(home, { arc: false, files: { "src/pay.ts": text } });
      const p = runSh(writePayload(root, "src/pay.ts", text), env);
      assert.equal(p.status, 0, url);
      assert.match(advisory(p.stdout).ctx, /usdc-native-value-6dp/);
    }
  });

  test("Arc marker in README enables the guard", () => {
    const { home, env } = sandbox();
    const root = project(home, { arc: "readme", files: { "src/pay.ts": PAY_TS } });
    const p = runSh(payload("claude-write", root), env);
    assert.equal(p.status, 0);
    assert.match(advisory(p.stdout).ctx, /usdc-native-value-6dp/);
  });

  test("files outside the rule kinds are ignored (.txt, node_modules, dist)", () => {
    const { home, env } = sandbox();
    const root = project(home, { files: { "notes.txt": PAY_TS, "node_modules/x/pay.ts": PAY_TS, "dist/pay.ts": PAY_TS } });
    for (const rel of ["notes.txt", "node_modules/x/pay.ts", "dist/pay.ts"]) {
      const p = runSh(writePayload(root, rel, PAY_TS), env);
      assert.equal(p.status, 0, rel);
      assert.equal(p.stdout + p.stderr, "", rel);
    }
  });

  test("consent off -> exit 0 without starting node", () => {
    const shimDir = tmp("sb-shim-");
    const marker = path.join(shimDir, "node-started");
    writeFileSync(path.join(shimDir, "node"), `#!/bin/sh\n: > "${marker}"\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 });
    const cases = [
      { consent: false },
      { configText: '{"schemaVersion":1,"guard":false}' },
      { configText: "not json at all" },
    ];
    for (const c of cases) {
      const { home, env } = sandbox(c);
      const root = project(home, { files: { "src/pay.ts": PAY_TS } });
      rmSync(marker, { force: true });
      const p = runSh(payload("claude-write", root), { ...env, PATH: `${shimDir}:${env.PATH}` });
      assert.equal(p.status, 0, JSON.stringify(c));
      assert.equal(p.stdout + p.stderr, "");
      assert.equal(existsSync(marker), false, `node started with ${JSON.stringify(c)}`);
    }
    // sanity: with consent (compact and spaced JSON, any spaces or tabs around the colon) the shim does run
    for (const configText of ['{"guard":true}', '{\n  "guard": true\n}', '{\n  "schemaVersion" : 1,\n  "guard" : true\n}', '{"guard":\ttrue}']) {
      const { home, env } = sandbox({ configText });
      const root = project(home, { files: { "src/pay.ts": PAY_TS } });
      rmSync(marker, { force: true });
      const p = runSh(payload("claude-write", root), { ...env, PATH: `${shimDir}:${env.PATH}` });
      assert.equal(p.status, 0);
      advisory(p.stdout);
      assert.equal(existsSync(marker), true);
    }
  });

  test("node missing -> exit 0", () => {
    const bin = tmp("sb-bin-");
    for (const tool of ["grep", "dirname"]) {
      const real = spawnSync("/bin/sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
      symlinkSync(real, path.join(bin, tool));
    }
    const { home, env } = sandbox();
    const root = project(home, { files: { "src/pay.ts": PAY_TS } });
    const p = runSh(payload("claude-write", root), { ...env, PATH: bin });
    assert.equal(p.status, 0, p.stderr);
    assert.equal(p.stdout + p.stderr, "");
  });

  test("missing or broken plugin module (partial install) -> exit 0, no output, through run.sh and hooks.json", () => {
    const hooks = JSON.parse(readFileSync(HOOKS, "utf8")).hooks;
    const cmd = { guard: hooks.PostToolUse[0].hooks[0].command, "session-start": hooks.SessionStart[0].hooks[0].command };
    const broken = {
      "rules.mjs deleted": (dir) => rmSync(path.join(dir, "scripts", "guard", "rules.mjs")),
      "project.mjs deleted": (dir) => rmSync(path.join(dir, "scripts", "guard", "project.mjs")),
      "text.mjs syntax error": (dir) => writeFileSync(path.join(dir, "scripts", "guard", "text.mjs"), "export const = ;\n"),
      "gotchas.json corrupt": (dir) => writeFileSync(path.join(dir, "data", "gotchas.json"), "{"),
    };
    for (const [label, breakIt] of Object.entries(broken)) {
      const copy = path.join(tmp("sb-plugin-"), "stable-build");
      for (const d of ["scripts", "data", "hooks"]) cpSync(path.join(PLUGIN, d), path.join(copy, d), { recursive: true });
      breakIt(copy);
      const { home, env } = sandbox();
      const root = project(home, { files: { "src/pay.ts": PAY_TS } });
      const inputs = { guard: payload("claude-edit", root), "session-start": JSON.stringify({ cwd: root, hook_event_name: "SessionStart" }) };
      for (const script of ["guard", "session-start"]) {
        const direct = spawnSync("/bin/sh", [path.join(copy, "scripts", "run.sh"), script], { input: inputs[script], env: { ...env }, cwd: root, encoding: "utf8" });
        const viaHooks = spawnSync("/bin/sh", ["-c", cmd[script]], { input: inputs[script], env: { ...env, CLAUDE_PLUGIN_ROOT: copy }, cwd: root, encoding: "utf8" });
        for (const p of [direct, viaHooks]) {
          assert.equal(p.status, 0, `${label} / ${script}: ${p.stderr}`);
          assert.equal(p.stderr, "", `${label} / ${script}`);
          if (label === "gotchas.json corrupt" || script === "session-start" && label !== "project.mjs deleted") continue;
          assert.equal(p.stdout, "", `${label} / ${script}`);
        }
      }
    }
  });

  test("internal error -> exit 0, no output", () => {
    const { home, env } = sandbox();
    const root = project(home, { files: { "src/pay.ts": PAY_TS } });
    const p = runSh(payload("claude-write", root), { ...env, STABLE_BUILD_GUARD_SELFTEST: "throw" });
    assert.equal(p.status, 0);
    assert.equal(p.stdout + p.stderr, "");
  });

  test("at most 5 findings and 2,000 characters", () => {
    const { home, env } = sandbox();
    const many = Array.from({ length: 12 }, (_, i) =>
      `export const t${i} = (w: any, to: \`0x\${string}\`) => w.sendTransaction({ to, value: parseUnits("${i + 1}", 6), maxFeePerGas: parseGwei("1") });`).join("\n");
    const text = `import { parseUnits, parseGwei } from "viem";\n${many}\n`;
    const root = project(home, { files: { "src/many.ts": text } });
    const p = runSh(writePayload(root, "src/many.ts", text), env);
    assert.equal(p.status, 0);
    assert.equal(p.stderr, "");
    const { ctx: msg, notice } = advisory(p.stdout); // checks the 2,000-character cap and the suffix
    const locs = (msg.match(/src\/many\.ts:\d+/g) || []).length;
    assert.ok(locs >= 1 && locs <= 5, `locations shown: ${locs}`);
    assert.match(msg, /\.\.\.and \d+ more/);
    assert.match(msg, /^stable-build guard: 24 Arc gotchas/);
    assert.equal(notice, "stable-build guard: 24 Arc gotchas in src/many.ts (usdc-native-value-6dp, fee-below-floor) — advisory, edit kept");
  });

  test("the user notice stays one line of at most 200 characters", () => {
    const base = "/p";
    const f = (id, file, line) => ({ id, file: path.join(base, file), line });
    let n = guard.formatHookNotice([f("getlogs-unpaged", "a.ts", 1), f("fee-below-floor", "b.ts", 2), f("upstream-foundry", "c.sh", 3), f("multicall3from-value", "d.ts", 4)], base);
    assert.equal(n, "stable-build guard: 4 Arc gotchas in a.ts, b.ts +2 more (getlogs-unpaged, fee-below-floor, multicall3from-value +1 more) — advisory, edit kept");
    const long = `${"x".repeat(300)}\nevil.ts`;
    n = guard.formatHookNotice([f("getlogs-unpaged", long, 1)], base);
    assert.ok(n.length <= 200, n);
    assert.doesNotMatch(n, /\n/);
    assert.equal(n, "stable-build guard: 1 Arc gotcha (getlogs-unpaged) — advisory, edit kept");
  });
});

// ---------- suppression ----------

describe("suppression", () => {
  const code = (r) => r.code;
  const ids = ctxIds;

  test("inline stable-build-ignore on the same line and the line above", () => {
    const { home, env } = sandbox();
    const same = PAY_TS.replace("value: parseUnits(amount, 6),", "value: parseUnits(amount, 6), // stable-build-ignore usdc-native-value-6dp");
    let root = project(home, { files: { "src/pay.ts": same } });
    let r = guard.hookMode(writePayload(root, "src/pay.ts", same), env);
    assert.deepEqual(ids(r), ["fee-below-floor"]);

    const above = PAY_TS.replace('    maxFeePerGas: parseGwei("1"),', '    // stable-build-ignore fee-below-floor, usdc-native-value-6dp\n    maxFeePerGas: parseGwei("1"),');
    root = project(home, { files: { "src/pay.ts": above } });
    r = guard.hookMode(writePayload(root, "src/pay.ts", above), env);
    assert.deepEqual(ids(r), ["usdc-native-value-6dp"]);

    const both = same.replace('    maxFeePerGas: parseGwei("1"),', '    maxFeePerGas: parseGwei("1"), /* stable-build-ignore fee-below-floor */');
    root = project(home, { files: { "src/pay.ts": both } });
    r = guard.hookMode(writePayload(root, "src/pay.ts", both), env);
    assert.equal(code(r), 0);
    assert.equal(r.stdout, undefined);
  });

  test("an ignore for a different id does not suppress", () => {
    const { home, env } = sandbox();
    const text = PAY_TS.replace("value: parseUnits(amount, 6),", "value: parseUnits(amount, 6), // stable-build-ignore getlogs-unpaged");
    const root = project(home, { files: { "src/pay.ts": text } });
    const r = guard.hookMode(writePayload(root, "src/pay.ts", text), env);
    assert.deepEqual(ids(r).sort(), ["fee-below-floor", "usdc-native-value-6dp"]);
  });

  test(".stable-build/guard.json disable list, '*', and ignorePaths", () => {
    const { home, env } = sandbox();
    let root = project(home, { files: { "src/pay.ts": PAY_TS }, guardJson: { disable: ["fee-below-floor"] } });
    let r = guard.hookMode(payload("claude-write", root), env);
    assert.deepEqual(ids(r), ["usdc-native-value-6dp"]);

    root = project(home, { files: { "src/pay.ts": PAY_TS }, guardJson: { disable: ["*"] } });
    r = guard.hookMode(payload("claude-write", root), env);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, undefined);

    root = project(home, { files: { "src/legacy/pay.ts": PAY_TS }, guardJson: { disable: [], ignorePaths: ["src/legacy/**"] } });
    r = guard.hookMode(writePayload(root, "src/legacy/pay.ts", PAY_TS), env);
    assert.equal(r.code, 0);

    root = project(home, { files: { "src/pay.ts": PAY_TS }, guardJson: "{ broken" });
    writeFileSync(path.join(root, ".stable-build", "guard.json"), "{ broken");
    r = guard.hookMode(payload("claude-write", root), env);
    assert.equal(r.code, 0);
    assert.deepEqual(ids(r).sort(), ["fee-below-floor", "usdc-native-value-6dp"], "a malformed guard.json disables nothing");
  });

  test("scan honours guard.json and inline ignores", () => {
    const { home } = sandbox();
    const text = PAY_TS.replace("value: parseUnits(amount, 6),", "value: parseUnits(amount, 6), // stable-build-ignore usdc-native-value-6dp");
    const root = project(home, { files: { "src/pay.ts": text }, guardJson: { disable: ["fee-below-floor"] } });
    const r = guard.scan([root], { HOME: home, PATH: process.env.PATH });
    assert.deepEqual(r.findings, []);
    assert.deepEqual(r.disabled, ["fee-below-floor"]);
  });

  test("only the added text is checked; old problems in the file are not re-reported", () => {
    const { home, env } = sandbox();
    const text = `${PAY_TS}\nexport const later = 1;\n`;
    const root = project(home, { files: { "src/pay.ts": text } });
    const p = JSON.stringify({ cwd: root, tool_name: "Edit", tool_input: { file_path: path.join(root, "src/pay.ts"), old_string: "later = 0", new_string: "later = 1" } });
    const r = guard.hookMode(p, env);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, undefined);
  });

  test("CI workflow raises upstream-foundry to error", () => {
    const { home, env } = sandbox();
    const yml = "jobs:\n  t:\n    steps:\n      - uses: foundry-rs/foundry-toolchain@v1\n";
    const root = project(home, { files: { ".github/workflows/ci.yml": yml, "scripts/dev.sh": "anvil &\n" } });
    let r = guard.hookMode(writePayload(root, ".github/workflows/ci.yml", yml), env);
    assert.equal(r.code, 0);
    assert.match(advisory(r.stdout).ctx, /\[error\] upstream-foundry/);
    r = guard.hookMode(writePayload(root, "scripts/dev.sh", "anvil &\n"), env);
    assert.equal(r.code, 0);
    assert.match(advisory(r.stdout).ctx, /\[warn\] upstream-foundry/);
  });
});

// ---------- session start ----------

describe("session-start notice", () => {
  const runSession = (cwd, env) => runSh(JSON.stringify({ session_id: "s", hook_event_name: "SessionStart", source: "startup", cwd }), env, "session-start");

  test("Arc project -> notice of at most 400 chars", () => {
    const { home, env } = sandbox();
    for (const arc of ["project.json", "readme"]) {
      const root = project(home, { arc });
      const p = runSession(root, env);
      assert.equal(p.status, 0);
      const out = p.stdout.trim();
      assert.ok(out.length > 50 && out.length <= 400, `${arc}: ${out.length}`);
      assert.match(out, /^stable-build: Arc project detected/);
      assert.match(out, /one-line advisory notice plus context for the agent, never as an error/);
      assert.doesNotMatch(out, /blocking error/);
    }
  });

  test("project with the guard disabled says so", () => {
    const { home, env } = sandbox();
    const root = project(home, { guardJson: { disable: ["*"] } });
    const out = runSession(root, env).stdout.trim();
    assert.ok(out.length <= 400);
    assert.match(out, /turned off for this project/);
  });

  test("non-Arc project, consent off, bad input -> no output", () => {
    const { home, env } = sandbox();
    assert.equal(runSession(project(home, { arc: false }), env).stdout, "");
    const off = sandbox({ consent: false });
    assert.equal(runSession(project(off.home), off.env).stdout, "");
    const p = runSh("{oops", env, "session-start");
    assert.equal(p.status, 0);
  });

  test("$STABLE_BUILD_HOME is never mistaken for a project marker", () => {
    const ws = tmp();
    const sbHome = path.join(ws, ".stable-build");
    mkdirSync(sbHome);
    writeFileSync(path.join(sbHome, "config.json"), '{"guard":true}');
    writeFileSync(path.join(sbHome, "guard.json"), '{"disable":[]}');
    mkdirSync(path.join(ws, "app"));
    const env = { PATH: process.env.PATH, HOME: tmp(), STABLE_BUILD_HOME: sbHome };
    assert.equal(runSession(path.join(ws, "app"), env).stdout, "");
  });
});

// ---------- consent CLI ----------

describe("consent CLI (--enable / --disable / --status)", () => {
  const cli = (args, env) => spawnSync(process.execPath, [GUARD, ...args], { encoding: "utf8", env });

  test("enable then disable, keeping unknown keys", () => {
    const { env } = sandbox({ consent: false });
    const file = path.join(env.STABLE_BUILD_HOME, "config.json");
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, guard: false, installer: { keep: true } }));
    let p = cli(["--enable"], env);
    assert.equal(p.status, 0, p.stderr);
    let j = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(j.guard, true);
    assert.deepEqual(j.installer, { keep: true });
    assert.ok(j.consentAt);
    assert.match(readFileSync(file, "utf8"), /"guard": *true/); // the run.sh gate pattern
    assert.equal(JSON.parse(cli(["--status"], env).stdout).guard, "on");
    p = cli(["--disable"], env);
    assert.equal(p.status, 0);
    j = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(j.guard, false);
    assert.ok(j.revokedAt);
    assert.equal(JSON.parse(cli(["--status"], env).stdout).guard, "off");
  });

  test("--status agrees with the hook launcher, and warns when the JSON says otherwise", () => {
    const status = (configText) => {
      const { env } = sandbox({ configText });
      return JSON.parse(cli(["--status"], env).stdout);
    };
    let s = status('{\n  "schemaVersion" : 1,\n  "guard" : true\n}');
    assert.equal(s.guard, "on");
    assert.equal(s.configWarning, null);
    s = status('{"schemaVersion":1,"guard":\n  true}'); // valid JSON, but not on one line
    assert.equal(s.guard, "off");
    assert.match(s.configWarning, /treats the guard as off/);
    s = status('{"guard":false,"note":{"guard": true}}');
    assert.equal(s.guard, "on");
    assert.match(s.configWarning, /reads config.json as on/);
    assert.equal(status('{"schemaVersion":1,"guard":false}').configWarning, null);
  });

  test("creates the home dir when missing; refuses to overwrite invalid JSON", () => {
    const home = tmp();
    const env = { PATH: process.env.PATH, HOME: home, STABLE_BUILD_HOME: path.join(home, "nested", ".stable-build") };
    assert.equal(cli(["--enable"], env).status, 0);
    assert.ok(existsSync(path.join(env.STABLE_BUILD_HOME, "config.json")));
    writeFileSync(path.join(env.STABLE_BUILD_HOME, "config.json"), "{broken");
    const p = cli(["--disable"], env);
    assert.equal(p.status, 1);
    assert.equal(readFileSync(path.join(env.STABLE_BUILD_HOME, "config.json"), "utf8"), "{broken");
  });

  test("--explain, --list and usage errors", () => {
    const env = { PATH: process.env.PATH, HOME: tmp() };
    const p = cli(["--explain", "getlogs-unpaged"], env);
    assert.equal(p.status, 0);
    assert.match(p.stdout, /https:\/\/docs\.arc\.io\/arc\/references\/rpc-endpoints/);
    assert.match(p.stdout, /stable-build-ignore getlogs-unpaged/);
    assert.equal(cli(["--explain", "nope"], env).status, 2);
    assert.equal(cli(["--list"], env).stdout.trim().split("\n").length, 10);
    assert.equal(cli(["--bogus"], env).status, 2);
    assert.equal(cli(["--scan", path.join(tmp(), "missing")], env).status, 2);
  });
});

// ---------- plugin wiring ----------

describe("hooks.json, run.sh and the gotchas skill", () => {
  test("hooks.json wires guard and session-start through run.sh with a quoted plugin root", () => {
    const h = JSON.parse(readFileSync(HOOKS, "utf8"));
    assert.deepEqual(Object.keys(h).sort(), ["description", "hooks"]);
    assert.deepEqual(Object.keys(h.hooks).sort(), ["PostToolUse", "SessionStart"]);
    const post = h.hooks.PostToolUse[0];
    assert.deepEqual(post.matcher.split("|").sort(), ["Edit", "MultiEdit", "Write", "apply_patch"]);
    // Fail open when run.sh cannot be found (plugin root unset, or the plugin removed mid-session):
    // `sh missing.sh` exits 2 on dash, which both hosts would treat as feedback for the model.
    const launcher = (s) => `sh -c '[ -f "$0" ] || exit 0; exec sh "$0" "$1"' "\${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" ${s}`;
    assert.equal(post.hooks[0].command, launcher("guard"));
    assert.equal(h.hooks.SessionStart[0].hooks[0].command, launcher("session-start"));
    for (const ev of Object.values(h.hooks)) for (const g of ev) for (const x of g.hooks) {
      assert.equal(x.type, "command");
      assert.equal(x.args, undefined, "Codex has no exec-form args");
      const script = /run\.sh" ([\w-]+)$/.exec(x.command)[1];
      assert.ok(existsSync(path.join(PLUGIN, "scripts", `${script}.mjs`)), script);
    }
  });

  test("hook commands fail open when run.sh is missing, and pass the advisory JSON through (exit 0) when it is there", () => {
    const h = JSON.parse(readFileSync(HOOKS, "utf8"));
    const guardCmd = h.hooks.PostToolUse[0].hooks[0].command;
    const shells = ["/bin/sh", "/bin/dash", "/bin/bash"].filter((s) => existsSync(s));
    for (const sh of shells) {
      for (const ev of Object.values(h.hooks)) for (const g of ev) for (const x of g.hooks) {
        for (const root of [undefined, "", path.join(tmp(), "removed-plugin")]) {
          const { env } = sandbox();
          if (root !== undefined) env.CLAUDE_PLUGIN_ROOT = root;
          const p = spawnSync(sh, ["-c", x.command], { env, input: "{}", encoding: "utf8" });
          assert.equal(p.status, 0, `${sh} root=${root}: ${p.stderr}`);
          assert.equal(p.stdout + p.stderr, "");
        }
      }
      const { home, env } = sandbox();
      const root = project(home, { files: { "src/pay.ts": PAY_TS } });
      const p = spawnSync(sh, ["-c", guardCmd], { env: { ...env, CLAUDE_PLUGIN_ROOT: PLUGIN }, input: payload("claude-edit", root), encoding: "utf8" });
      assert.equal(p.status, 0, `${sh}: ${p.stderr}`);
      assert.equal(p.stderr, "");
      assert.match(advisory(p.stdout).ctx, /usdc-native-value-6dp/);
    }
  });

  test("run.sh keeps the load-bearing consent gate", () => {
    const sh = readFileSync(RUN, "utf8");
    assert.ok(sh.startsWith("#!/bin/sh\n"));
    for (const line of [
      'H="${STABLE_BUILD_HOME:-$HOME/.stable-build}"',
      `grep -Eq '"guard"[[:space:]]*:[[:space:]]*true' "$H/config.json" 2>/dev/null || exit 0`,
      "command -v node >/dev/null 2>&1 || exit 0",
      'node "$(dirname "$0")/$1.mjs" 2>/dev/null',
    ]) assert.ok(sh.includes(line), line);
    assert.match(sh, /\nexit 0[^\n]*\n?$/, "run.sh ends with exit 0, whatever node did");
    assert.doesNotMatch(sh, /exec node/, "exec would pass node's exit 1 through when a module fails to load");
    const syntax = spawnSync("/bin/sh", ["-n", RUN]);
    assert.equal(syntax.status, 0);
  });

  test("SKILL.md frontmatter, rule index and relative references", () => {
    const md = readFileSync(SKILL, "utf8");
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(md);
    assert.ok(fm, "frontmatter");
    const keys = fm[1].split("\n").map((l) => l.split(":")[0]);
    assert.deepEqual(keys, ["name", "description"]);
    assert.match(fm[1], /^name: gotchas$/m);
    const desc = /^description: (.*)$/m.exec(fm[1])[1];
    assert.ok(desc.length <= 1024);
    assert.doesNotMatch(fm[1].split("\n")[0], /arc|bmad/i);
    for (const id of RULE_IDS) assert.ok(md.includes(`\`${id}\``), `SKILL.md misses ${id}`);
    const skillDir = path.dirname(SKILL);
    for (const ref of ["../../scripts/guard.mjs", "../../data/gotchas.json"]) {
      assert.ok(md.includes(ref), ref);
      assert.ok(existsSync(path.join(skillDir, ref)), ref);
    }
  });
});

// ---------- performance ----------

describe("performance", () => {
  test("p95 under budget over 200 hook runs (sh run.sh guard, Claude Edit payload)", () => {
    const budget = Number(process.env.STABLE_BUILD_PERF_BUDGET_MS || 150);
    const { home, env } = sandbox();
    const root = project(home, { files: { "src/pay.ts": PAY_TS } });
    const input = payload("claude-edit", root);
    runSh(input, env); // warm the file cache
    const times = [];
    for (let i = 0; i < 200; i++) {
      const t = process.hrtime.bigint();
      const p = runSh(input, env);
      times.push(Number(process.hrtime.bigint() - t) / 1e6);
      assert.equal(p.status, 0);
      assert.ok(p.stdout.length > 0);
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.floor(times.length * 0.95) - 1];
    const p50 = times[Math.floor(times.length * 0.5)];
    console.log(`# guard hook latency over 200 runs: p50 ${p50.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms (budget ${budget} ms)`);
    assert.ok(p95 < budget, `p95 ${p95.toFixed(1)} ms >= ${budget} ms`);
  });
});

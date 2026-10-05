// node --test test/guard/language.test.mjs
// Saved language ("language" in $STABLE_BUILD_HOME/config.json, written by install.sh) on the hook side:
//   - the guard's one-line systemMessage and the SessionStart notice follow it ("en" | "pt-BR");
//   - with pt-BR saved, SessionStart adds one English line telling the agent to reply in Brazilian
//     Portuguese, so plain turns (outside a skill) follow the saved language too;
//   - the agent-facing additionalContext, rule ids and docs quotes stay in English;
//   - with no language saved (or an unknown one) every output is byte-identical to the English one;
//   - the consent gate is unchanged: only "guard": true starts node, whatever else config.json holds.
// Every run uses a temporary HOME and STABLE_BUILD_HOME; the real ~/.stable-build is never read or written.
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, cpSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const PLUGIN = path.join(REPO, "plugins", "stable-build");
const RUN = path.join(PLUGIN, "scripts", "run.sh");
const GUARD = path.join(PLUGIN, "scripts", "guard.mjs");
const HOOKS = path.join(PLUGIN, "hooks", "hooks.json");
const GOTCHAS_SKILL = path.join(PLUGIN, "skills", "gotchas", "SKILL.md");
const PAYLOADS = path.join(HERE, "payloads");
const SUFFIX = "advisory: the edit was applied; silence with `stable-build-ignore <id>`";

const guard = await import(pathToFileURL(GUARD));
const session = await import(pathToFileURL(path.join(PLUGIN, "scripts", "session-start.mjs")));
const prefs = await import(pathToFileURL(path.join(PLUGIN, "scripts", "guard", "prefs.mjs")));
const consent = await import(pathToFileURL(path.join(PLUGIN, "scripts", "guard", "consent.mjs")));
const { RULE_IDS } = await import(pathToFileURL(path.join(PLUGIN, "scripts", "guard", "rules.mjs")));

// ---------- sandbox helpers ----------

const tmpRoots = [];
function tmp(prefix = "sb-lang-") {
  const d = mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(d);
  return d;
}
after(() => { for (const d of tmpRoots) rmSync(d, { recursive: true, force: true }); });

/** A fake HOME whose config.json holds `config` (an object, written as JSON) or `configText` verbatim. */
function sandbox({ config, configText } = {}) {
  const home = tmp();
  const sbHome = path.join(home, ".stable-build");
  mkdirSync(sbHome, { recursive: true });
  if (configText != null) writeFileSync(path.join(sbHome, "config.json"), configText);
  else if (config != null) writeFileSync(path.join(sbHome, "config.json"), JSON.stringify(config));
  const env = {
    PATH: process.env.PATH, HOME: home, STABLE_BUILD_HOME: sbHome,
    CLAUDE_CONFIG_DIR: path.join(home, ".claude"), CODEX_HOME: path.join(home, ".codex"),
  };
  return { home, env };
}

/** An Arc project (marked by .stable-build/project.json) at the same relative layout in every sandbox. */
function project(home, { files = {}, guardJson } = {}) {
  const root = path.join(home, "proj");
  mkdirSync(path.join(root, ".stable-build"), { recursive: true });
  writeFileSync(path.join(root, ".stable-build", "project.json"), '{"template":"payouts","templateVersion":1,"network":"testnet"}\n');
  writeFileSync(path.join(root, "package.json"), '{"name":"demo","private":true}\n');
  if (guardJson) writeFileSync(path.join(root, ".stable-build", "guard.json"), JSON.stringify(guardJson));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  }
  return root;
}

const payload = (name, root) => readFileSync(path.join(PAYLOADS, `${name}.json`), "utf8").replaceAll("__ROOT__", root);
const PAY_TS = JSON.parse(readFileSync(path.join(PAYLOADS, "claude-write.json"), "utf8")).tool_input.content;
const runSh = (input, env, script = "guard") => spawnSync("/bin/sh", [RUN, script], { input, env, encoding: "utf8" });
const sessionInput = (cwd) => JSON.stringify({ session_id: "s", hook_event_name: "SessionStart", source: "startup", cwd });

/** Guard hook run (Claude Write of the shared bad payload) in a fresh sandbox with this config. */
function guardRun(cfg) {
  const { home, env } = sandbox(cfg);
  const root = project(home, { files: { "src/pay.ts": PAY_TS } });
  return runSh(payload("claude-write", root), env);
}

/** SessionStart run in a fresh sandbox with this config. */
function sessionRun(cfg, projectOpts = {}) {
  const { home, env } = sandbox(cfg);
  const root = project(home, projectOpts);
  return runSh(sessionInput(root), env, "session-start");
}

const REPLY_PT = "stable-build: the user's saved language is pt-BR. Write your replies to the user in Brazilian Portuguese, even when they write in English, unless they ask for another language. Keep code, identifiers, commands, file names, rule ids and docs quotes as they are.";

const EN_NOTICE = /^stable-build guard: \d+ Arc gotchas? .*\(.+\) — advisory, edit kept$/;
const PT_NOTICE = /^stable-build guard: \d+ pegadinhas? da Arc .*\(.+\) — aviso, edição mantida$/;

/** The advisory JSON on stdout, with its shape checked; `notice` must match the given language. */
function advisory(stdout, lang) {
  assert.ok(stdout && stdout.trim(), "expected advisory JSON on stdout");
  assert.equal(stdout.trim().split("\n").length, 1, "one JSON object on one line");
  const j = JSON.parse(stdout);
  assert.deepEqual(Object.keys(j).sort(), ["hookSpecificOutput", "systemMessage"]);
  assert.deepEqual(Object.keys(j.hookSpecificOutput).sort(), ["additionalContext", "hookEventName"]);
  const ctx = j.hookSpecificOutput.additionalContext;
  assert.ok(ctx.length <= 2000);
  assert.ok(ctx.endsWith(SUFFIX));
  assert.match(ctx, /^stable-build guard: \d+ Arc gotchas? in the lines just written \(\d+ error, \d+ warn\)\./, "additionalContext stays English");
  const notice = j.systemMessage;
  assertNoticeShape(notice, lang);
  return { ctx, notice };
}

function assertNoticeShape(notice, lang) {
  assert.equal(typeof notice, "string");
  assert.ok(notice.length <= 200, `systemMessage length ${notice.length}: ${notice}`);
  assert.doesNotMatch(notice, /[\n\r\u2028\u2029]/, "one line");
  assert.match(notice, lang === "pt-BR" ? PT_NOTICE : EN_NOTICE);
  // never presented as an error or a block, in either language
  assert.doesNotMatch(notice, /\berror\b|\berros?\b|block|bloque/i);
}

// ---------- prefs.mjs ----------

describe("saved language (scripts/guard/prefs.mjs)", () => {
  test("normalizeLanguage accepts the installer's spellings and nothing else", () => {
    assert.deepEqual(prefs.LANGUAGES, ["en", "pt-BR"]);
    for (const v of ["en", "EN", "English", " english "]) assert.equal(prefs.normalizeLanguage(v), "en", v);
    for (const v of ["pt", "PT", "pt-br", "pt-BR", "pt_BR", "PT_br", "portugues", "Português", "PORTUGUÊS", "portugue\u0302s"]) {
      assert.equal(prefs.normalizeLanguage(v), "pt-BR", v);
    }
    for (const v of ["", "fr", "es", "pt-PT", "en-US", "ptbr", "__proto__", "constructor", null, undefined, 1, true, ["pt-BR"], { language: "pt-BR" }]) {
      assert.equal(prefs.normalizeLanguage(v), null, String(v));
    }
  });

  test("install.sh's norm_lang and normalizeLanguage agree on every spelling", () => {
    // The installer's function, run as is under the oldest supported bash (macOS /bin/bash 3.2).
    const src = readFileSync(path.join(REPO, "install.sh"), "utf8");
    const fn = (/^ {2}norm_lang\(\) \{\n[\s\S]*?\n {2}\}$/m.exec(src) || [])[0];
    assert.ok(fn, "norm_lang() not found in install.sh");
    const bash = existsSync("/bin/bash") ? "/bin/bash" : "bash";
    const values = ["en", "EN", "English", "pt", "PT", "pt-br", "pt-BR", "pt_BR", "PT_br", "portugues", "Português",
      "PORTUGUÊS", "português", "PORTUGUÊS", "", "fr", "pt-PT", "en-US", "ptbr", "__proto__",
      // surrounding whitespace, as in a hand-edited config.json: both sides ignore it
      "english ", " pt-BR ", "\tEN\n", "  português  ", "\npt", "   ", "pt br", " pt -BR"];
    for (const v of values) {
      for (const locale of ["C", "en_US.UTF-8"]) {
        const r = spawnSync(bash, ["-c", `${fn}\nnorm_lang "$1" || printf 'null'`, "norm_lang", v], { encoding: "utf8", env: { PATH: process.env.PATH, LC_ALL: locale } });
        assert.equal(r.status, 0, r.stderr);
        assert.equal(r.stdout, String(prefs.normalizeLanguage(v)), `${JSON.stringify(v)} (${locale})`);
      }
    }
  });

  test("readLanguage reads $STABLE_BUILD_HOME/config.json and never throws", () => {
    const cases = [
      [undefined, null], // no config.json
      [{ config: { guard: true } }, null],
      [{ config: { language: "pt-BR" } }, "pt-BR"],
      [{ config: { schemaVersion: 1, guard: true, language: "en" } }, "en"],
      [{ config: { language: "pt_BR", guard: false } }, "pt-BR"],
      [{ config: { language: " pt-BR " } }, "pt-BR"],
      [{ config: { language: "\tEnglish\n" } }, "en"],
      [{ config: { language: "fr" } }, null],
      [{ config: { language: 42 } }, null],
      [{ config: { nested: { language: "pt-BR" } } }, null],
      [{ configText: '["pt-BR"]' }, null],
      [{ configText: "null" }, null],
      [{ configText: '{"guard": true, "language": ' }, null], // broken JSON
      [{ configText: "" }, null],
    ];
    for (const [cfg, want] of cases) {
      const { env } = sandbox(cfg);
      assert.equal(prefs.readLanguage(env), want, JSON.stringify(cfg));
    }
    // config.json that is a directory, and a HOME that does not exist
    const { env } = sandbox();
    mkdirSync(path.join(env.STABLE_BUILD_HOME, "config.json"));
    assert.equal(prefs.readLanguage(env), null);
    assert.equal(prefs.readLanguage({ HOME: path.join(tmp(), "missing") }), null);
  });

  test("--status reports the saved language next to the guard state", () => {
    const status = (cfg) => JSON.parse(spawnSync(process.execPath, [GUARD, "--status"], { encoding: "utf8", env: sandbox(cfg).env }).stdout);
    let s = status({ config: { language: "pt-BR" } });
    assert.equal(s.guard, "off");
    assert.equal(s.language, "pt-BR");
    assert.equal(s.configWarning, null, "a language-only config.json is not a consent mismatch");
    s = status({ config: { guard: true, language: "en" } });
    assert.equal(s.guard, "on");
    assert.equal(s.language, "en");
    assert.equal(status(undefined).language, null);
  });
});

// ---------- guard systemMessage ----------

describe("guard systemMessage in pt-BR", () => {
  test("run.sh: pt-BR one-line notice, additionalContext identical to the English run", () => {
    const en = guardRun({ config: { schemaVersion: 1, guard: true } });
    const pt = guardRun({ config: { schemaVersion: 1, guard: true, language: "pt-BR" } });
    for (const p of [en, pt]) {
      assert.equal(p.status, 0);
      assert.equal(p.stderr, "");
    }
    const a = advisory(en.stdout, "en");
    const b = advisory(pt.stdout, "pt-BR");
    assert.equal(b.ctx, a.ctx, "agent-facing additionalContext stays English and unchanged");
    // same files and rule ids in both lines; only the words around them change
    const tokens = (s) => s.replace(/^stable-build guard: \d+ \D+? (?:in|em) /, "").replace(/ — .*$/, "");
    assert.equal(tokens(b.notice), tokens(a.notice));
    for (const id of RULE_IDS) assert.equal(b.notice.includes(id), a.notice.includes(id), id);
  });

  test("every payload shape gives the pt-BR notice (Claude Write/Edit/MultiEdit, Codex apply_patch)", () => {
    for (const name of ["claude-write", "claude-edit", "claude-multiedit", "codex-apply-patch"]) {
      const { home, env } = sandbox({ config: { guard: true, language: "pt-BR" } });
      const root = project(home, { files: { "src/pay.ts": PAY_TS } });
      const p = runSh(payload(name, root), env);
      assert.equal(p.status, 0, name);
      assert.equal(p.stderr, "", name);
      advisory(p.stdout, "pt-BR");
    }
  });

  test("formatHookNotice pt-BR: singular, plural, overflow lists and the long-path fallback", () => {
    const base = "/p";
    const f = (id, file, line) => ({ id, file: path.join(base, file), line });
    const one = [f("transfer-filter-no-emitter", "src/history.ts", 3)];
    assert.equal(guard.formatHookNotice(one, base, "pt-BR"),
      "stable-build guard: 1 pegadinha da Arc em src/history.ts (transfer-filter-no-emitter) — aviso, edição mantida");
    const four = [f("getlogs-unpaged", "a.ts", 1), f("fee-below-floor", "b.ts", 2), f("upstream-foundry", "c.sh", 3), f("multicall3from-value", "d.ts", 4)];
    assert.equal(guard.formatHookNotice(four, base, "pt-BR"),
      "stable-build guard: 4 pegadinhas da Arc em a.ts, b.ts e mais 2 (getlogs-unpaged, fee-below-floor, multicall3from-value e mais 1) — aviso, edição mantida");
    const long = `${"x".repeat(300)}\nevil.ts`;
    const n = guard.formatHookNotice([f("getlogs-unpaged", long, 1)], base, "pt-BR");
    assert.equal(n, "stable-build guard: 1 pegadinha da Arc (getlogs-unpaged) — aviso, edição mantida");
    assertNoticeShape(n, "pt-BR");
  });

  test("formatHookNotice stays one line of at most 200 characters for any mix, in both languages", () => {
    const base = "/p";
    let seed = 7;
    const rnd = (k) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % k; };
    const names = ["a.ts", "src/core/very/deep/path/with/many/segments/ledger.ts", `${"y".repeat(150)}.ts`, "x\u2028y.ts", "ci/\n.github.yml", "çãé/ñ.ts"];
    for (let i = 0; i < 300; i++) {
      const k = 1 + rnd(12);
      const findings = Array.from({ length: k }, () => ({ id: RULE_IDS[rnd(RULE_IDS.length)], file: path.join(base, names[rnd(names.length)]), line: 1 + rnd(99) }));
      for (const lang of ["en", "pt-BR"]) assertNoticeShape(guard.formatHookNotice(findings, base, lang), lang);
    }
  });

  test("24 findings through run.sh: the pt-BR line mirrors the English one", () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      `export const t${i} = (w: any, to: \`0x\${string}\`) => w.sendTransaction({ to, value: parseUnits("${i + 1}", 6), maxFeePerGas: parseGwei("1") });`).join("\n");
    const text = `import { parseUnits, parseGwei } from "viem";\n${many}\n`;
    const { home, env } = sandbox({ config: { guard: true, language: "pt-BR" } });
    const root = project(home, { files: { "src/many.ts": text } });
    const input = JSON.stringify({ session_id: "t", cwd: root, hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: path.join(root, "src/many.ts"), content: text } });
    const p = runSh(input, env);
    assert.equal(p.status, 0);
    const { notice, ctx } = advisory(p.stdout, "pt-BR");
    assert.equal(notice, "stable-build guard: 24 pegadinhas da Arc em src/many.ts (usdc-native-value-6dp, fee-below-floor) — aviso, edição mantida");
    assert.match(ctx, /^stable-build guard: 24 Arc gotchas in the lines just written/);
  });

  test("the gotchas skill quotes the notice exactly as the guard prints it, in both languages", () => {
    const md = readFileSync(GOTCHAS_SKILL, "utf8");
    const one = [{ id: "transfer-filter-no-emitter", file: "/p/src/history.ts", line: 3 }];
    for (const lang of ["en", "pt-BR"]) {
      const n = guard.formatHookNotice(one, "/p", lang);
      assert.ok(md.includes(`"${n}"`), `gotchas/SKILL.md should quote: ${n}`);
    }
  });
});

// ---------- no change when the language is unset ----------

describe("language unset, English or unknown: output unchanged", () => {
  test("guard hook stdout is byte-identical to the run without a language", () => {
    const base = guardRun({ config: { schemaVersion: 1, guard: true } });
    assert.equal(base.status, 0);
    const { notice } = advisory(base.stdout, "en");
    assert.equal(notice, "stable-build guard: 2 Arc gotchas in src/pay.ts (usdc-native-value-6dp, fee-below-floor) — advisory, edit kept");
    for (const cfg of [
      { config: { schemaVersion: 1, guard: true, language: "en" } },
      { config: { schemaVersion: 1, guard: true, language: "English" } },
      { config: { schemaVersion: 1, guard: true, language: "fr" } },
      { config: { schemaVersion: 1, guard: true, language: null } },
      { configText: '{"schemaVersion":1,"guard": true,"language": }' }, // passes the run.sh gate, broken JSON
    ]) {
      const p = guardRun(cfg);
      assert.equal(p.status, 0, JSON.stringify(cfg));
      assert.equal(p.stderr, "", JSON.stringify(cfg));
      assert.equal(p.stdout, base.stdout, JSON.stringify(cfg));
    }
  });

  test("formatHookNotice defaults to English and ignores unknown languages", () => {
    const one = [{ id: "getlogs-unpaged", file: "/p/a.ts", line: 1 }];
    const en = guard.formatHookNotice(one, "/p");
    assert.equal(en, "stable-build guard: 1 Arc gotcha in a.ts (getlogs-unpaged) — advisory, edit kept");
    for (const lang of ["en", null, undefined, "fr", "pt", "__proto__", "constructor", "toString"]) {
      assert.equal(guard.formatHookNotice(one, "/p", lang), en, String(lang));
    }
  });

  test("SessionStart notice is the same English text without a language", () => {
    const expected = "stable-build: Arc project detected (.stable-build/project.json). The edit-time guard checks lines you add against 10 Arc rules from docs.arc.io and reports findings as a one-line advisory notice plus context for the agent, never as an error; it never blocks or undoes an edit. Use the stable-build gotchas skill to explain a rule id, scan the repo, or turn the guard off.\n";
    for (const cfg of [
      { config: { guard: true } },
      { config: { guard: true, language: "en" } },
      { config: { guard: true, language: "xx" } },
      { configText: '{"guard": true, "language": ' },
    ]) {
      const p = sessionRun(cfg);
      assert.equal(p.status, 0, JSON.stringify(cfg));
      assert.equal(p.stdout, expected, JSON.stringify(cfg));
    }
    const off = sessionRun({ config: { guard: true } }, { guardJson: { disable: ["*"] } });
    assert.equal(off.stdout, "stable-build: Arc project detected (.stable-build/project.json). The edit-time Arc guard is turned off for this project in .stable-build/guard.json. The stable-build gotchas skill can still explain Arc pitfalls by rule id and scan the repo.\n");
  });
});

// ---------- SessionStart notice ----------

describe("SessionStart notice in both languages", () => {
  test("at most 400 characters without truncation, for every marker length", () => {
    for (const lang of ["en", "pt-BR"]) {
      for (const off of [false, true]) {
        for (let len = 1; len <= 120; len++) {
          const t = session.formatSessionNotice("m".repeat(len), off, lang);
          assert.ok(t.length <= session.MAX_NOTICE, `${lang} off=${off} marker ${len}: ${t.length}`);
          assert.match(t, /(guard off|desligar o guard|scan the repo|varre o repo)\.$/, `${lang} off=${off} marker ${len}: truncated`);
          assert.doesNotMatch(t, /\n/);
        }
      }
    }
  });

  test("run.sh in an Arc project with pt-BR saved: the pt-BR notice, then the reply-language line", () => {
    const p = sessionRun({ config: { schemaVersion: 1, guard: true, language: "pt-BR" } });
    assert.equal(p.status, 0);
    assert.equal(p.stderr, "");
    const lines = p.stdout.split("\n");
    assert.equal(lines.length, 3, "two lines, newline-terminated");
    assert.equal(lines[2], "");
    const [out, reply] = lines;
    assert.ok(out.length > 50 && out.length <= 400, `${out.length}`);
    assert.equal(reply, REPLY_PT);
    assert.equal(out, "stable-build: projeto Arc detectado (.stable-build/project.json). O guard de edição confere as linhas adicionadas com 10 regras da Arc (docs.arc.io) e informa achados como aviso de uma linha mais contexto para o agente, nunca como erro; nunca bloqueia nem desfaz a edição. Use a skill gotchas do stable-build para explicar um id de regra, varrer o repo ou desligar o guard.");
    const off = sessionRun({ config: { guard: true, language: "pt-BR" } }, { guardJson: { disable: ["*"] } }).stdout.split("\n");
    assert.equal(off.length, 3);
    assert.ok(off[0].length <= 400);
    assert.match(off[0], /^stable-build: projeto Arc detectado \(.+\)\. O guard de edição da Arc está desligado neste projeto em \.stable-build\/guard\.json\./);
    assert.equal(off[1], REPLY_PT, "the reply language holds with the guard off for the project too");
    // a hand-edited spelling of pt-BR reads the same
    assert.equal(sessionRun({ config: { guard: true, language: " Português " } }).stdout.split("\n")[1], REPLY_PT);
  });

  test("the reply-language line: English, one line, only for a saved language other than English", () => {
    assert.equal(session.replyLanguageLine("pt-BR"), REPLY_PT);
    for (const lang of ["en", null, undefined, "", "fr", "pt", "pt_BR", "__proto__", "constructor", "toString", 1]) {
      assert.equal(session.replyLanguageLine(lang), "", String(lang));
    }
    assert.ok(REPLY_PT.length <= 300, `${REPLY_PT.length}`);
    assert.match(REPLY_PT, /^stable-build: /);
    assert.match(REPLY_PT, /Write your replies to the user in Brazilian Portuguese, even when they write in English/);
    // written for the agent: one line of plain ASCII English, no Portuguese words
    assert.match(REPLY_PT, /^[\x20-\x7e]+$/);
    assert.doesNotMatch(REPLY_PT, /\b(?:idioma|portugu[eê]s|responda|usu[aá]rio)\b/i);
    // the same boundaries as the skills' Language section
    for (const kept of ["code", "commands", "file names", "rule ids", "docs quotes"]) assert.ok(REPLY_PT.includes(kept), kept);
  });

  test("sessionNotice in-process: English, unknown or no language adds no line", () => {
    for (const [cfg, lines] of [
      [{ config: { guard: true } }, 1],
      [{ config: { guard: true, language: "en" } }, 1],
      [{ config: { guard: true, language: "xx" } }, 1],
      [{ config: { guard: true, language: "pt-BR" } }, 2],
    ]) {
      const { home, env } = sandbox(cfg);
      const out = session.sessionNotice(project(home), env);
      assert.equal(out.split("\n").length, lines, JSON.stringify(cfg));
      assert.ok(!out.endsWith("\n"));
    }
  });

  test("a non-Arc project prints nothing in either language", () => {
    for (const language of ["en", "pt-BR"]) {
      const { env } = sandbox({ config: { guard: true, language } });
      const dir = tmp();
      writeFileSync(path.join(dir, "package.json"), '{"name":"plain"}\n');
      const p = runSh(sessionInput(dir), env, "session-start");
      assert.equal(p.status, 0);
      assert.equal(p.stdout + p.stderr, "");
    }
  });
});

// ---------- consent gate ----------

describe("consent gate unchanged by a saved language", () => {
  const shim = () => {
    const dir = tmp("sb-shim-");
    const marker = path.join(dir, "node-started");
    writeFileSync(path.join(dir, "node"), `#!/bin/sh\n: > "${marker}"\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 });
    return { dir, marker };
  };

  test("config.json without \"guard\": true never starts node, for either hook", () => {
    const { dir, marker } = shim();
    const configs = [
      { language: "pt-BR" },
      { language: "en" },
      { schemaVersion: 1, language: "pt-BR", guard: false },
      { schemaVersion: 1, language: "pt-BR", languageSetAt: "2026-10-05T00:00:00Z" },
      { language: "pt-BR", note: "guard" },
    ];
    for (const config of configs) {
      for (const script of ["guard", "session-start"]) {
        const { home, env } = sandbox({ config });
        const root = project(home, { files: { "src/pay.ts": PAY_TS } });
        rmSync(marker, { force: true });
        const input = script === "guard" ? payload("claude-write", root) : sessionInput(root);
        const p = runSh(input, { ...env, PATH: `${dir}:${env.PATH}` }, script);
        assert.equal(p.status, 0, `${script} ${JSON.stringify(config)}`);
        assert.equal(p.stdout + p.stderr, "", `${script} ${JSON.stringify(config)}`);
        assert.equal(existsSync(marker), false, `node started for ${script} with ${JSON.stringify(config)}`);
        assert.equal(consent.guardEnabled(env), false, JSON.stringify(config));
      }
    }
  });

  test("with \"guard\": true (compact or pretty-printed) node starts and speaks pt-BR", () => {
    const { dir, marker } = shim();
    for (const configText of [
      '{"schemaVersion":1,"language":"pt-BR","guard":true}',
      '{\n  "schemaVersion": 1,\n  "guard": true,\n  "language": "pt-BR"\n}\n',
    ]) {
      const { home, env } = sandbox({ configText });
      const root = project(home, { files: { "src/pay.ts": PAY_TS } });
      rmSync(marker, { force: true });
      const p = runSh(payload("claude-write", root), { ...env, PATH: `${dir}:${env.PATH}` });
      assert.equal(p.status, 0);
      advisory(p.stdout, "pt-BR");
      assert.equal(existsSync(marker), true);
      assert.equal(consent.guardEnabled(env), true);
    }
  });

  test("--enable and --disable keep the saved language", () => {
    const { env } = sandbox({ config: { schemaVersion: 1, language: "pt-BR" } });
    const file = path.join(env.STABLE_BUILD_HOME, "config.json");
    const cli = (arg) => spawnSync(process.execPath, [GUARD, arg], { encoding: "utf8", env });
    assert.equal(cli("--enable").status, 0);
    let j = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(j.guard, true);
    assert.equal(j.language, "pt-BR");
    assert.equal(prefs.readLanguage(env), "pt-BR");
    assert.equal(cli("--disable").status, 0);
    j = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(j.guard, false);
    assert.equal(j.language, "pt-BR");
  });

  test("a partial install without prefs.mjs stays silent: exit 0, no output, through run.sh and hooks.json", () => {
    const hooks = JSON.parse(readFileSync(HOOKS, "utf8")).hooks;
    const cmd = { guard: hooks.PostToolUse[0].hooks[0].command, "session-start": hooks.SessionStart[0].hooks[0].command };
    const copy = path.join(tmp("sb-plugin-"), "stable-build");
    for (const d of ["scripts", "data", "hooks"]) cpSync(path.join(PLUGIN, d), path.join(copy, d), { recursive: true });
    rmSync(path.join(copy, "scripts", "guard", "prefs.mjs"));
    const { home, env } = sandbox({ config: { guard: true, language: "pt-BR" } });
    const root = project(home, { files: { "src/pay.ts": PAY_TS } });
    const inputs = { guard: payload("claude-edit", root), "session-start": sessionInput(root) };
    for (const script of ["guard", "session-start"]) {
      const direct = spawnSync("/bin/sh", [path.join(copy, "scripts", "run.sh"), script], { input: inputs[script], env, cwd: root, encoding: "utf8" });
      const viaHooks = spawnSync("/bin/sh", ["-c", cmd[script]], { input: inputs[script], env: { ...env, CLAUDE_PLUGIN_ROOT: copy }, cwd: root, encoding: "utf8" });
      for (const p of [direct, viaHooks]) {
        assert.equal(p.status, 0, `${script}: ${p.stderr}`);
        assert.equal(p.stdout + p.stderr, "", script);
      }
    }
  });
});

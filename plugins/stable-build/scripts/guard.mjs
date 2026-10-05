#!/usr/bin/env node
// stable-build guard: advisory checks for apps built on Arc.
//
// Hook mode (no arguments; run by hooks/hooks.json through run.sh after consent):
//   reads a PostToolUse payload on stdin (Claude Write/Edit/MultiEdit or Codex apply_patch),
//   checks only the text just added, and only inside an Arc project.
//   any finding (error or warn) -> exit 0 + one JSON object on stdout, never a hook error:
//     hookSpecificOutput.additionalContext: the findings for the agent ([error]/[warn] labels,
//       rule id, file:line, message, fix, docs URL and the dated docs quote), at most 5 findings
//       and 2,000 characters, ending with the advisory suffix (well under Codex's default
//       additionalContextLimit)
//     systemMessage: one short line for the user (both hosts show it as a warning), in the language
//       saved in $STABLE_BUILD_HOME/config.json ("en" or "pt-BR"; English when none is saved)
//   nothing / non-Arc project / bad input / internal error -> exit 0, no output
//   Hook mode never exits 2. No network, no writes, never blocks or undoes the edit
//   (PostToolUse runs after it). A module that is missing or fails to load stops node before any
//   handler here runs, so run.sh (the hook launcher) discards stderr and always exits 0.
//
// CLI: --scan <path> [--json] | --explain <id> | --list | --status | --enable | --disable | --help
import { readFileSync, readdirSync, statSync, existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizePayload } from "./guard/input.mjs";
import {
  findProject, detectArc, arcMarker, loadGuardConfig, pathIgnored, inlineIgnored, skippedPath, readHead,
  foundryArcProfiles,
} from "./guard/project.mjs";
import { RULES, RULE_IDS, runRules } from "./guard/rules.mjs";
import { readLanguage } from "./guard/prefs.mjs";
import { fileKind, maskComments, lineAt } from "./guard/text.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = path.join(HERE, "..", "data", "gotchas.json");
const MAX_FILE = 512 * 1024;
const MAX_FINDINGS = 5;
const MAX_CHARS = 2000;
const MAX_NOTICE = 200;
const SCAN_MAX_FILES = 5000;
export const SUFFIX = "advisory: the edit was applied; silence with `stable-build-ignore <id>`";

let catalogCache = null;
export function loadCatalog() {
  if (catalogCache) return catalogCache;
  const j = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
  catalogCache = new Map(j.rules.map((r) => [r.id, r]));
  return catalogCache;
}

/**
 * Severity, message, fix and docs evidence for one finding, applying the rule's variant if any
 * (a variant may carry its own evidence quote; otherwise the rule's applies).
 */
export function describe(f, catalog = loadCatalog()) {
  const r = catalog.get(f.id) || { severity: "error", message: f.id, fix: "", evidence: {} };
  const v = (f.variant && r.variants && r.variants[f.variant]) || {};
  const ev = (v.evidence && v.evidence.quote ? v.evidence : r.evidence) || {};
  return {
    severity: v.severity || r.severity,
    message: v.message || r.message,
    fix: v.fix || r.fix,
    url: ev.url || (r.evidence && r.evidence.url) || "",
    quote: ev.quote || "",
    checked: ev.verified_at || "",
  };
}

/**
 * Run the enabled rules over the added chunks of one file.
 * fileText is the file as written (or null); chunks = [{ text, line }].
 */
export function analyze(file, chunks, cfg, fileText) {
  const { kind, isCI } = fileKind(file);
  if (!kind) return [];
  const enabled = RULE_IDS.filter((id) => !cfg.all && !cfg.disable.has(id) && RULES[id].kinds.includes(kind));
  if (!enabled.length) return [];
  const maskedFile = fileText != null ? maskComments(fileText, kind) : null;
  let profiles; // read foundry.toml only when a rule asks (arc-forge / arc-anvil lines)
  const foundryProfiles = () => (profiles === undefined ? (profiles = foundryArcProfiles(file)) : profiles);
  const out = [];
  const seen = new Set();
  for (const c of chunks) {
    const off = fileText != null ? fileText.indexOf(c.text) : -1;
    let raw, full, lo, hi;
    const located = off >= 0;
    if (located) {
      raw = fileText; full = maskedFile; lo = off; hi = off + c.text.length;
    } else {
      raw = (fileText != null ? fileText + "\n" : "") + c.text;
      full = (maskedFile != null ? maskedFile + "\n" : "") + maskComments(c.text, kind);
      lo = fileText != null ? fileText.length + 1 : 0;
      hi = raw.length;
    }
    const res = runRules({ full, lo, hi, kind, isCI, file, foundryProfiles }, enabled);
    if (!res.length) continue;
    const rawLines = raw.split("\n");
    const loLine = lineAt(full, lo);
    for (const f of res) {
      const line = lineAt(full, f.index);
      if (inlineIgnored(rawLines, line, f.id)) continue;
      const fileLine = located ? line : c.line ? c.line + line - loLine : null;
      const key = `${f.id}:${fileLine ?? `c${line}`}:${f.variant || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ id: f.id, variant: f.variant, file, line: fileLine });
    }
  }
  return out;
}

const sevRank = (s) => (s === "error" ? 0 : 1);

/** Findings with severity, message, fix and docs evidence, errors first, then by file and line. */
function hookRows(findings) {
  const catalog = loadCatalog();
  const rows = findings.map((f) => ({ ...f, ...describe(f, catalog) }));
  return rows.sort((a, b) => sevRank(a.severity) - sevRank(b.severity) || a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0));
}

/**
 * Hook message for the agent (additionalContext): at most 5 findings, at most 2,000 characters,
 * [error]/[warn] labels kept, always ending with SUFFIX. Each finding carries its docs URL and the
 * dated docs quote behind the rule, so the agent can act on it without fetching the page.
 * Over budget: quotes go first (last finding first), then docs links, then the text is truncated.
 */
export function formatHookMessage(findings, base) {
  const rows = hookRows(findings);
  const shown = rows.slice(0, MAX_FINDINGS);
  const extra = rows.length - shown.length;
  const groups = [];
  for (const r of shown) {
    const g = groups.find((x) => x.id === r.id && x.variant === r.variant);
    const loc = `${rel(base, r.file)}${r.line ? `:${r.line}` : ""}`;
    if (g) { if (!g.locs.includes(loc)) g.locs.push(loc); } else groups.push({ ...r, locs: [loc] });
  }
  const errors = rows.filter((r) => r.severity === "error").length;
  const head = `stable-build guard: ${rows.length} Arc gotcha${rows.length === 1 ? "" : "s"} in the lines just written (${errors} error, ${rows.length - errors} warn).`;
  // detail per group: 2 = docs link + quote, 1 = docs link, 0 = neither
  const docs = (g, detail) => {
    if (detail < 1 || !g.url) return "";
    const quote = detail >= 2 && g.quote ? ` says "${g.quote}"${g.checked ? ` (checked ${g.checked})` : ""}` : "";
    return ` Docs: ${g.url}${quote}`;
  };
  const detail = groups.map(() => 2);
  const render = () => {
    const lines = groups.map((g, i) => `- [${g.severity}] ${g.id} at ${g.locs.join(", ")}: ${g.message} Fix: ${g.fix}${docs(g, detail[i])}`);
    if (extra > 0) lines.push(`- ...and ${extra} more; run the stable-build gotchas skill to scan the file.`);
    return [head, ...lines].join("\n");
  };
  const budget = MAX_CHARS - SUFFIX.length - 1;
  let body = render();
  for (const level of [2, 1]) {
    for (let i = groups.length - 1; i >= 0 && body.length > budget; i--) {
      if (detail[i] === level) { detail[i] = level - 1; body = render(); }
    }
  }
  if (body.length > budget) body = body.slice(0, budget - 3).trimEnd() + "...";
  return `${body}\n${SUFFIX}`;
}

// The user-facing words of the one-line notice, per saved language. Everything else in it (the
// "stable-build guard:" prefix, file paths and rule ids) is the same in every language.
const NOTICE_TEXT = {
  en: {
    count: (n) => `${n} Arc gotcha${n === 1 ? "" : "s"}`,
    in: "in",
    more: (k) => ` +${k} more`,
    tail: " — advisory, edit kept",
  },
  "pt-BR": {
    count: (n) => `${n} pegadinha${n === 1 ? "" : "s"} da Arc`,
    in: "em",
    more: (k) => ` e mais ${k}`,
    tail: " — aviso, edição mantida",
  },
};

/**
 * One-line user notice (systemMessage), at most 200 characters, e.g.
 * "stable-build guard: 1 Arc gotcha in src/history.ts (transfer-filter-no-emitter) — advisory, edit kept", or with
 * lang "pt-BR": "stable-build guard: 1 pegadinha da Arc em src/history.ts (transfer-filter-no-emitter) — aviso, edição mantida".
 * Severity stays in additionalContext; this line only says what was found and that the edit stands.
 * An unknown or missing lang gives the English line.
 */
export function formatHookNotice(findings, base, lang = "en") {
  const t = Object.hasOwn(NOTICE_TEXT, lang) ? NOTICE_TEXT[lang] : NOTICE_TEXT.en;
  const rows = hookRows(findings);
  const oneLine = (s) => String(s).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ");
  const list = (items, max) => {
    const u = [...new Set(items)];
    return u.slice(0, max).join(", ") + (u.length > max ? t.more(u.length - max) : "");
  };
  const n = rows.length;
  const tail = t.tail;
  const files = list(rows.map((r) => oneLine(rel(base, r.file))), 2);
  const ids = list(rows.map((r) => r.id), 3);
  let text = `stable-build guard: ${t.count(n)} ${t.in} ${files} (${ids})${tail}`;
  if (text.length > MAX_NOTICE) {
    const head = `stable-build guard: ${t.count(n)} (${ids})`;
    text = head.length + tail.length <= MAX_NOTICE ? `${head}${tail}` : `${head.slice(0, MAX_NOTICE - tail.length - 3)}...${tail}`;
  }
  return text;
}

function rel(base, file) {
  const r = base ? path.relative(base, file) : file;
  return !r || r.startsWith("..") ? file : r;
}

function readStdin() {
  if (process.stdin.isTTY) return null;
  try { return readFileSync(0, "utf8"); } catch { return null; }
}

/**
 * Hook mode. Returns { code, stdout? }; code is always 0 (findings are advisory output, never an
 * exit-2 hook error). Never throws.
 */
export function hookMode(rawInput, env = process.env) {
  try {
    if (env.STABLE_BUILD_GUARD_SELFTEST === "throw") throw new Error("selftest");
    if (rawInput == null) return { code: 0 };
    let payload;
    try { payload = JSON.parse(rawInput || "{}"); } catch { return { code: 0 }; }
    const chunks = normalizePayload(payload);
    if (!chunks.length) return { code: 0 };
    const cwd = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : process.cwd();
    const byFile = new Map();
    for (const c of chunks) {
      if (!byFile.has(c.file)) byFile.set(c.file, []);
      byFile.get(c.file).push(c);
    }
    const findings = [];
    const arcByRoot = new Map();
    for (const [file, cs] of byFile) {
      if (!fileKind(file).kind) continue;
      const proj = findProject(file, env);
      if (skippedPath(path.relative(proj.root, file))) continue;
      const cfg = loadGuardConfig(proj);
      if (cfg.all || pathIgnored(cfg, file)) continue;
      const disk = readHead(file, MAX_FILE + 1);
      const fileText = disk != null && disk.length <= MAX_FILE ? disk : null;
      if (!arcByRoot.has(proj.root)) arcByRoot.set(proj.root, detectArc(proj));
      if (!arcByRoot.get(proj.root) && !arcMarker(fileText) && !arcMarker(cs.map((c) => c.text).join("\n"))) continue;
      findings.push(...analyze(file, cs, cfg, fileText));
    }
    if (!findings.length) return { code: 0 };
    const out = {
      systemMessage: formatHookNotice(findings, cwd, readLanguage(env)),
      hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: formatHookMessage(findings, cwd) },
    };
    return { code: 0, stdout: `${JSON.stringify(out)}\n` };
  } catch {
    return { code: 0 }; // fail open
  }
}

// ---------------- CLI modes ----------------

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", "coverage", ".next", ".nuxt", ".turbo",
  ".cache", "cache", "artifacts", "broadcast", "typechain-types", ".venv", "venv", "target", ".stable-build"]);

function walk(target, files) {
  let st;
  try { st = statSync(target); } catch { return; }
  if (st.isFile()) { files.push(target); return; }
  if (!st.isDirectory()) return;
  const stack = [target];
  while (stack.length && files.length < SCAN_MAX_FILES) {
    const dir = stack.pop();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    const foundryRoot = entries.some((e) => e.name === "foundry.toml");
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        if (e.name.startsWith(".") && ![".github", ".circleci"].includes(e.name)) continue;
        if (foundryRoot && e.name === "lib") continue; // Foundry dependencies
        stack.push(p);
      } else if (e.isFile() && fileKind(p).kind && !/^\.env(?!\.example$)/.test(e.name)) {
        files.push(p);
        if (files.length >= SCAN_MAX_FILES) break;
      }
    }
  }
}

export function scan(targets, env = process.env) {
  const files = [];
  for (const t of targets) walk(path.resolve(t), files);
  const first = path.resolve(targets[0] || ".");
  const proj = findProject(first, env);
  const cfg = loadGuardConfig(proj);
  const base = existsSync(first) && statSync(first).isDirectory() ? first : path.dirname(first);
  const findings = [];
  let scanned = 0;
  for (const file of files.sort()) {
    if (pathIgnored(cfg, file)) continue;
    const text = readHead(file, MAX_FILE + 1);
    if (text == null || text.length > MAX_FILE) continue;
    scanned++;
    for (const f of analyze(file, [{ text, line: 1 }], cfg, text)) {
      const d = describe(f);
      findings.push({ id: f.id, variant: f.variant || null, severity: d.severity, file: rel(base, file), line: f.line, message: d.message, fix: d.fix, url: d.url });
    }
  }
  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.id.localeCompare(b.id));
  const errors = findings.filter((f) => f.severity === "error").length;
  return { schemaVersion: 1, root: base, scanned, disabled: cfg.all ? ["*"] : [...cfg.disable], findings, errors, warnings: findings.length - errors };
}

function explain(id) {
  const r = loadCatalog().get(id);
  if (!r) return null;
  const lines = [
    `${r.id} (${r.severity}): ${r.title}`,
    `What it flags: ${r.flags}`,
    `Why: ${r.message}`,
    `Fix: ${r.fix}`,
    `Evidence: "${r.evidence.quote}" (${r.evidence.url}, verified ${r.evidence.verified_at})`,
  ];
  for (const [k, v] of Object.entries(r.variants || {})) {
    lines.push(`Variant ${k} (${v.severity}): ${v.message}`);
    if (v.evidence && v.evidence.quote) lines.push(`  Evidence: "${v.evidence.quote}" (${v.evidence.url}, verified ${v.evidence.verified_at})`);
  }
  if (r.facts) lines.push(`Facts: ${JSON.stringify(r.facts)}`);
  for (const u of r.see_also || []) lines.push(`See also: ${u}`);
  for (const n of r.notes || []) lines.push(`Note: ${n}`);
  lines.push(`Silence one line: add \`stable-build-ignore ${r.id}\` in a comment on that line or the line above.`);
  lines.push(`Disable for a project: add "${r.id}" to "disable" in .stable-build/guard.json.`);
  return lines.join("\n");
}

async function status(env) {
  const { readConfig, guardEnabled } = await import("./guard/consent.mjs");
  const c = readConfig(env);
  const proj = findProject(process.cwd(), env);
  const cfg = loadGuardConfig(proj);
  const on = guardEnabled(env);
  // The hook launcher reads config.json with a one-line text test; say so when that disagrees with the JSON.
  let configWarning = null;
  if (c.config && (c.config.guard === true) !== on) {
    configWarning = on
      ? 'the hook launcher reads config.json as on, but its top-level "guard" is not true; rewrite it with --enable or --disable'
      : 'config.json sets "guard" to true, but not as "guard": true on one line, so the hook launcher treats the guard as off; rewrite it with --enable';
  }
  return {
    configFile: c.file,
    guard: on ? "on" : "off",
    configError: c.error,
    configWarning,
    consentAt: c.config?.consentAt ?? null,
    language: readLanguage(env),
    project: proj.root,
    arcProject: detectArc(proj),
    projectDisabled: cfg.all ? ["*"] : [...cfg.disable],
    rules: RULE_IDS,
  };
}

const HELP = `stable-build guard (advisory Arc checks; no network)
  node guard.mjs                 hook mode: PostToolUse payload on stdin; always exit 0, findings as JSON
  node guard.mjs --scan <path>   scan files or a directory [--json]; exit 1 if any error finding
  node guard.mjs --explain <id>  explain one rule (message, fix, docs evidence)
  node guard.mjs --list          list rule ids
  node guard.mjs --status        consent and project state (read-only)
  node guard.mjs --enable        turn the edit-time guard on  (writes $STABLE_BUILD_HOME/config.json)
  node guard.mjs --disable       turn the edit-time guard off (writes $STABLE_BUILD_HOME/config.json)
Only run --enable/--disable after the user has confirmed.`;

async function cli(argv, env) {
  const a = argv[0];
  if (a === "--help" || a === "-h") { process.stdout.write(`${HELP}\n`); return 0; }
  if (a === "--list") {
    for (const r of loadCatalog().values()) process.stdout.write(`${r.id}\t${r.severity}\t${r.title}\n`);
    return 0;
  }
  if (a === "--explain") {
    const text = argv[1] && explain(argv[1]);
    if (!text) { process.stderr.write(`unknown rule id: ${argv[1] ?? ""}\nknown: ${RULE_IDS.join(", ")}\n`); return 2; }
    process.stdout.write(`${text}\n`);
    return 0;
  }
  if (a === "--status") { process.stdout.write(`${JSON.stringify(await status(env), null, 2)}\n`); return 0; }
  if (a === "--enable" || a === "--disable") {
    const { writeConsent } = await import("./guard/consent.mjs");
    try {
      const r = writeConsent(a === "--enable", env);
      process.stdout.write(`guard ${r.config.guard ? "on" : "off"}: ${r.file}\n`);
      return 0;
    } catch (e) {
      process.stderr.write(`${e.message}\n`);
      return 1;
    }
  }
  if (a === "--scan") {
    const json = argv.includes("--json");
    const targets = argv.slice(1).filter((x) => x !== "--json");
    if (!targets.length) targets.push(".");
    const missing = targets.filter((t) => !existsSync(t));
    if (missing.length) { process.stderr.write(`no such file or directory: ${missing.join(", ")}\n`); return 2; }
    const r = scan(targets, env);
    if (json) process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
    else {
      // Text mode prints paths that open from the current directory (`--scan ./src` -> src/a.ts);
      // --json keeps paths relative to its "root".
      const shown = (f) => {
        const abs = path.resolve(r.root, f.file);
        const fromCwd = path.relative(process.cwd(), abs);
        return fromCwd && !fromCwd.startsWith("..") && !path.isAbsolute(fromCwd) ? fromCwd : abs;
      };
      for (const f of r.findings) process.stdout.write(`${shown(f)}:${f.line}  ${f.severity}  ${f.id}  ${f.message}\n`);
      process.stdout.write(`${r.findings.length} finding(s): ${r.errors} error, ${r.warnings} warn, in ${r.scanned} file(s) under ${r.root}.` +
        `${r.disabled.length ? ` Disabled here: ${r.disabled.join(", ")}.` : ""} Explain one: node ${JSON.stringify(fileURLToPath(import.meta.url))} --explain <id>\n`);
    }
    return r.errors > 0 ? 1 : 0;
  }
  process.stderr.write(`${HELP}\n`);
  return 2;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length) return cli(argv, process.env);
  const input = readStdin();
  if (input == null) { process.stdout.write(`${HELP}\n`); return 0; }
  const r = hookMode(input, process.env);
  if (r.stdout) process.stdout.write(r.stdout);
  return 0; // hook mode never exits 2: every finding is advisory JSON on stdout
}

function sameFile(a, b) {
  try { return realpathSync(a) === realpathSync(b); } catch { return false; }
}
const isMain = Boolean(process.argv[1]) && sameFile(process.argv[1], fileURLToPath(import.meta.url));
if (isMain) {
  const hook = process.argv.length <= 2;
  if (hook) process.on("uncaughtException", () => process.exit(0));
  main().then((code) => { process.exitCode = code; }, () => { process.exitCode = hook ? 0 : 1; });
}

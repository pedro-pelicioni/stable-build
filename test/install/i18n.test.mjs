// node --test test/install/i18n.test.mjs
// Completeness of the installer's two languages (en, pt-BR), checked on install.sh itself:
//   - the message tables (_msg_en, _msg_pt) hold the same ids, read through bash so escapes are real;
//   - every id the script uses exists in both tables, and every table entry is used;
//   - each id has the same number of %s in both languages, no other printf conversion, and every
//     call site passes exactly that many arguments;
//   - Portuguese entries are translated (identical text only for an allowlisted, justified set) and
//     carry no common English words outside commands, flags, paths and product names;
//   - no printf/echo/say/line call prints a literal word that bypasses msg, except commands, paths
//     and product names (ALLOWED_WORDS);
//   - the embedded node helper writes nothing in English to stderr;
//   - a few cheap runs: --help in both languages, the bilingual errors for a bad language, and --help
//     and argument errors in the language saved under --prefix or HOME, whatever the argument order.
// Runs use env -i with a temporary HOME; nothing outside it is read or written.
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const INSTALL = path.join(REPO, "install.sh");
const SRC = readFileSync(INSTALL, "utf8");
const LINES = SRC.split("\n");
// macOS ships bash 3.2 as /bin/bash: the oldest bash the installer supports
const BASH = existsSync("/bin/bash") ? "/bin/bash" : "bash";

// ---------------------------------------------------------------- regions of install.sh
const lineOf = (re, from = 0) => {
  for (let i = from; i < LINES.length; i++) if (re.test(LINES[i])) return i;
  throw new Error(`install.sh: no line matches ${re}`);
};
const EN_START = lineOf(/^ {2}_msg_en\(\) \{$/);
const PT_START = lineOf(/^ {2}_msg_pt\(\) \{$/);
const TABLES_END = lineOf(/^ {2}\}$/, PT_START); // closing brace of _msg_pt
const HELPER_START = lineOf(/HELPER_JS <<'JS_EOF'/);
const HELPER_END = lineOf(/^JS_EOF$/, HELPER_START);
const HELPER_JS = LINES.slice(HELPER_START + 1, HELPER_END).join("\n");

// ids in a table body: lines like `      some_id) _T="..." ;;`
const tableIds = (from, to) => {
  const ids = [];
  for (let i = from; i < to; i++) {
    const m = /^ {6}([a-z][a-z0-9_]*)\) _T=/.exec(LINES[i]);
    if (m) ids.push(m[1]);
  }
  return ids;
};
const EN_IDS = tableIds(EN_START, PT_START);
const PT_IDS = tableIds(PT_START, TABLES_END);

// The templates as bash sees them (quotes, \" and \$ resolved; \n still for printf to expand).
function readTables() {
  const fns = LINES.slice(EN_START, TABLES_END + 1).join("\n");
  const ids = [...new Set([...EN_IDS, ...PT_IDS])].join(" ");
  const script = `${fns}
for id in ${ids}; do
  _T=''; if _msg_en "$id"; then printf 'en\\0%s\\0%s\\0' "$id" "$_T"; fi
  _T=''; if _msg_pt "$id"; then printf 'pt\\0%s\\0%s\\0' "$id" "$_T"; fi
done`;
  const r = spawnSync(BASH, ["-c", script], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const parts = r.stdout.split("\0");
  const en = new Map(), pt = new Map();
  for (let i = 0; i + 2 < parts.length; i += 3) (parts[i] === "en" ? en : pt).set(parts[i + 1], parts[i + 2]);
  return { en, pt };
}
const { en: EN, pt: PT } = readTables();

// ---------------------------------------------------------------- a small bash word scanner
// Enough of bash's quoting to find where a word or a simple command ends: '…', "…", \x, $(…), ${…}.
function skipDq(s, i) { // i: just after the opening "
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") { i += 2; continue; }
    if (c === '"') return i + 1;
    if (c === "$" && s[i + 1] === "(") { i = skipParen(s, i + 2); continue; }
    if (c === "$" && s[i + 1] === "{") { i = skipBrace(s, i + 2); continue; }
    i++;
  }
  return i;
}
function skipSq(s, i) { const j = s.indexOf("'", i); return j < 0 ? s.length : j + 1; }
function skipParen(s, i) { // i: just after $(
  let depth = 1;
  while (i < s.length && depth > 0) {
    const c = s[i];
    if (c === "\\") { i += 2; continue; }
    if (c === "'") { i = skipSq(s, i + 1); continue; }
    if (c === '"') { i = skipDq(s, i + 1); continue; }
    if (c === "$" && s[i + 1] === "(") { i = skipParen(s, i + 2); continue; }
    if (c === "$" && s[i + 1] === "{") { i = skipBrace(s, i + 2); continue; }
    if (c === "(") depth++;
    else if (c === ")") depth--;
    i++;
  }
  return i;
}
function skipBrace(s, i) { // i: just after ${
  let depth = 1;
  while (i < s.length && depth > 0) {
    const c = s[i];
    if (c === "\\") { i += 2; continue; }
    if (c === '"') { i = skipDq(s, i + 1); continue; }
    if (c === "$" && s[i + 1] === "(") { i = skipParen(s, i + 2); continue; }
    if (c === "$" && s[i + 1] === "{") { i = skipBrace(s, i + 2); continue; }
    if (c === "{") depth++;
    else if (c === "}") depth--;
    i++;
  }
  return i;
}
const ENDS_CMD = new Set([";", ")", "|", "&", ">", "<", "\n", "}"]);
// The words of the simple command starting at s[i], and the text after it (redirections etc.).
function words(s, i) {
  const out = [];
  for (;;) {
    while (s[i] === " " || s[i] === "\t") i++;
    if (i >= s.length || ENDS_CMD.has(s[i]) || s[i] === "#") return { words: out, rest: s.slice(i) };
    const start = i;
    while (i < s.length) {
      const c = s[i];
      if (c === " " || c === "\t" || ENDS_CMD.has(c)) break;
      if (c === "\\") { i += 2; continue; }
      if (c === "'") { i = skipSq(s, i + 1); continue; }
      if (c === '"') { i = skipDq(s, i + 1); continue; }
      if (c === "$" && s[i + 1] === "(") { i = skipParen(s, i + 2); continue; }
      if (c === "$" && s[i + 1] === "{") { i = skipBrace(s, i + 2); continue; }
      i++;
    }
    out.push(s.slice(start, i));
  }
}
// The literal text of a word: quotes dropped, expansions ($x, ${…}, $(…)) removed.
function literal(w) {
  let o = "";
  for (let i = 0; i < w.length;) {
    const c = w[i];
    if (c === "$" && w[i + 1] === "(") { i = skipParen(w, i + 2); continue; }
    if (c === "$" && w[i + 1] === "{") { i = skipBrace(w, i + 2); continue; }
    if (c === "$" && /[A-Za-z_0-9*@#?]/.test(w[i + 1] || "")) {
      i += 2; while (/[A-Za-z0-9_]/.test(w[i] || "") && /[A-Za-z_]/.test(w[i - 1])) i++;
      continue;
    }
    if (c === "\\") { o += " "; i += 2; continue; } // \n, \", \t: not words
    if (c === "'" || c === '"') { i++; continue; }
    o += c; i++;
  }
  return o;
}

// The script as code: no message tables, no node helper, no comments; continuation lines joined.
function codeText() {
  const keep = LINES.map((l, i) => ((i >= EN_START && i <= TABLES_END) || (i > HELPER_START && i <= HELPER_END) ? "" : l));
  const stripComment = (l) => {
    if (/^\s*#/.test(l)) return "";
    // a # that starts a word, outside quotes, starts a comment
    let q = "";
    for (let i = 0; i < l.length; i++) {
      const c = l[i];
      if (q) { if (c === "\\" && q === '"') i++; else if (c === q) q = ""; continue; }
      if (c === "\\") { i++; continue; }
      if (c === "'" || c === '"') q = c;
      else if (c === "#" && (i === 0 || /\s/.test(l[i - 1])) && l[i - 1] !== "$") return l.slice(0, i);
    }
    return l;
  };
  return keep.map(stripComment).join("\n").replace(/\\\n/g, " ");
}
const CODE = codeText();

// Call sites of the message helpers with a literal id: [fn, id, argument words]
const MSG_FNS = ["msg", "say_t", "err_t", "warn_t", "die_t", "section", "ask"];
const CALLS = [];
for (const m of CODE.matchAll(/(^|[\s;({|&]|\$\()(msg|say_t|err_t|warn_t|die_t|section|ask)[ \t]+([a-z][a-z0-9_]*)(?=[\s;)|&>]|$)/gm)) {
  const after = m.index + m[0].length;
  CALLS.push({ fn: m[2], id: m[3], args: words(CODE, after).words });
}
const placeholders = (t) => (t.match(/%s/g) || []).length;

// ---------------------------------------------------------------- tables
describe("message tables", () => {
  test("both tables were read and are not trivially small", () => {
    assert.ok(EN.size > 100, `en entries: ${EN.size}`);
    assert.equal(EN.size, EN_IDS.length, "an en id is defined twice");
    assert.equal(PT.size, PT_IDS.length, "a pt-BR id is defined twice");
  });

  test("en and pt-BR define the same ids, in the same order", () => {
    assert.deepEqual(PT_IDS, EN_IDS);
  });

  test("every id used in install.sh exists in both tables", () => {
    const missing = [];
    for (const c of CALLS) {
      if (!EN.has(c.id)) missing.push(`en:${c.id}`);
      if (!PT.has(c.id)) missing.push(`pt-BR:${c.id}`);
    }
    assert.deepEqual([...new Set(missing)], []);
    assert.ok(CALLS.length > 150, `call sites found: ${CALLS.length}`);
  });

  test("every table entry is used", () => {
    const used = new Set(CALLS.map((c) => c.id));
    assert.deepEqual(EN_IDS.filter((id) => !used.has(id)), []);
  });

  test("same %s count in both languages, and no other printf conversion", () => {
    const bad = [];
    for (const [id, t] of EN) {
      if (placeholders(t) !== placeholders(PT.get(id))) bad.push(`${id}: en ${placeholders(t)} vs pt-BR ${placeholders(PT.get(id))}`);
      for (const [lang, s] of [["en", t], ["pt-BR", PT.get(id)]]) {
        const other = s.replace(/%s|%%/g, "").match(/%./g);
        if (other) bad.push(`${lang} ${id}: ${other.join(" ")}`);
        // printf would turn these into escapes: only \n and the backslash itself are meant
        const esc = s.match(/\\[^n\\]/g);
        if (esc) bad.push(`${lang} ${id}: escape ${esc.join(" ")}`);
      }
    }
    assert.deepEqual(bad, []);
  });

  test("every call site passes as many arguments as the template has %s", () => {
    const bad = [];
    for (const c of CALLS) {
      if (c.fn === "ask") continue; // ask <question-id> <default> <--yes answer> [<no-terminal answer>]
      const want = placeholders(EN.get(c.id) || "");
      if (c.args.length !== want) bad.push(`${c.fn} ${c.id}: ${c.args.length} argument(s), template has ${want}`);
    }
    assert.deepEqual(bad, []);
  });

  // Identical in both tables on purpose: bilingual texts shown before a language is chosen (or when
  // it cannot be), and entries made only of names, commands and placeholders.
  const SAME_OK = new Map([
    ["lang_banner", "bilingual"], ["lang_menu", "bilingual"], ["lang_menu_retry", "bilingual"],
    ["err_lang_unknown", "bilingual"], ["err_lang_missing", "bilingual"], ["err_lang_env", "bilingual"],
    ["ours_c_ver", "names only"], ["ours_x_ver", "names only"], ["fin_claude", "names only"], ["fin_codex", "names only"],
    ["hdr_hosts", "'hosts' is used as is in pt-BR"], ["sec_studio", "product name"], ["col_guard", "feature name"],
    ["ans_no", "N is the same letter"],
  ]);

  test("pt-BR entries are translated (identical only when allowlisted)", () => {
    const same = EN_IDS.filter((id) => EN.get(id) === PT.get(id));
    assert.deepEqual(same.filter((id) => !SAME_OK.has(id)), [], "translate these or allowlist them with a reason");
    assert.deepEqual([...SAME_OK.keys()].filter((id) => !same.includes(id)), [], "stale SAME_OK entries");
  });

  test("bilingual entries carry both languages", () => {
    for (const id of ["err_lang_unknown", "err_lang_missing", "err_lang_env"]) {
      // read through bash, before printf: the line break is still the two characters \n
      assert.match(EN.get(id), /^stable-build: error: .+\\nstable-build: erro: /, id);
    }
    assert.match(EN.get("lang_menu"), /^Language \/ Idioma: \[1\] English {2}\[2\] Português \(Brasil\)/);
    assert.match(EN.get("lang_menu_retry"), /Type 1 or 2\. \/ Digite 1 ou 2\./);
  });

  // Words that would mean an English sentence slipped into pt-BR. Not checked: "a", "no", "do",
  // "use", "remove" and the like, which are Portuguese words too.
  const ENGLISH = /\b(the|and|is|are|was|not|with|from|this|that|your|you|for|of|in|it|to|on|run|rerun|skipped|installed|added|removed|already|nothing|done|next|plan|state|language|warning|error|kept|keep|still|here|only|when|will|cannot|does|must|needs|stays)\b/gi;
  // what is not prose: 'quoted commands', URLs, paths, flags, ${VARS}, ALL_CAPS names, product names
  const notProse = (t) => t
    .replace(/Circle Developer Terms|Circle Technology Services, LLC|Claude Code|Arc Studio|Language \/ Idioma.*?\[1\] English|Type 1 or 2\.|stable-build: error:.*?\\n/g, " ")
    .replace(/'[^'\n]*'/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\S*\/\S*/g, " ")
    .replace(/(^|[^\w-])--?[a-z][\w-]*(=\S*)?/g, " ")
    .replace(/\$\w+|\b[A-Z][A-Z0-9_]{2,}\b/g, " ");

  test("pt-BR entries have no common English words outside commands, flags, paths and names", () => {
    const bad = [];
    for (const [id, t] of PT) {
      const hits = notProse(t).match(ENGLISH);
      if (hits) bad.push(`${id}: ${[...new Set(hits)].join(", ")}`);
    }
    assert.deepEqual(bad, []);
  });

  test("the en usage text and the pt-BR one list the same flags and variables", () => {
    const flags = (t) => [...new Set(t.match(/(?<![\w-])--?[a-z][\w-]*|STABLE_BUILD_\w+/g))].sort();
    assert.deepEqual(flags(PT.get("usage")), flags(EN.get("usage")));
    assert.ok(EN.get("usage").includes("--lang=LANG"));
    assert.ok(EN.get("usage").includes("STABLE_BUILD_LANG"));
  });
});

// ---------------------------------------------------------------- literals that bypass msg
describe("no user-facing literal bypasses msg", () => {
  // Words that may appear literally in printed text: host and CLI names, subcommands printed as
  // copy-paste commands, file names, language codes.
  const ALLOWED_WORDS = new Set([
    "claude", "codex", "circle", "mcp", "studio", "arc", "cli", "stable", "build",
    "plugin", "marketplace", "uninstall", "remove", "list", "rm", "rmdir",
    "config", "json", "manifest", "en", "pt", "br",
  ]);
  const OUTPUT_CMDS = /(^|[\s;({|&]|\$\()(printf|echo|say|line)[ \t]+/gm;

  test("printf, echo, say and line print only placeholders, names and commands", () => {
    const bad = [];
    let sites = 0;
    for (const m of CODE.matchAll(OUTPUT_CMDS)) {
      const at = m.index + m[0].length;
      const { words: ws, rest } = words(CODE, at);
      // writing the helper's own files is not output
      if (/^>>?\s*"\$SB_WORK\//.test(rest)) continue;
      sites++;
      const text = ws.map(literal).join(" ")
        .replace(/%[-0-9.]*[sd]/g, " ")
        .replace(/(^|[^\w-])--?[a-z][\w-]*/g, " ")
        .replace(/\b[A-Z][A-Z0-9]*(_[A-Z0-9]+)+\b/g, " "); // variable names such as STABLE_BUILD_LANG
      for (const w of text.match(/[A-Za-zÀ-ÿ]{2,}/g) || []) {
        if (!ALLOWED_WORDS.has(w.toLowerCase())) {
          const lineNo = CODE.slice(0, m.index + m[1].length).split("\n").length;
          bad.push(`install.sh:${lineNo}: ${m[2]} prints "${w}"`);
        }
      }
    }
    assert.ok(sites > 40, `output call sites found: ${sites}`);
    assert.deepEqual(bad, []);
  });

  test("no heredoc prints text (the only one is the node helper's source)", () => {
    const heredocs = CODE.match(/<<-?\s*['"]?\w+/g) || [];
    assert.deepEqual(heredocs, ["<<'JS_EOF"]);
    assert.match(LINES[HELPER_START], /^ {2}read -r -d '' HELPER_JS <<'JS_EOF' \|\| true$/);
  });

  test("the node helper writes nothing to stderr but an internal-error line", () => {
    const writes = HELPER_JS.match(/(process\.stderr\.write|console\.\w+)\([^)]*\)/g) || [];
    assert.deepEqual(writes, ["process.stderr.write('helper: unknown op ' + op + '\\n')"]);
  });

  test("the helper messages print through msg (the output helpers are thin wrappers)", () => {
    for (const fn of ["say_t", "err_t", "warn_t", "die_t", "section"]) {
      assert.match(CODE, new RegExp(`\\n {2}${fn}\\(\\) \\{[^\\n]*\\bmsg "\\$@"`), fn);
    }
  });
});

// ---------------------------------------------------------------- cheap runs
describe("runs (help and language errors only)", () => {
  const tmpRoots = [];
  after(() => { for (const d of tmpRoots) rmSync(d, { recursive: true, force: true }); });
  // `prep(home)` may seed files in the temporary HOME first; `args` may then be a function of it.
  function run(args, env = {}, prep) {
    const home = mkdtempSync(path.join(os.tmpdir(), "sb-i18n-"));
    tmpRoots.push(home);
    if (prep) prep(home);
    const argv = typeof args === "function" ? args(home) : args;
    const r = spawnSync("/usr/bin/env", ["-i", `HOME=${home}`, "PATH=/usr/bin:/bin", "STABLE_BUILD_NO_TTY=1",
      ...Object.entries(env).map(([k, v]) => `${k}=${v}`), BASH, INSTALL, ...argv], { encoding: "utf8" });
    return { ...r, home, files: readdirSync(home) };
  }
  /** Writes <dir>/.stable-build/config.json with this language. */
  const saveLang = (dir, language) => {
    mkdirSync(path.join(dir, ".stable-build"), { recursive: true });
    writeFileSync(path.join(dir, ".stable-build", "config.json"), `${JSON.stringify({ schemaVersion: 1, language }, null, 2)}\n`);
  };
  const PT_HELP = /^instalador stable-build .*\n[\s\S]*Uso: install\.sh \[opções\]/;
  const EN_HELP = /^stable-build installer .*\n[\s\S]*Usage: install\.sh \[options\]/;

  test("--help is English by default, even with a pt locale, and Portuguese only with --lang or STABLE_BUILD_LANG", () => {
    for (const env of [{ LANG: "C" }, {}, { LANG: "pt_BR.UTF-8" }, { LC_ALL: "pt_BR.UTF-8", LANG: "en_US.UTF-8" }, { LC_MESSAGES: "pt_BR.UTF-8" }]) {
      const en = run(["--help"], env);
      assert.equal(en.status, 0, JSON.stringify(env));
      assert.match(en.stdout, EN_HELP, `the locale switched --help: ${JSON.stringify(env)}`);
    }
    for (const [args, env] of [
      [["--lang=pt-BR", "--help"], { LANG: "C" }],
      [["--help", "--lang", "pt"], {}],
      [["--help"], { STABLE_BUILD_LANG: "Português" }],
    ]) {
      const r = run(args, env);
      assert.equal(r.status, 0, `${args} ${JSON.stringify(env)}`);
      assert.match(r.stdout, PT_HELP, `${args} ${JSON.stringify(env)}`);
    }
    // --lang wins over STABLE_BUILD_LANG
    assert.match(run(["--help", "--lang=en"], { STABLE_BUILD_LANG: "pt-BR", LANG: "pt_BR.UTF-8" }).stdout, /Usage: install\.sh/);
  });

  test("an unknown language exits 1 with a bilingual error and writes nothing", () => {
    for (const [args, env, re] of [
      [["--lang=fr"], {}, /unknown language 'fr'[\s\S]*idioma desconhecido 'fr'/],
      [["--lang", "klingon", "--help"], {}, /unknown language 'klingon'[\s\S]*idioma desconhecido 'klingon'/],
      [["--lang"], {}, /--lang needs a value[\s\S]*--lang precisa de um valor/],
      [["--lang="], {}, /--lang needs a value[\s\S]*--lang precisa de um valor/],
      [[], { STABLE_BUILD_LANG: "de" }, /STABLE_BUILD_LANG=de is not a supported language[\s\S]*STABLE_BUILD_LANG=de não é um idioma suportado/],
    ]) {
      const r = run(args, env);
      assert.equal(r.status, 1, `${args} ${JSON.stringify(env)}`);
      assert.match(r.stderr, re);
      assert.equal(r.stdout, "");
      assert.deepEqual(r.files, []);
    }
  });

  test("--help follows the language saved under --prefix, before or after it, and ignores what follows it", () => {
    const pfx = (home) => path.join(home, "sandbox");
    const seed = (home) => { saveLang(home, "en"); saveLang(pfx(home), "pt-BR"); };
    for (const args of [
      (h) => ["--help", `--prefix=${pfx(h)}`],
      (h) => [`--prefix=${pfx(h)}`, "--help"],
      (h) => ["--help", "--prefix", pfx(h)],
      (h) => ["-h", "--prefix", pfx(h), "--bogus"],
      (h) => ["--help", "--bogus", `--prefix=${pfx(h)}`, "--ref"],
    ]) {
      const r = run(args, { LANG: "C" }, seed);
      const shown = JSON.stringify(args("HOME"));
      assert.equal(r.status, 0, `${shown}: ${r.stderr}`);
      assert.equal(r.stderr, "", shown);
      assert.match(r.stdout, PT_HELP, `${shown}: the language saved in the --prefix sandbox, not HOME's`);
    }
    // nothing saved under --prefix: HOME's choice is not used for the sandbox, the locale decides
    const bare = run((h) => ["--help", `--prefix=${path.join(h, "empty")}`], { LANG: "C" }, (h) => saveLang(h, "pt-BR"));
    assert.equal(bare.status, 0);
    assert.match(bare.stdout, EN_HELP);
    assert.equal(existsSync(path.join(bare.home, "empty")), false, "--help creates no --prefix directory");
    // --help with --prefix and no value still prints the help (the saved language of HOME)
    const noValue = run(["--help", "--prefix"], { LANG: "C" }, (h) => saveLang(h, "pt-BR"));
    assert.equal(noValue.status, 0);
    assert.match(noValue.stdout, PT_HELP);
    // --lang and STABLE_BUILD_LANG still beat the saved choice
    assert.match(run((h) => ["--help", `--prefix=${pfx(h)}`, "--lang=en"], {}, seed).stdout, EN_HELP);
    assert.match(run((h) => ["--help", `--prefix=${pfx(h)}`], { STABLE_BUILD_LANG: "en" }, seed).stdout, EN_HELP);
  });

  test("an unknown option before --help is an error in the saved language; spaces around the saved value are ignored", () => {
    const r = run((h) => ["--bogus", "--help", `--prefix=${path.join(h, "sandbox")}`], { LANG: "C" }, (h) => saveLang(path.join(h, "sandbox"), "pt-BR"));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^stable-build: opção desconhecida: --bogus\n\ninstalador stable-build/);
    assert.equal(r.stdout, "");
    for (const language of [" pt-BR ", "\tportuguês\n", " PT_br"]) {
      const h = run(["--help"], { LANG: "C" }, (home) => saveLang(home, language));
      assert.equal(h.status, 0, JSON.stringify(language));
      assert.match(h.stdout, PT_HELP, JSON.stringify(language));
    }
    // the same spellings as --lang and STABLE_BUILD_LANG
    assert.match(run(["--help", "--lang", " pt-BR "], { LANG: "C" }).stdout, PT_HELP);
    assert.match(run(["--help"], { LANG: "C", STABLE_BUILD_LANG: " pt " }).stdout, PT_HELP);
  });

  test("an unknown option is reported in the chosen language", () => {
    const en = run(["--bogus"], { LANG: "C" });
    assert.equal(en.status, 1);
    assert.match(en.stderr, /^stable-build: unknown option: --bogus\n\nstable-build installer/);
    const pt = run(["--bogus", "--lang=pt-BR"]);
    assert.equal(pt.status, 1);
    assert.match(pt.stderr, /^stable-build: opção desconhecida: --bogus\n\ninstalador stable-build/);
    assert.deepEqual(pt.files, []);
  });
});

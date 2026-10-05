// Landing page (site/) consistency. The page copies the README's commands and options table, the
// rule list from data/gotchas.json and the guard's real output by hand, so these tests fail when one
// of those changes and the page does not. They also check the EN/PT dictionary and the ids the page's
// scripts and ARIA attributes point at. Read-only, except for a temporary project for the guard run.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SITE = join(ROOT, 'site');
const HTML = readFileSync(join(SITE, 'index.html'), 'utf8');
const README = readFileSync(join(ROOT, 'README.md'), 'utf8');
const GOTCHAS = JSON.parse(readFileSync(join(ROOT, 'plugins/stable-build/data/gotchas.json'), 'utf8'));
const guard = await import(pathToFileURL(join(ROOT, 'plugins/stable-build/scripts/guard.mjs')).href);

/** window.SB_PT from site/assets/pt.js, evaluated in a sandbox. */
function loadPt() {
  const sandbox = { window: {} };
  vm.runInNewContext(readFileSync(join(SITE, 'assets/pt.js'), 'utf8'), sandbox);
  return sandbox.window.SB_PT;
}
const PT = loadPt();

/** Text of an HTML fragment: tags and <wbr> removed, entities decoded. */
const text = (s) => s
  .replace(/<[^>]+>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&nbsp;/g, '\u00a0').replace(/&amp;/g, '&');

/** Inner HTML of the element with this id (its content up to the matching close of the same tag). */
function innerById(id) {
  const open = new RegExp(`<([a-z0-9]+)[^>]*\\bid="${id}"[^>]*>`).exec(HTML);
  assert.ok(open, `no element with id="${id}"`);
  const tag = open[1];
  let depth = 1; let i = open.index + open[0].length; const start = i;
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'g');
  re.lastIndex = i;
  for (let m; (m = re.exec(HTML));) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return HTML.slice(start, m.index);
  }
  throw new Error(`unclosed <${tag} id="${id}">`);
}

/** Chunks of a code block split on an opening <span class="CLASS…">, each without its final </span>. */
function spanChunks(inner, cls) {
  return inner.split(new RegExp(`<span class="${cls}(?: [^"]*)?"[^>]*>`)).slice(1).map((c) => {
    const k = c.lastIndexOf('</span>');
    return k === -1 ? c : c.slice(0, k);
  });
}

/** Every command line shown in a command bar: [{ id, line }]. */
function siteCommands() {
  const out = [];
  for (const m of HTML.matchAll(/<pre class="sh[^"]*"[^>]*><code id="([^"]+)">([\s\S]*?)<\/code><\/pre>/g)) {
    for (const chunk of spanChunks(m[2], 'l')) out.push({ id: m[1], line: text(chunk) });
  }
  return out;
}

/** Lines of the README's fenced code blocks, grouped per block. */
function readmeBlocks() {
  const blocks = [];
  let cur = null;
  for (const line of README.split('\n')) {
    if (/^ {0,3}```/.test(line)) { if (cur) { blocks.push(cur); cur = null; } else cur = []; continue; }
    if (cur) cur.push(line.trim());
  }
  return blocks;
}

const tmpRoots = [];
after(() => { for (const d of tmpRoots) rmSync(d, { recursive: true, force: true }); });

/** Runs the guard's hook mode on a Write of `content` to src/history.ts in a fresh Arc project. */
function runGuard(content, language) {
  const home = mkdtempSync(join(tmpdir(), 'sb-site-'));
  tmpRoots.push(home);
  const sbHome = join(home, '.stable-build');
  mkdirSync(sbHome, { recursive: true });
  writeFileSync(join(sbHome, 'config.json'), JSON.stringify({ schemaVersion: 1, guard: true, ...(language ? { language } : {}) }));
  const root = join(home, 'proj');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"name":"demo","private":true}\n');
  writeFileSync(join(root, 'src/history.ts'), content);
  const env = {
    PATH: process.env.PATH, HOME: home, STABLE_BUILD_HOME: sbHome,
    CLAUDE_CONFIG_DIR: join(home, '.claude'), CODEX_HOME: join(home, '.codex'),
  };
  const input = JSON.stringify({
    session_id: 't', cwd: root, hook_event_name: 'PostToolUse', tool_name: 'Write',
    tool_input: { file_path: join(root, 'src/history.ts'), content },
  });
  const r = guard.hookMode(input, env);
  return r.stdout ? JSON.parse(r.stdout) : null;
}

// The demo file as the page shows it in step 1 (an empty line is shown as one space).
const BEFORE_LINES = spanChunks(innerById('code-before'), 'ln').map((c) => (text(c) === ' ' ? '' : text(c)));
const BEFORE = `${BEFORE_LINES.join('\n')}\n`;

describe('site: commands match the README', () => {
  test('every command line on the page is a line of a README code block', () => {
    const lines = new Set(readmeBlocks().flat());
    const cmds = siteCommands();
    assert.ok(cmds.length >= 10, `found only ${cmds.length} command lines`);
    for (const { id, line } of cmds) assert.ok(lines.has(line), `#${id}: "${line}" is not in any README code block`);
  });

  test('every README install block is on the page in full', () => {
    const onPage = new Set(siteCommands().map((c) => c.line));
    const installBlocks = readmeBlocks().filter((b) => b.some((l) => /^(\/plugin install |codex plugin add )/.test(l)));
    assert.ok(installBlocks.length >= 2);
    for (const block of installBlocks) for (const line of block) assert.ok(onPage.has(line), `README line missing on the page: "${line}"`);
  });

  test('a Copy button never mixes a preview with the real install', () => {
    for (const m of HTML.matchAll(/<code id="([^"]+)">([\s\S]*?)<\/code><\/pre>/g)) {
      const lines = spanChunks(m[2], 'l').map(text);
      if (lines.some((l) => /--dry-run/.test(l))) {
        assert.ok(!lines.some((l) => /^bash install\.sh$/.test(l) || /\| bash$/.test(l)), `#${m[1]} copies the preview and the install together`);
      }
      const installs = lines.filter((l) => /install\.sh/.test(l) && !/^curl -fsSLO /.test(l));
      assert.ok(installs.length <= 1, `#${m[1]} copies ${installs.length} alternative install commands as one script`);
    }
  });

  test('slash commands get one Copy each', () => {
    for (const m of HTML.matchAll(/<pre class="sh sh--cc"[^>]*><code id="([^"]+)">([\s\S]*?)<\/code><\/pre>/g)) {
      assert.equal(spanChunks(m[2], 'l').length, 1, `#${m[1]} holds more than one slash command`);
    }
  });

  test('the options table lists exactly the README options', () => {
    const site = [...HTML.matchAll(/<tr><td><code>(--[^<]+)<\/code><\/td>/g)].map((m) => m[1]).sort();
    const readme = [...README.matchAll(/^\| `(--[^`]+)` \|/gm)].map((m) => m[1]).sort();
    assert.ok(site.length >= 10);
    assert.deepEqual(site, readme);
  });
});

describe('site: rule list matches data/gotchas.json', () => {
  const rows = [...HTML.matchAll(/<li><a class="rule-id"[^>]*href="([^"]+)"><code>([a-z0-9-]+)<\/code><\/a>((?:\s*<span class="sev[^"]*"[^>]*>[^<]*<\/span>)+)/g)]
    .map((m) => ({ url: m[1], id: m[2], sev: new Set([...m[3].matchAll(/>([^<]*)</g)].flatMap((x) => x[1].match(/\b(error|warn)\b/g) || [])) }));

  test('same ids, same order', () => {
    assert.deepEqual(rows.map((r) => r.id), GOTCHAS.rules.map((r) => r.id));
  });

  test('each rule links to its evidence page and shows its severities', () => {
    for (const rule of GOTCHAS.rules) {
      const row = rows.find((r) => r.id === rule.id);
      const ev = Array.isArray(rule.evidence) ? rule.evidence[0] : rule.evidence;
      assert.equal(row.url, ev.url, `${rule.id}: link`);
      const sev = new Set([rule.severity, ...Object.values(rule.variants || {}).map((v) => v.severity).filter(Boolean)]);
      assert.deepEqual([...row.sev].sort(), [...sev].sort(), `${rule.id}: severity badges`);
    }
  });
});

describe('site: the guard demo is the guard\'s real output', () => {
  test('step 1 produces exactly the agent context and notices shown', () => {
    const out = runGuard(BEFORE);
    assert.ok(out, 'the guard printed nothing for the step-1 file');
    assert.equal(out.hookSpecificOutput.additionalContext, text(innerById('guard-context')));
    const notice = text(/<p class="notice-text" data-i18n="demo.notice">([\s\S]*?)<\/p>/.exec(HTML)[1]);
    assert.equal(out.systemMessage, notice);
    const pt = runGuard(BEFORE, 'pt-BR');
    assert.equal(pt.systemMessage, text(PT['demo.notice']));
    const quiet = [...HTML.matchAll(/<div class="notice notice--quiet" lang="([^"]+)">[\s\S]*?<p class="notice-text">([\s\S]*?)<\/p>/g)];
    assert.deepEqual(quiet.map((m) => [m[1], text(m[2])]), [['en', out.systemMessage], ['pt-BR', pt.systemMessage]]);
  });

  test('the flagged line is the line the guard reports', () => {
    const reported = Number(/src\/history\.ts:(\d+)/.exec(text(innerById('guard-context')))[1]);
    const classes = [...innerById('code-before').matchAll(/<span class="ln( [^"]*)?">/g)].map((m) => m[1] || '');
    assert.equal(classes.findIndex((c) => /\bis-flag\b/.test(c)) + 1, reported);
  });

  test('step 3 diff applies to step 1 and the result is clean', () => {
    const diff = innerById('code-diff');
    const lines = [...BEFORE_LINES];
    let added = 0;
    for (const m of diff.matchAll(/<span class="ln is-(del|add)" data-ln="(\d+)"><span class="sign">[-+]<\/span>/g)) {
      const rest = diff.slice(m.index + m[0].length);
      const body = text(spanChunks(`<span class="ln">${rest}`, 'ln')[0]);
      const n = Number(m[2]);
      if (m[1] === 'del') assert.equal(body, BEFORE_LINES[n - 1], `diff line ${n} (-) is not step 1's line ${n}`);
      else { lines[n - 1] = body; added++; }
    }
    assert.equal(added, 3);
    assert.equal(runGuard(`${lines.join('\n')}\n`), null, 'the fixed file still has findings');
  });
});

describe('site: language and ids', () => {
  const used = new Set();
  for (const m of HTML.matchAll(/data-i18n="([^"]+)"/g)) used.add(m[1]);
  for (const m of HTML.matchAll(/data-i18n-attr="([^"]+)"/g)) {
    for (const pair of m[1].split(';')) used.add(pair.split(':')[1].trim());
  }

  test('every translatable key has Portuguese copy, and pt.js has no unused key', () => {
    for (const k of used) assert.ok(typeof PT[k] === 'string' && PT[k].trim(), `pt.js is missing "${k}"`);
    const main = readFileSync(join(SITE, 'assets/main.js'), 'utf8');
    const ui = [...main.matchAll(/"(ui\.[a-zA-Z]+)":/g)].map((m) => m[1]);
    for (const k of Object.keys(PT)) {
      assert.ok(used.has(k) || ui.includes(k) || k === 'meta.title', `pt.js key "${k}" is not used by the page`);
    }
    for (const k of ui) assert.ok(PT[k], `pt.js is missing UI string "${k}"`);
  });

  test('ids are unique and every id the page points at exists', () => {
    const ids = [...HTML.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(new Set(ids).size, ids.length, 'duplicate id');
    const refs = [...HTML.matchAll(/\s(?:data-copy|aria-describedby|aria-labelledby)="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/));
    refs.push(...[...HTML.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]));
    for (const r of refs) assert.ok(ids.includes(r), `#${r} does not exist`);
    for (const m of Object.values(PT).join('\n').matchAll(/href=\\?"#([^"\\]+)/g)) assert.ok(ids.includes(m[1]), `pt.js links to missing #${m[1]}`);
  });

  test('every Copy button says which command it copies', () => {
    for (const m of HTML.matchAll(/<button class="copy[^"]*"[^>]*>/g)) {
      assert.match(m[0], /aria-describedby="[^"]+"/, m[0]);
    }
  });
});

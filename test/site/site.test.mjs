// Landing page (site/) consistency. The page copies the README's install command, the role skills,
// a few counts (gates, rules, ideas) and the guard's real output by hand, so these tests fail when one
// of those changes and the page does not. They also check the EN/PT dictionary, the ids the page's
// scripts and ARIA attributes point at, and the Arc brand wording. Read-only, except for a temporary
// project for the guard run.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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

// The file the guard card shows (an empty line is shown as one space).
const GUARD_LINES = spanChunks(innerById('guard-code'), 'ln').map((c) => (text(c) === ' ' ? '' : text(c)));
const GUARD_FILE = `${GUARD_LINES.join('\n')}\n`;

const SKILLS = join(ROOT, 'plugins/stable-build/skills');
const CATALOG = readFileSync(join(SKILLS, 'guide/references/catalog.md'), 'utf8');
/** Skill names in one "## Section" table of the generated catalog. */
function catalogSection(title) {
  const body = CATALOG.split(/^## /m).find((part) => part.startsWith(`${title}\n`)) || '';
  return [...body.matchAll(/^\| `([a-z0-9-]+)` \|/gm)].map((m) => m[1]);
}
const skill = (name) => readFileSync(join(SKILLS, name, 'SKILL.md'), 'utf8');
/** A role skill's persona name, from its "You are <Name>, the <Role>." line. */
const personaName = (name) => /^You are ([A-Z][a-z]+), the /m.exec(skill(name))[1];
/** Visible text of the page between two markers, tags removed and whitespace collapsed. */
const pageText = (from, to) => text(HTML.slice(HTML.indexOf(from), to ? HTML.indexOf(to) : undefined)).replace(/\s+/g, ' ');

describe('site: commands match the README', () => {
  test('every command line on the page is a line of a README code block', () => {
    const lines = new Set(readmeBlocks().flat());
    const cmds = siteCommands();
    assert.ok(cmds.length >= 1, 'no command on the page');
    for (const { id, line } of cmds) assert.ok(lines.has(line), `#${id}: "${line}" is not in any README code block`);
  });

  test('the page shows the README one-line install', () => {
    const oneLiner = readmeBlocks().flat().find((l) => /^curl -fsSL \S+\/install\.sh \| bash$/.test(l));
    assert.ok(oneLiner, 'README has no one-line install');
    assert.ok(siteCommands().some((c) => c.line === oneLiner), 'the one-line install is not on the page');
  });

  test('a Copy button copies exactly one command', () => {
    for (const m of HTML.matchAll(/<code id="([^"]+)">([\s\S]*?)<\/code><\/pre>/g)) {
      assert.equal(spanChunks(m[2], 'l').length, 1, `#${m[1]} copies more than one line`);
    }
  });
});

describe('site: the team and the numbers match the kit', () => {
  test('the team cards are exactly the role skills, each with its persona name and slash command', () => {
    const roles = catalogSection('Roles');
    assert.equal(roles.length, 6);
    const cards = [...HTML.matchAll(/<li class="card[^"]*" data-skill="([^"]+)"[\s\S]*?<\/li>/g)];
    assert.deepEqual(cards.map((m) => m[1]).sort(), [...roles].sort());
    assert.equal(cards[0][1], 'architect', 'the lead card (Tim, architect) comes first');
    assert.match(cards[0][0], /class="card spot card--lead"/);
    for (const m of cards) {
      const name = personaName(m[1]);
      assert.ok(m[0].includes(`<h3>${name}</h3>`), `${m[1]}: card does not show ${name}`);
      assert.ok(m[0].includes(`<code lang="en">/stable-build:${m[1]}</code>`), `${m[1]}: card shows another command`);
      const key = /data-i18n="(team\.[a-z]+)\.q"/.exec(m[0])[1];
      assert.match(text(/<span class="try-q"[^>]*>([^<]*)</.exec(m[0])[1]), new RegExp(`^“${name}, `), `${m[1]}: sample ask (en) does not start with ${name}`);
      assert.match(text(PT[`${key}.q`]), new RegExp(`^“${name}, `), `${m[1]}: sample ask (pt) does not start with ${name}`);
    }
    assert.match(pageText('id="team"', 'id="journey"'), /\bSix specialists\b/);
    assert.match(text(PT['team.lede']), /\bSeis especialistas\b/);
  });

  test('the persona names agree across skills, guide, installer, READMEs and the page', () => {
    const team = catalogSection('Roles').map((skill) => [skill, personaName(skill)]);
    const guide = skill('guide');
    const install = readFileSync(join(ROOT, 'install.sh'), 'utf8');
    const readmePt = readFileSync(join(ROOT, 'README.pt-BR.md'), 'utf8');
    for (const [s, name] of team) {
      assert.match(skill(s), new RegExp(`^description: .*\\b${name} or the stable-build .*"talk to ${name}"`, 'm'), `${s}: description does not trigger on ${name}`);
      assert.ok(guide.includes(`| ${name} | \`${s}\` |`), `guide: no row for ${name}`);
      for (const [file, body] of [['README.md', README], ['README.pt-BR.md', readmePt]]) {
        assert.ok(body.includes(`| \`${s}\` | **${name}.** `), `${file}: ${s} row is not named ${name}`);
      }
      assert.match(install, new RegExp(`fin_next\\) _T="[^\\n]*\\b${name} \\(`), `install.sh fin_next does not list ${name}`);
    }
    const tags = [...innerById('term').matchAll(/<span class="tag[^"]*">([^<]+)<\/span>/g)].map((m) => m[1]);
    const allowed = new Set([...team.map(([, n]) => n), 'guard', 'go-live']);
    for (const t of tags) assert.ok(allowed.has(t), `terminal tag "${t}" is not a persona or a kit tool`);
  });

  test('every persona keeps the tribute rule, and the page says the names are a tribute', () => {
    for (const s of catalogSection('Roles')) {
      assert.match(skill(s), /never claim to be that person, quote them, or speak for them or for Circle\./, `${s}: tribute rule missing`);
    }
    assert.match(pageText('id="team"', 'id="journey"'), /tribute to people from the Arc community[^.]*\. They did not build or endorse this kit/);
    assert.match(text(PT['team.tribute']), /homenagem a pessoas da comunidade da Arc[^.]*\. Elas não construíram nem endossam/);
  });

  test('every /stable-build: command on the page names a real skill', () => {
    const all = `${HTML}\n${Object.values(PT).join('\n')}`;
    for (const m of all.matchAll(/\/stable-build:([a-z0-9-]+)/g)) {
      assert.ok(existsSync(join(SKILLS, m[1], 'SKILL.md')), `/stable-build:${m[1]} is not a skill`);
    }
  });

  test('gates, rules and ideas are counted as the kit counts them', () => {
    const gates = Number(/Run (\d+) gates/.exec(skill('go-live'))[1]);
    const ideas = Number(/The result is (\d+) ranked ideas/.exec(skill('find-idea'))[1]);
    const rules = GOTCHAS.rules.length;
    const en = text(HTML);
    const pt = text(Object.values(PT).join('\n'));
    for (const n of en.matchAll(/(\d+) gates/g)) assert.equal(Number(n[1]), gates, 'go-live gates (en)');
    for (const n of pt.matchAll(/(\d+) gates/g)) assert.equal(Number(n[1]), gates, 'go-live gates (pt)');
    for (const n of en.matchAll(/(\d+) ranked ideas/g)) assert.equal(Number(n[1]), ideas, 'find-idea ideas (en)');
    for (const n of pt.matchAll(/(\d+) ideias ranqueadas/g)) assert.equal(Number(n[1]), ideas, 'find-idea ideas (pt)');
    assert.equal(Number(/for (\d+) Arc mistakes/.exec(en)[1]), rules, 'guard rules (en)');
    assert.equal(Number(/busca de (\d+) erros/.exec(pt)[1]), rules, 'guard rules (pt)');
  });
});

describe('site: the guard card is the guard\'s real output', () => {
  test('the file shown produces exactly the notice shown, in both languages', () => {
    const out = runGuard(GUARD_FILE);
    assert.ok(out, 'the guard printed nothing for the file on the card');
    assert.equal(out.systemMessage, text(innerById('guard-notice')));
    assert.equal(runGuard(GUARD_FILE, 'pt-BR').systemMessage, text(PT['native.guard.notice']));
  });

  test('the flagged line is the line the guard reports', () => {
    const ctx = runGuard(GUARD_FILE).hookSpecificOutput.additionalContext;
    const reported = Number(/src\/history\.ts:(\d+)/.exec(ctx)[1]);
    const classes = [...innerById('guard-code').matchAll(/<span class="ln( [^"]*)?">/g)].map((m) => m[1] || '');
    assert.equal(classes.findIndex((c) => /\bis-flag\b/.test(c)) + 1, reported);
  });
});

describe('site: language and ids', () => {
  const used = new Set();
  for (const m of HTML.matchAll(/data-i18n="([^"]+)"/g)) used.add(m[1]);
  for (const m of HTML.matchAll(/data-i18n-attr="([^"]+)"/g)) {
    for (const pair of m[1].split(';')) used.add(pair.split(':')[1].trim());
  }

  test('English is the default: the page never follows the browser language', () => {
    assert.match(HTML, /^<!doctype html>\n<html lang="en"/);
    for (const f of ['assets/boot.js', 'assets/main.js']) {
      assert.doesNotMatch(readFileSync(join(SITE, f), 'utf8'), /navigator\.languages?\b/, `${f} reads the browser language`);
    }
  });

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
    const buttons = [...HTML.matchAll(/<button[^>]*\bclass="copy[^"]*"[^>]*>/g)];
    assert.ok(buttons.length >= 1);
    for (const m of buttons) assert.match(m[0], /aria-describedby="[^"]+"/, m[0]);
  });
});

describe('site: Arc brand wording (Arc partner toolkit)', () => {
  const en = text(HTML.slice(HTML.indexOf('<body>')));
  const pt = text(Object.values(PT).join('\n'));

  test('Arc is never possessive or plural', () => {
    for (const [lang, s] of [['en', en], ['pt', pt]]) {
      assert.doesNotMatch(s, /\bArc['’]s\b|\bArcs\b/, `${lang}: "Arc's" or "Arcs"`);
    }
  });

  test('the first mention in the content is "Arc Network", in both languages', () => {
    const main = pageText('<main', '</main>');
    assert.equal(/\bArc\b/.exec(main).index, /\bArc Network\b/.exec(main).index, 'the first "Arc" in <main> is not "Arc Network"');
    assert.match(text(PT['hero.eyebrow']), /\bArc Network\b/);
  });

  test('the footer carries the affiliation note and the trademark line', () => {
    assert.match(en, /not affiliated with Circle/);
    assert.match(en, /Arc is a trademark of Circle Internet Group, Inc\. and\/or its affiliates\./);
    assert.match(pt, /sem afiliação com a Circle/);
  });

  test('no hype, partnership or yield wording', () => {
    // "first" and "best" only as claims ("the first", "the best"); "testnet first" is fine.
    const banned = /\b(the (first|best|only)|first-ever|best-in-class|o primeiro|a primeira|o melhor|a melhor|official|partner(ship)?|yield|APR|ROI|returns?|guaranteed|oficial|parceria|rendimento|rentabilidade|lucro|garantid[oa]|sem risco)\b/i;
    for (const [lang, s] of [['en', en], ['pt', pt]]) {
      const hit = banned.exec(s);
      assert.equal(hit, null, `${lang}: "${hit && hit[0]}"`);
    }
  });
});

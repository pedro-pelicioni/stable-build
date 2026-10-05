// Skill frontmatter and reference checks, plus unit tests for the governance tools.
//
//   - every plugins/*/skills/<dir>/SKILL.md has frontmatter with exactly `name` and `description`
//   - name: kebab-case, <= 64 chars, equal to <dir>
//   - description: non-empty, <= 1024 chars
//   - every relative file reference in the skill's Markdown exists
//
// Run: node --test "test/**/*.test.mjs"

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  findSkills, parseFrontmatter, brandViolations, builtinCollision, runChecks, walk,
} from '../../tools/check-names.mjs';
import { buildCatalog } from '../../tools/build-catalog.mjs';
import {
  normalizeText, quoteFound, markdownUrl, skipReason, hintReason, extractUrls, collectEvidence,
} from '../../tools/check-links.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOOLS = join(ROOT, 'tools');
const ALLOWED_KEYS = ['name', 'description'];

// ---------------------------------------------------------------------------
// Relative reference extraction
// ---------------------------------------------------------------------------

// Skill-local folders whose paths are checked when they appear in backticks.
const LOCAL_PREFIX = /^(?:\.\/)?(?:references|assets|templates|prompts|steps|workflows)\//;
const PLACEHOLDER = /[{}$<>*]|\.\.\.|…/;

/** Relative references in a Markdown file: [text](target) links and `path` tokens. */
export function relativeRefs(markdown) {
  const refs = [];
  const lines = markdown.split('\n');
  let inFence = false;
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return; }
    for (const m of line.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
      const target = m[1];
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#') || target.startsWith('/') || PLACEHOLDER.test(target)) continue;
      refs.push({ ref: target, line: i + 1, kind: 'link' });
    }
    if (inFence) return;
    for (const m of line.matchAll(/`([^`\s]+)`/g)) {
      let token = m[1].replace(/[.,;:)]+$/, '');
      if (PLACEHOLDER.test(token) || /^[a-z][a-z0-9+.-]*:/i.test(token)) continue;
      const explicitSibling = /^\.\/[A-Za-z0-9_.-]+\.md$/.test(token);
      const upward = token.startsWith('../');
      if (!(LOCAL_PREFIX.test(token) || explicitSibling || upward)) continue;
      refs.push({ ref: token, line: i + 1, kind: 'path' });
    }
  });
  return refs;
}

function resolveRef(ref, fileDir, skillDir, pluginDir) {
  const clean = decodeURIComponent(ref.split('#')[0].split('?')[0]).replace(/\/+$/, '');
  if (!clean) return true; // pure anchor
  return [fileDir, skillDir, pluginDir].some((base) => existsSync(resolve(base, clean)));
}

function skillMarkdownFiles(skillDir) {
  return walk(skillDir).filter((f) => {
    if (!/\.md$/i.test(f)) return false;
    const rel = relative(skillDir, f).split(sep);
    return rel[0] !== 'templates'; // template files describe the generated project, not this skill
  });
}

// ---------------------------------------------------------------------------
// The real skills in this repo
// ---------------------------------------------------------------------------

const skills = findSkills(ROOT);

describe('skills in this repo', () => {
  test('at least one skill exists', () => {
    assert.ok(skills.length > 0, 'no plugins/*/skills/<dir>/SKILL.md found');
  });

  for (const s of skills) {
    const label = `${s.plugin}/${s.dirName}`;
    describe(label, () => {
      const { data, keys, errors, body } = s.fm;

      test('frontmatter parses', () => {
        assert.deepEqual(errors, [], `frontmatter problems in ${relative(ROOT, s.file)}`);
      });

      test('frontmatter has only name and description', () => {
        const extra = keys.filter((k) => !ALLOWED_KEYS.includes(k));
        assert.deepEqual(extra, [], `unexpected keys: ${extra.join(', ')}`);
        for (const k of ALLOWED_KEYS) assert.ok(keys.includes(k), `missing "${k}"`);
      });

      test('name is kebab-case, <= 64 chars and equals the folder', () => {
        const name = data.name;
        assert.equal(typeof name, 'string');
        assert.ok(name.length <= 64, `name is ${name.length} chars`);
        assert.match(name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
        assert.equal(name, s.dirName, 'name must equal the skill folder name');
      });

      test('description is non-empty and <= 1024 chars', () => {
        const d = String(data.description ?? '').trim();
        assert.ok(d.length > 0, 'description is empty');
        assert.ok(d.length <= 1024, `description is ${d.length} chars`);
      });

      test('body is not empty', () => {
        assert.ok(body.trim().length > 0, 'SKILL.md has no body');
        const lines = body.split('\n').length;
        if (lines > 500) test.diagnostic?.(`${label}: SKILL.md body is ${lines} lines; the Agent Skills spec suggests < 500`);
      });

      test('every relative reference exists', () => {
        const missing = [];
        const pluginDir = dirname(dirname(s.dir));
        for (const f of skillMarkdownFiles(s.dir)) {
          for (const r of relativeRefs(readFileSync(f, 'utf8'))) {
            if (!resolveRef(r.ref, dirname(f), s.dir, pluginDir)) missing.push(`${relative(ROOT, f)}:${r.line} -> ${r.ref}`);
          }
        }
        assert.deepEqual(missing, [], `missing references:\n  ${missing.join('\n  ')}`);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// Unit tests: frontmatter parser
// ---------------------------------------------------------------------------

describe('parseFrontmatter', () => {
  test('plain, quoted and folded values', () => {
    const fm = parseFrontmatter([
      '---',
      'name: go-live',
      'description: >-',
      '  Testnet-to-mainnet checklist',
      '  for apps built on Arc.',
      '---',
      '# Body',
    ].join('\n'));
    assert.deepEqual(fm.errors, []);
    assert.equal(fm.data.name, 'go-live');
    assert.equal(fm.data.description, 'Testnet-to-mainnet checklist for apps built on Arc.');
    assert.equal(fm.body.trim(), '# Body');
    assert.equal(parseFrontmatter('---\nname: "a-b"\ndescription: \'it\'\'s\'\n---\n').data.description, "it's");
    assert.equal(parseFrontmatter('---\nname: x\ndescription: |\n  line1\n  line2\n---\n').data.description, 'line1\nline2\n');
    assert.equal(parseFrontmatter('---\nname: x\ndescription: one\n  two\n---\n').data.description, 'one two');
  });

  test('rejects what strict YAML parsers reject', () => {
    assert.match(parseFrontmatter('---\nname: x\ndescription: Use when: the user asks\n---\n').errors.join(), /contains ": "/);
    assert.match(parseFrontmatter('---\nname: x\nname: y\n---\n').errors.join(), /duplicate key/);
    assert.match(parseFrontmatter('# no frontmatter').errors.join(), /does not start/);
    assert.match(parseFrontmatter('---\nname: x\n').errors.join(), /not closed/);
    assert.match(parseFrontmatter('---\nname: "x\n---\n').errors.join(), /unterminated/);
  });

  test('CRLF and BOM are tolerated', () => {
    const fm = parseFrontmatter('﻿---\r\nname: a\r\ndescription: b\r\n---\r\nbody');
    assert.deepEqual(fm.errors, []);
    assert.equal(fm.data.description, 'b');
  });
});

describe('relativeRefs', () => {
  test('finds links and skill-local paths, skips URLs and placeholders', () => {
    const md = [
      'See [checklist](references/checklist.md) and `references/catalog.md`.',
      'Copy `templates/payouts/` then read [docs](https://docs.arc.io/x) and [top](#top).',
      'Data: `../../data/gotchas.json`; sibling `./write-document.md`.',
      'Ignore `docs/plan/prd.md`, `src/core/csv.ts`, `${CLAUDE_PLUGIN_ROOT}/scripts/guard.mjs`, `references/*.md`.',
      '```',
      '`references/in-fence.md`',
      '```',
    ].join('\n');
    assert.deepEqual(relativeRefs(md).map((r) => r.ref), [
      'references/checklist.md', 'references/catalog.md', 'templates/payouts/',
      '../../data/gotchas.json', './write-document.md',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Unit tests: name policy (tools/check-names.mjs)
// ---------------------------------------------------------------------------

describe('brand and built-in name policy', () => {
  test('flags arc, bmad and circle tokens but not English words', () => {
    for (const bad of ['arc-tools', 'arc', 'arckit', 'stable-arc', 'arc2-helper', 'bmad-agent-pm', 'my_BMAD', 'circle-helper']) {
      assert.ok(brandViolations(bad).length > 0, `${bad} should be flagged`);
    }
    for (const ok of ['stable-build', 'stable-build-mcp', 'architect', 'architecture', 'search', 'archive', 'go-live', 'layered-review']) {
      assert.deepEqual(brandViolations(ok), [], `${ok} should pass`);
    }
  });

  test('flags built-in command names and peer skills', () => {
    for (const n of ['help', 'new', 'clear', 'review', 'code-review', 'init', 'use-arc']) assert.ok(builtinCollision(n).length > 0, n);
    for (const n of ['guide', 'new-app', 'gotchas', 'layered-review', 'find-idea']) assert.deepEqual(builtinCollision(n), [], n);
  });
});

function writeJson(file, obj) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(obj, null, 2)); }
function writeText(file, text) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); }

/** Minimal two-host marketplace with one plugin and one skill. */
function makeFixture({ plugin = 'demo-kit', skill = 'guide', skillDir = skill, version = '1.0.0', codexVersion = version, body = 'Body.' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sb-names-'));
  writeJson(join(root, '.claude-plugin/marketplace.json'), {
    name: 'demo-market', owner: { name: 't' }, description: 'd',
    plugins: [{ name: plugin, source: `./plugins/${plugin}`, description: 'd' }],
  });
  writeJson(join(root, '.agents/plugins/marketplace.json'), {
    name: 'demo-market',
    plugins: [{ name: plugin, source: { source: 'local', path: `./plugins/${plugin}` }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Coding' }],
  });
  writeJson(join(root, `plugins/${plugin}/.claude-plugin/plugin.json`), { name: plugin, version, description: 'd', license: 'MIT' });
  writeJson(join(root, `plugins/${plugin}/.codex-plugin/plugin.json`), { name: plugin, version: codexVersion, description: 'd', skills: './skills/' });
  writeText(join(root, `plugins/${plugin}/skills/${skillDir}/SKILL.md`), `---\nname: ${skill}\ndescription: Demo skill.\n---\n${body}\n`);
  return root;
}

function runNames(root, ...extra) {
  return spawnSync(process.execPath, [join(TOOLS, 'check-names.mjs'), '--root', root, ...extra], { encoding: 'utf8' });
}

describe('tools/check-names.mjs', () => {
  test('a clean fixture passes', () => {
    const root = makeFixture();
    try {
      const r = runNames(root);
      assert.equal(r.status, 0, r.stdout + r.stderr);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a planted plugin named arc-tools fails', () => {
    const root = makeFixture({ plugin: 'arc-tools' });
    try {
      const r = runNames(root);
      assert.equal(r.status, 1, r.stdout);
      assert.match(r.stdout, /arc-tools/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('skill problems fail: built-in name, name != folder, bmad name', () => {
    const cases = [
      [{ skill: 'help' }, /collides with a Claude Code built-in/],
      [{ skill: 'guide', skillDir: 'router' }, /must equal its folder "router"/],
      [{ skill: 'bmad-agent-pm' }, /contains "bmad"/],
    ];
    for (const [opts, re] of cases) {
      const root = makeFixture(opts);
      try {
        const res = runChecks({ root });
        assert.ok(res.errors.some((e) => re.test(e.message)), `${JSON.stringify(opts)}: ${JSON.stringify(res.errors)}`);
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
  });

  test('upstream runtime leftovers fail, attribution header lines do not', () => {
    const root = makeFixture({ body: 'Run `uv run _bmad/scripts/x.py`.' });
    try {
      const res = runChecks({ root });
      assert.ok(res.errors.some((e) => /"_bmad"/.test(e.message)));
      assert.ok(res.errors.some((e) => /"uv run"/.test(e.message)));
    } finally { rmSync(root, { recursive: true, force: true }); }
    const ok = makeFixture({ body: '<!-- Adapted from BMad Method v6.12.1 src/bmm-skills/agents/bmad-agent-pm. MIT; see THIRD_PARTY_NOTICES.md. -->' });
    try { assert.deepEqual(runChecks({ root: ok }).errors, []); } finally { rmSync(ok, { recursive: true, force: true }); }
  });

  test('UPSTREAM.md rows need the attribution header unless marked original', () => {
    const root = makeFixture({ skill: 'pm' });
    try {
      writeText(join(root, 'plugins/demo-kit/skills/UPSTREAM.md'), '| `pm/SKILL.md` | `src/bmm-skills/agents/bmad-agent-pm/SKILL.md` |\n');
      assert.ok(runChecks({ root }).errors.some((e) => /Adapted from BMad Method/.test(e.message)));
      writeText(join(root, 'plugins/demo-kit/skills/UPSTREAM.md'), '| `pm/SKILL.md` | original stable-build text |\n');
      assert.deepEqual(runChecks({ root }).errors, []);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('versions must agree across manifests and match the release tag', () => {
    const root = makeFixture({ codexVersion: '1.0.1' });
    try {
      assert.ok(runChecks({ root }).errors.some((e) => /versions differ/.test(e.message)));
    } finally { rmSync(root, { recursive: true, force: true }); }
    const ok = makeFixture();
    try {
      writeText(join(ok, 'CHANGELOG.md'), '# Changelog\n\n## [1.0.0] - 2026-10-04\n');
      assert.deepEqual(runChecks({ root: ok, releaseTag: 'v1.0.0' }).errors, []);
      assert.ok(runChecks({ root: ok, releaseTag: 'v1.0.1' }).errors.some((e) => /does not match/.test(e.message)));
    } finally { rmSync(ok, { recursive: true, force: true }); }
  });

  test('hooks.json must stay portable to Codex', () => {
    const root = makeFixture();
    try {
      const hooks = join(root, 'plugins/demo-kit/hooks/hooks.json');
      writeJson(hooks, { hooks: { PostToolUse: [{ matcher: 'Edit|Write|apply_patch', hooks: [{ type: 'command', command: 'sh "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" guard', timeout: 15 }] }] } });
      assert.deepEqual(runChecks({ root }).errors, []);
      writeJson(hooks, { extra: true, hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'sh ${CLAUDE_PLUGIN_ROOT}/x.sh', args: ['a'] }] }] } });
      const msgs = runChecks({ root }).errors.map((e) => e.message).join('\n');
      assert.match(msgs, /top-level key "extra"/);
      assert.match(msgs, /handler key "args"/);
      assert.match(msgs, /quote/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('MCP entries need a transport type', () => {
    const root = makeFixture();
    try {
      writeJson(join(root, 'plugins/demo-kit/.mcp.json'), { mcpServers: { docs: { url: 'https://docs.example.org/mcp' } } });
      assert.ok(runChecks({ root }).errors.some((e) => /no "type"/.test(e.message)));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a stray SKILL.md inside a template fails (Codex would load it)', () => {
    const root = makeFixture();
    try {
      writeText(join(root, 'plugins/demo-kit/skills/guide/templates/app/SKILL.md'), '---\nname: app\ndescription: x\n---\n');
      assert.ok(runChecks({ root }).errors.some((e) => /nested SKILL.md/.test(e.message)));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

// ---------------------------------------------------------------------------
// Unit tests: catalog generator (tools/build-catalog.mjs)
// ---------------------------------------------------------------------------

describe('tools/build-catalog.mjs', () => {
  test('lists every skill from frontmatter, deterministically', () => {
    const root = makeFixture({ plugin: 'stable-build', skill: 'guide' });
    try {
      writeText(join(root, 'plugins/stable-build/skills/zz-extra/SKILL.md'), '---\nname: zz-extra\ndescription: "Pipes | are escaped."\n---\nBody\n');
      const a = buildCatalog(root);
      assert.equal(a, buildCatalog(root));
      assert.match(a, /\| `guide` \| Demo skill\. \|/);
      assert.match(a, /## Other skills[\s\S]*`zz-extra` \| Pipes \\\| are escaped\./);
      assert.doesNotMatch(a, /\d{4}-\d{2}-\d{2}T/); // no timestamps
      const check = spawnSync(process.execPath, [join(TOOLS, 'build-catalog.mjs'), '--root', root, '--check'], { encoding: 'utf8' });
      assert.equal(check.status, 1, 'missing catalog must fail --check');
      const write = spawnSync(process.execPath, [join(TOOLS, 'build-catalog.mjs'), '--root', root], { encoding: 'utf8' });
      assert.equal(write.status, 0, write.stderr);
      const again = spawnSync(process.execPath, [join(TOOLS, 'build-catalog.mjs'), '--root', root, '--check'], { encoding: 'utf8' });
      assert.equal(again.status, 0, again.stderr);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

// ---------------------------------------------------------------------------
// Unit tests: link and drift helpers (tools/check-links.mjs)
// ---------------------------------------------------------------------------

describe('tools/check-links.mjs helpers', () => {
  test('quotes match through Markdown formatting and line wraps', () => {
    const page = '* **The minimum base fee is 20 Gwei.** Transactions with `maxFeePerGas` lower\n  than 20 Gwei are silently dropped by the mempool.';
    assert.ok(quoteFound('Transactions with maxFeePerGas lower than 20 Gwei are silently dropped by the mempool.', page));
    assert.ok(!quoteFound('The minimum base fee is 1 Gwei.', page));
    assert.equal(normalizeText('“Curly” — [link](https://x.y) <Note>text</Note>'), '"curly" - link text');
  });

  test('markdown twin URLs', () => {
    assert.equal(markdownUrl('https://docs.arc.io/arc/references/evm-differences#gas'), 'https://docs.arc.io/arc/references/evm-differences.md');
    assert.equal(markdownUrl('https://developers.circle.com/cctp/references/stellar.md'), 'https://developers.circle.com/cctp/references/stellar.md');
    assert.equal(markdownUrl('https://github.com/o/r/blob/main/README.md'), 'https://raw.githubusercontent.com/o/r/main/README.md');
  });

  test('URL extraction and skipping', () => {
    const urls = extractUrls('See https://docs.arc.io/ai/mcp. Or (https://faucet.circle.com), "https://a.b/c",').map((u) => u.url);
    assert.deepEqual(urls, ['https://docs.arc.io/ai/mcp', 'https://faucet.circle.com', 'https://a.b/c']);
    assert.equal(skipReason('https://{{HOST}}/x'), 'placeholder');
    assert.equal(skipReason('https://example.com/a'), 'example or reserved host');
    assert.equal(skipReason('http://localhost:5173'), 'local address');
    assert.equal(skipReason('https://github.com/pedro-pelicioni/stable-build/blob/main/README.md'), 'this repo (unpublished)');
    assert.equal(skipReason('https://github.com/pedro-pelicioni/stable-build', { includeSelf: true }), null);
    assert.equal(skipReason('https://docs.arc.io/arc/references/rpc-endpoints'), null);
  });

  test('bare origins in preconnect hints and CSP sources are not fetched; pages are', () => {
    assert.ok(hintReason('https://fonts.gstatic.com', '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'));
    assert.ok(hintReason('https://fonts.googleapis.com', '"value": "default-src \'self\'; style-src \'self\' https://fonts.googleapis.com; font-src https://fonts.gstatic.com"'));
    assert.equal(hintReason('https://fonts.googleapis.com/css2?family=X', '<link rel="preconnect" href="https://fonts.googleapis.com/css2?family=X">'), null);
    assert.equal(hintReason('https://docs.arc.io', 'See https://docs.arc.io for the docs.'), null);
    assert.equal(hintReason('https://docs.arc.io/', '<link rel="preconnect" href="https://docs.arc.io/">'), null);
  });

  test('evidence is found whatever the gotchas.json shape', () => {
    const { items, rulesWithout } = collectEvidence({ rules: [
      { id: 'a', severity: 'error', evidence: { url: 'https://docs.arc.io/x', quote: 'q' } },
      { id: 'b', severity: 'warn', evidence: [{ url: 'https://docs.arc.io/y', quote: 'r' }] },
      { id: 'c', severity: 'warn' },
    ] });
    assert.deepEqual(items.map((i) => i.rule), ['a', 'b']);
    assert.deepEqual(rulesWithout, ['c']);
  });
});

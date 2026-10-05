// Tests for tools/check-docs-sync.mjs: translated docs (README.pt-BR.md and the payouts starter's
// README.pt-BR.md) must mirror their English originals: same heading outline, identical code
// blocks, cross-links at the top, and in-page anchors that resolve.
// Run: node --test test/skills/check-docs-sync.test.mjs
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  PAIRS, REPO_ROOT, TOP_LINES, parseMarkdown, githubSlug, anchorsOf, checkPair, run,
} from '../../tools/check-docs-sync.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOOL = join(ROOT, 'tools', 'check-docs-sync.mjs');
const TMP = mkdtempSync(join(tmpdir(), 'sb-docs-sync-'));
after(() => rmSync(TMP, { recursive: true, force: true }));

const FENCE = '```';
const EN = [
  '# demo',
  '',
  '[Leia em português](README.pt-BR.md)',
  '',
  'Install it with `npm install` and read [Status](#status-and-unverified-items).',
  '',
  '## Install',
  '',
  `${FENCE}sh`,
  'npm install',
  '# ## not a heading inside a fence',
  'npm test',
  FENCE,
  '',
  '### Options',
  '',
  '~~~text',
  '/plugin install demo@demo',
  '~~~',
  '',
  '## Status and UNVERIFIED items',
  '',
  'Done.',
  '',
].join('\n');
const PT = [
  '# demo',
  '',
  '[Read in English](README.md)',
  '',
  'Instale com `npm install` e leia o [Status](#status-e-itens-unverified).',
  '',
  '## Instalação',
  '',
  `${FENCE}sh`,
  'npm install',
  '# ## not a heading inside a fence',
  'npm test',
  FENCE,
  '',
  '### Opções',
  '',
  '~~~text',
  '/plugin install demo@demo',
  '~~~',
  '',
  '## Status e itens UNVERIFIED',
  '',
  'Pronto.',
  '',
].join('\n');
const PAIR = { original: 'README.md', translation: 'README.pt-BR.md', lang: 'pt-BR' };

let n = 0;
/** A temp root holding one pair; returns { root, result }. */
function check(en = EN, pt = PT, opts) {
  const root = join(TMP, `case-${n++}`);
  mkdirSync(root, { recursive: true });
  if (en !== null) writeFileSync(join(root, PAIR.original), en);
  if (pt !== null) writeFileSync(join(root, PAIR.translation), pt);
  return { root, result: checkPair(root, PAIR, opts) };
}
const kinds = (r) => r.failures.map((f) => f.kind).sort();

describe('check-docs-sync: the repo', () => {
  test('every mirrored pair in the repo is in sync (no failures, no warnings)', () => {
    const res = run({ root: REPO_ROOT });
    assert.equal(res.pairs, PAIRS.length);
    assert.deepEqual(res.failures, [], JSON.stringify(res.failures, null, 2));
    assert.deepEqual(res.warnings, [], JSON.stringify(res.warnings, null, 2));
    assert.equal(res.ok, true);
  });

  test('covers the root README and the payouts starter README', () => {
    const originals = PAIRS.map((p) => p.original);
    assert.ok(originals.includes('README.md'));
    assert.ok(originals.includes('plugins/stable-build/skills/new-app/templates/payouts/README.md'));
    for (const p of PAIRS) assert.match(p.translation, /README\.pt-BR\.md$/);
  });

  test('the cross-links say "Leia em português" and "Read in English"', () => {
    for (const p of PAIRS) {
      const en = readFileSync(join(ROOT, p.original), 'utf8').split('\n').slice(0, TOP_LINES).join('\n');
      const pt = readFileSync(join(ROOT, p.translation), 'utf8').split('\n').slice(0, TOP_LINES).join('\n');
      assert.match(en, /\[Leia em português\]\(README\.pt-BR\.md\)/, p.original);
      assert.match(pt, /\[Read in English\]\(README\.md\)/, p.translation);
    }
  });

  test('both READMEs document --lang and STABLE_BUILD_LANG in a Language section', () => {
    for (const [file, heading] of [['README.md', 'Language'], ['README.pt-BR.md', 'Idioma']]) {
      const text = readFileSync(join(ROOT, file), 'utf8');
      const md = parseMarkdown(text);
      const h = md.headings.find((x) => x.text === heading);
      assert.ok(h, `${file} has a "${heading}" heading`);
      const next = md.headings.find((x) => x.line > h.line);
      const section = text.split('\n').slice(h.line, next ? next.line - 1 : undefined).join('\n');
      for (const needle of ['--lang=pt-BR', 'STABLE_BUILD_LANG', 'LC_ALL', 'LC_MESSAGES', 'LANG', '"language"', 'config.json'])
        assert.ok(section.includes(needle), `${file} ${heading} section mentions ${needle}`);
    }
  });
});

describe('check-docs-sync: parsing', () => {
  test('headings outside fences only, with levels; code blocks with info strings', () => {
    const md = parseMarkdown(EN);
    assert.deepEqual(md.headings.map((h) => [h.level, h.text]), [
      [1, 'demo'], [2, 'Install'], [3, 'Options'], [2, 'Status and UNVERIFIED items'],
    ]);
    assert.deepEqual(md.codeBlocks.map((c) => c.info), ['sh', 'text']);
    assert.equal(md.codeBlocks[0].content, 'npm install\n# ## not a heading inside a fence\nnpm test');
    assert.ok(md.inlineCode.has('npm install'));
    assert.deepEqual(md.links.map((l) => l.target), ['README.pt-BR.md', '#status-and-unverified-items']);
  });

  test('a longer fence can hold a shorter one; CRLF is normalised', () => {
    const md = parseMarkdown('````md\r\n```sh\r\nls\r\n```\r\n````\r\n## After\r\n');
    assert.equal(md.codeBlocks.length, 1);
    assert.equal(md.codeBlocks[0].content, '```sh\nls\n```');
    assert.deepEqual(md.headings.map((h) => h.text), ['After']);
  });

  test('links inside inline code are not links', () => {
    const md = parseMarkdown('Use `[x](README.md)` literally, then see [real](other.md).');
    assert.deepEqual(md.links.map((l) => l.target), ['other.md']);
  });

  test('GitHub-style slugs keep accents and number duplicates', () => {
    assert.equal(githubSlug('Status and UNVERIFIED items'), 'status-and-unverified-items');
    assert.equal(githubSlug('3. Codex, with `codex plugin` (UNVERIFIED: not run yet)'), '3-codex-with-codex-plugin-unverified-not-run-yet');
    assert.equal(githubSlug('O que é alterado'), 'o-que-é-alterado');
    assert.equal(githubSlug('Instalação'), 'instalação');
    assert.equal(githubSlug('Deploy no [GitHub Pages](https://pages.github.com)'), 'deploy-no-github-pages');
    const anchors = anchorsOf([{ text: 'Notes' }, { text: 'Notes' }, { text: 'Notes' }]);
    assert.deepEqual([...anchors], ['notes', 'notes-1', 'notes-2']);
  });
});

describe('check-docs-sync: failures', () => {
  test('a well-formed pair passes', () => {
    const { result } = check();
    assert.deepEqual(result.failures, []);
    assert.deepEqual(result.warnings, []);
  });

  test('missing translation or original', () => {
    assert.deepEqual(kinds(check(EN, null).result), ['missing']);
    assert.deepEqual(kinds(check(null, PT).result), ['missing']);
  });

  test('a missing section (different heading count)', () => {
    const pt = PT.replace('### Opções\n\n', '');
    assert.deepEqual(kinds(check(EN, pt).result), ['headings']);
  });

  test('same count but a different heading level', () => {
    const pt = PT.replace('### Opções', '## Opções');
    const r = check(EN, pt).result;
    assert.deepEqual(kinds(r), ['heading-level']);
    assert.match(r.failures[0].note, /level 2.*level 3/);
  });

  test('a changed command inside a code block', () => {
    const pt = PT.replace('npm test', 'npm run test');
    const r = check(EN, pt).result;
    assert.deepEqual(kinds(r), ['code-block']);
    assert.match(r.failures[0].where, /README\.pt-BR\.md:12$/);
  });

  test('a translated comment inside a code block', () => {
    const pt = PT.replace('# ## not a heading inside a fence', '# ## não é um título');
    assert.deepEqual(kinds(check(EN, pt).result), ['code-block']);
  });

  test('a different info string', () => {
    const pt = PT.replace('```sh', '```bash');
    assert.deepEqual(kinds(check(EN, pt).result), ['code-block']);
  });

  test('a missing or extra code block', () => {
    const pt = PT.replace('~~~text\n/plugin install demo@demo\n~~~\n', '');
    assert.deepEqual(kinds(check(EN, pt).result), ['code-blocks']);
    const extra = `${PT}\n${FENCE}sh\nls\n${FENCE}\n`;
    assert.deepEqual(kinds(check(EN, extra).result), ['code-blocks']);
  });

  test('missing cross-link from the original', () => {
    const en = EN.replace('[Leia em português](README.pt-BR.md)', 'Leia em português');
    const r = check(en, PT).result;
    assert.deepEqual(kinds(r), ['cross-link']);
    assert.equal(r.failures[0].where, 'README.md');
  });

  test('missing link back from the translation', () => {
    const pt = PT.replace('[Read in English](README.md)', '[Read in English](https://example.com/README.md)');
    const r = check(EN, pt).result;
    assert.deepEqual(kinds(r), ['cross-link']);
    assert.equal(r.failures[0].where, 'README.pt-BR.md');
  });

  test('a cross-link below the top lines does not count', () => {
    const pad = '\n'.repeat(TOP_LINES);
    const en = EN.replace('[Leia em português](README.pt-BR.md)', `${pad}[Leia em português](README.pt-BR.md)`);
    assert.deepEqual(kinds(check(en, PT).result), ['cross-link']);
  });

  test('./ prefixes and anchors on the cross-link are accepted', () => {
    const en = EN.replace('(README.pt-BR.md)', '(./README.pt-BR.md#demo)');
    assert.deepEqual(check(en, PT).result.failures, []);
  });

  test('an anchor left untranslated breaks', () => {
    const pt = PT.replace('#status-e-itens-unverified', '#status-and-unverified-items');
    const r = check(EN, pt).result;
    assert.deepEqual(kinds(r), ['anchor']);
    assert.equal(r.failures[0].where, 'README.pt-BR.md:5');
  });

  test('inline code missing on one side is a warning, and a failure with --strict', () => {
    const pt = PT.replace('Instale com `npm install` e leia', 'Instale e leia');
    const { root, result } = check(EN, pt);
    assert.deepEqual(result.failures, []);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0].note, /npm install/);
    assert.equal(run({ root, pairs: [PAIR] }).ok, true);
    assert.equal(run({ root, pairs: [PAIR], strict: true }).ok, false);
  });
});

describe('check-docs-sync: CLI', () => {
  function layout(mutate = (s) => s) {
    const root = join(TMP, `cli-${n++}`);
    for (const p of PAIRS) {
      mkdirSync(dirname(join(root, p.original)), { recursive: true });
      writeFileSync(join(root, p.original), EN);
      writeFileSync(join(root, p.translation), mutate(PT));
    }
    return root;
  }
  const cli = (...args) => spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8' });

  test('exit 0 when in sync, 1 when not, with --json output', () => {
    const good = cli('--root', layout());
    assert.equal(good.status, 0, good.stdout + good.stderr);
    assert.match(good.stdout, /2 pair\(s\); 0 failure\(s\), 0 warning\(s\)/);

    const bad = cli(`--root=${layout((s) => s.replace('npm test', 'npm run test'))}`, '--json');
    assert.equal(bad.status, 1);
    const res = JSON.parse(bad.stdout);
    assert.equal(res.ok, false);
    assert.equal(res.failures.length, 2);
    assert.ok(res.failures.every((f) => f.kind === 'code-block'));
  });

  test('--strict turns warnings into a failing exit code', () => {
    const root = layout((s) => s.replace('Instale com `npm install` e leia', 'Instale e leia'));
    assert.equal(cli('--root', root).status, 0);
    assert.equal(cli('--root', root, '--strict').status, 1);
  });

  test('unknown options exit 2', () => {
    const r = cli('--nope');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown or incomplete option --nope/);
    assert.equal(cli('--root').status, 2);
  });

  test('npm run check runs it', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    assert.match(pkg.scripts.check, /node tools\/check-docs-sync\.mjs/);
  });
});

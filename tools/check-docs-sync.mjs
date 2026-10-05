#!/usr/bin/env node
// check-docs-sync.mjs: keeps translated docs in step with their English originals.
//
// For each mirrored pair (English original, translation) it fails (exit 1) when:
//   - either file is missing
//   - the heading outline differs: a different number of headings, or different levels in order
//   - the fenced code blocks differ: count, order, info string or content (commands stay identical)
//   - the original does not link to the translation in its first lines, or the translation
//     does not link back
//   - an in-page anchor link ([text](#slug)) matches no heading of the same file
// It warns (and fails only with --strict) when an inline code span appears in one file of a
// pair but not in the other, which usually means a sentence was added on one side only.
//
// Usage: node tools/check-docs-sync.mjs [--root DIR] [--json] [--strict]
// Exit codes: 0 in sync; 1 out of sync; 2 bad arguments.
//
// Read-only: no network, no writes.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Mirrored pairs, relative to the repo root: [English original, translation]. */
export const PAIRS = [
  { original: 'README.md', translation: 'README.pt-BR.md', lang: 'pt-BR' },
  {
    original: 'plugins/stable-build/skills/new-app/templates/payouts/README.md',
    translation: 'plugins/stable-build/skills/new-app/templates/payouts/README.pt-BR.md',
    lang: 'pt-BR',
  },
];

/** The cross-link must appear within this many lines from the top of each file. */
export const TOP_LINES = 10;

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const LINK = /!?\[((?:[^\][]|\[[^\]]*\])*)\]\(\s*<?([^)\s>]*)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
const INLINE_CODE = /(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g;

/**
 * Splits Markdown into the parts this check compares.
 * Returns { headings: [{level, text, line}], codeBlocks: [{info, content, line}],
 *           links: [{text, target, line}], inlineCode: Set<string> }.
 * Lines are 1-based. Only ATX headings and fenced code blocks are recognised (all our docs use them).
 */
export function parseMarkdown(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const headings = [];
  const codeBlocks = [];
  const prose = []; // [lineNumber, text] outside fences
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fence) {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
      if (close && close[1][0] === fence.char && close[1].length >= fence.len) {
        codeBlocks.push({ info: fence.info, content: fence.body.join('\n'), line: fence.line });
        fence = null;
      } else {
        fence.body.push(line);
      }
      continue;
    }
    const open = line.match(FENCE_OPEN);
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
      fence = { char: open[1][0], len: open[1].length, info: open[2].trim(), body: [], line: i + 1 };
      continue;
    }
    const h = line.match(ATX_HEADING);
    if (h) headings.push({ level: h[1].length, text: (h[2] ?? '').trim(), line: i + 1 });
    prose.push([i + 1, line]);
  }
  // An unclosed fence runs to the end of the file (CommonMark).
  if (fence) codeBlocks.push({ info: fence.info, content: fence.body.join('\n'), line: fence.line, unclosed: true });

  const inlineCode = new Set();
  const links = [];
  for (const [n, line] of prose) {
    for (const m of line.matchAll(INLINE_CODE)) {
      const code = m[2].replace(/\s+/g, ' ').trim();
      if (code) inlineCode.add(code);
    }
    const withoutCode = line.replace(INLINE_CODE, (m) => ' '.repeat(m.length));
    for (const m of withoutCode.matchAll(LINK)) {
      if (m[0].startsWith('!')) continue; // images are not cross-links
      links.push({ text: m[1], target: m[2], line: n });
    }
  }
  return { headings, codeBlocks, links, inlineCode };
}

/** Plain text of a heading as GitHub renders it: code spans, links and emphasis markers removed. */
function headingPlainText(raw) {
  return raw
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/`+/g, '')
    .replace(/(\*+|~~)/g, '');
}

/**
 * GitHub-style heading anchors (github-slugger): lowercase, drop everything that is not a
 * letter, mark, number, connector, hyphen or space (accented letters stay), spaces become
 * hyphens. Duplicates get -1, -2, … via the `seen` map.
 */
export function githubSlug(raw, seen = new Map()) {
  const base = headingPlainText(raw)
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '')
    .replace(/ /g, '-');
  let slug = base;
  while (seen.has(slug)) {
    seen.set(base, seen.get(base) + 1);
    slug = `${base}-${seen.get(base)}`;
  }
  seen.set(slug, 0);
  return slug;
}

export function anchorsOf(headings) {
  const seen = new Map();
  return new Set(headings.map((h) => githubSlug(h.text, seen)));
}

function linksTo(fileAbs, links, targetAbs, maxLine) {
  return links.some((l) => {
    if (l.line > maxLine) return false;
    const t = l.target.split('#')[0].split('?')[0];
    if (!t || /^[a-z][a-z0-9+.-]*:/i.test(t)) return false; // in-page or absolute URL
    let decoded = t;
    try { decoded = decodeURIComponent(t); } catch { /* keep as is */ }
    return resolve(dirname(fileAbs), decoded) === targetAbs;
  });
}

const show = (s, n = 60) => {
  const one = JSON.stringify(s);
  return one.length > n ? `${one.slice(0, n - 1)}…"` : one;
};

/** First differing line of two code blocks, for the message. */
function firstDiff(a, b) {
  const al = a.split('\n'); const bl = b.split('\n');
  for (let i = 0; i < Math.max(al.length, bl.length); i++) {
    if (al[i] !== bl[i]) return { offset: i, a: al[i] ?? '(missing)', b: bl[i] ?? '(missing)' };
  }
  return null;
}

/** Checks one pair. Returns { failures, warnings } with {kind, where, note} items. */
export function checkPair(root, pair, { topLines = TOP_LINES } = {}) {
  const failures = [];
  const warnings = [];
  const origAbs = resolve(root, pair.original);
  const transAbs = resolve(root, pair.translation);
  const O = pair.original; const T = pair.translation;
  for (const [abs, rel] of [[origAbs, O], [transAbs, T]]) {
    if (!existsSync(abs)) failures.push({ kind: 'missing', where: rel, note: `file not found (pair ${O} / ${T})` });
  }
  if (failures.length) return { failures, warnings };

  const o = parseMarkdown(readFileSync(origAbs, 'utf8'));
  const t = parseMarkdown(readFileSync(transAbs, 'utf8'));

  // Headings: same count, same levels in the same order.
  if (o.headings.length !== t.headings.length) {
    failures.push({ kind: 'headings', where: `${T}`, note: `${t.headings.length} heading(s), but ${O} has ${o.headings.length}; mirror every section` });
  } else {
    for (let i = 0; i < o.headings.length; i++) {
      const a = o.headings[i]; const b = t.headings[i];
      if (a.level !== b.level) {
        failures.push({ kind: 'heading-level', where: `${T}:${b.line}`, note: `heading ${i + 1} is level ${b.level} ("${b.text}"), but ${O}:${a.line} is level ${a.level} ("${a.text}")` });
      }
    }
  }

  // Code blocks: identical, in the same order.
  if (o.codeBlocks.length !== t.codeBlocks.length) {
    failures.push({ kind: 'code-blocks', where: `${T}`, note: `${t.codeBlocks.length} code block(s), but ${O} has ${o.codeBlocks.length}; code blocks must be identical` });
  }
  for (let i = 0; i < Math.min(o.codeBlocks.length, t.codeBlocks.length); i++) {
    const a = o.codeBlocks[i]; const b = t.codeBlocks[i];
    if (a.info !== b.info) {
      failures.push({ kind: 'code-block', where: `${T}:${b.line}`, note: `code block ${i + 1} has info string ${show(b.info)}, but ${O}:${a.line} has ${show(a.info)}` });
    } else if (a.content !== b.content) {
      const d = firstDiff(a.content, b.content);
      failures.push({ kind: 'code-block', where: `${T}:${b.line + 1 + d.offset}`, note: `code block ${i + 1} differs from ${O}:${a.line + 1 + d.offset}: ${show(d.b)} vs ${show(d.a)}` });
    }
    if (b.unclosed && !a.unclosed) failures.push({ kind: 'code-block', where: `${T}:${b.line}`, note: `code block ${i + 1} is never closed` });
  }

  // Cross-links near the top of both files.
  if (!linksTo(origAbs, o.links, transAbs, topLines)) {
    failures.push({ kind: 'cross-link', where: O, note: `no link to ${relative(dirname(origAbs), transAbs).split(sep).join('/')} in the first ${topLines} lines` });
  }
  if (!linksTo(transAbs, t.links, origAbs, topLines)) {
    failures.push({ kind: 'cross-link', where: T, note: `no link back to ${relative(dirname(transAbs), origAbs).split(sep).join('/')} in the first ${topLines} lines` });
  }

  // In-page anchors resolve in each file.
  for (const [doc, rel] of [[o, O], [t, T]]) {
    const anchors = anchorsOf(doc.headings);
    for (const l of doc.links) {
      if (!l.target.startsWith('#')) continue;
      let id = l.target.slice(1);
      try { id = decodeURIComponent(id); } catch { /* keep as is */ }
      if (!anchors.has(id.toLowerCase())) {
        failures.push({ kind: 'anchor', where: `${rel}:${l.line}`, note: `link target #${id} matches no heading in this file` });
      }
    }
  }

  // Inline code (commands, flags, paths) should appear on both sides.
  const onlyO = [...o.inlineCode].filter((c) => !t.inlineCode.has(c));
  const onlyT = [...t.inlineCode].filter((c) => !o.inlineCode.has(c));
  const list = (xs) => xs.slice(0, 8).map((x) => show(x, 50)).join(', ') + (xs.length > 8 ? `, … (+${xs.length - 8})` : '');
  if (onlyO.length) warnings.push({ kind: 'inline-code', where: T, note: `missing inline code that ${O} has: ${list(onlyO)}` });
  if (onlyT.length) warnings.push({ kind: 'inline-code', where: T, note: `inline code not in ${O}: ${list(onlyT)}` });

  return { failures, warnings };
}

export function run({ root = REPO_ROOT, pairs = PAIRS, strict = false, topLines = TOP_LINES } = {}) {
  const failures = [];
  const warnings = [];
  for (const pair of pairs) {
    const r = checkPair(root, pair, { topLines });
    failures.push(...r.failures);
    warnings.push(...r.warnings);
  }
  const ok = failures.length === 0 && (!strict || warnings.length === 0);
  return { ok, pairs: pairs.length, failures, warnings };
}

function parseArgs(argv) {
  const o = { root: REPO_ROOT, json: false, strict: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--strict') o.strict = true;
    else if (a === '--root') { if (i + 1 >= argv.length) { o.bad = a; break; } o.root = resolve(argv[++i]); }
    else if (a.startsWith('--root=')) o.root = resolve(a.slice('--root='.length));
    else if (a === '-h' || a === '--help') o.help = true;
    else { o.bad = a; break; }
  }
  return o;
}

export function main(argv) {
  const o = parseArgs(argv);
  if (o.help) { console.log('usage: node tools/check-docs-sync.mjs [--root DIR] [--json] [--strict]'); return 0; }
  if (o.bad) { console.error(`check-docs-sync: unknown or incomplete option ${o.bad}`); return 2; }
  const res = run(o);
  if (o.json) { console.log(JSON.stringify(res, null, 2)); return res.ok ? 0 : 1; }
  for (const w of res.warnings) console.log(`warning  [${w.kind}] ${w.note} (${w.where})`);
  for (const f of res.failures) console.log(`FAIL     [${f.kind}] ${f.note} (${f.where})`);
  console.log(`check-docs-sync: ${res.pairs} pair(s); ${res.failures.length} failure(s), ${res.warnings.length} warning(s)${o.strict ? ' [strict]' : ''}`);
  return res.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (err) { console.error(err); process.exitCode = 2; }
}

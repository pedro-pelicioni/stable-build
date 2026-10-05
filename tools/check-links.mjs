#!/usr/bin/env node
// check-links.mjs: link check and docs-drift alarm for stable-build.
//
// 1. Every http(s) URL in the skills, data, MCP config and landing page (site/) must resolve.
//    Bare origins used only as connection hints (<link rel="preconnect">) or CSP sources are
//    skipped: they name a host, not a page, and often answer 404 at "/".
// 2. Every evidence quote in data/gotchas.json must still appear on its source page.
//    For docs.arc.io and developers.circle.com the page's Markdown twin (<url>.md) is
//    fetched and compared after normalising whitespace and Markdown markup.
//    A missing quote is a drift alarm: the docs changed, so the rule must be re-verified.
//
// Usage:
//   node tools/check-links.mjs [paths...] [--offline] [--corpus FILE] [--strict] [--json]
//                              [--concurrency N] [--timeout MS] [--root DIR] [--include-self]
//
//   --offline       no network: check URL syntax and the evidence structure only
//   --corpus FILE   also look for each evidence quote in local text files (repeatable; e.g. a saved
//                   https://docs.arc.io/llms-full.txt plus a saved Circle docs page); works offline
//   --strict        treat warnings (403/429, third-party data URLs, unchecked quotes) as failures
//   --include-self  also check URLs of this repo (skipped by default until it is published)
//
// Read-only: GET requests, plus a JSON-RPC eth_chainId POST for RPC endpoints. No writes.

import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, relative, resolve, sep, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT, walk } from './check-names.mjs';

export const DEFAULT_PATHS = [
  'plugins/stable-build/skills',
  'plugins/stable-build/data',
  'plugins/stable-build-mcp',
  'site',
];
export const GOTCHAS_REL = 'plugins/stable-build/data/gotchas.json';
// Failures in these files are warnings: they list third-party project sites that come and go.
export const WARN_ONLY_FILES = ['plugins/stable-build/data/ecosystem.json'];
const SELF = /^https?:\/\/(?:github\.com|raw\.githubusercontent\.com|codeload\.github\.com)\/pedro-pelicioni\/stable-build(?:[/?#]|$)/i;
const MD_TWIN_HOSTS = new Set(['docs.arc.io', 'developers.circle.com']);
const TEXT_EXT = /\.(md|mdx|txt|json|jsonc|ya?ml|toml|mjs|cjs|js|jsx|ts|tsx|sh|sol|csv|html|env|example)$/i;
const SKIP_FILES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb']);
const UA = 'stable-build-check-links/1.0 (+https://github.com/pedro-pelicioni/stable-build)';

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

const URL_RE = /https?:\/\/[^\s"'`()[\]|\\]+/g;

export function extractUrls(text) {
  const out = [];
  const lines = String(text).split('\n');
  lines.forEach((line, i) => {
    for (const m of line.matchAll(URL_RE)) {
      let u = m[0];
      // Trim trailing punctuation and Markdown/HTML closers that are not part of the URL.
      while (/[.,;:!?*_~>]$/.test(u)) u = u.slice(0, -1);
      if (u.length > 8) out.push({ url: u, line: i + 1 });
    }
  });
  return out;
}

/** Returns a reason string when the URL should not be fetched, or null. */
export function skipReason(url, { includeSelf = false } = {}) {
  if (/[{}$<>]|\.\.\.|…/.test(url)) return 'placeholder';
  let u;
  try { u = new URL(url); } catch { return null; } // reported as invalid later
  const h = u.hostname.toLowerCase();
  if (!h.includes('.') || h === 'localhost' || /^(127\.|0\.0\.0\.0|10\.|192\.168\.)/.test(h) || h === '[::1]') return 'local address';
  if (/(^|\.)example\.(com|org|net)$/.test(h) || /\.(test|local|invalid|example|localhost)$/.test(h)) return 'example or reserved host';
  if (/OWNER|YOUR[_-]/.test(url)) return 'placeholder';
  if (!includeSelf && SELF.test(url)) return 'this repo (unpublished)';
  return null;
}

const HINT_LINE = /\brel=["']?(?:preconnect|dns-prefetch)\b|\b(?:default|script|style|font|img|connect|media|frame|child|worker|manifest)-src\b/i;

/** Returns a reason when a bare origin (no path, query or fragment) sits in a preconnect hint or a CSP source list. */
export function hintReason(url, lineText) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const bare = u.pathname === '/' && !u.search && !u.hash && !/\/$/.test(url);
  return bare && HINT_LINE.test(String(lineText)) ? 'origin in a preconnect hint or CSP source list' : null;
}

export function collectUrls(root, paths, opts = {}) {
  const found = new Map(); // url -> [{file, line}]
  const skipped = new Map(); // url -> reason
  const invalid = [];
  for (const p of paths) {
    const abs = resolve(root, p);
    if (!existsSync(abs)) continue;
    const files = statSync(abs).isDirectory() ? walk(abs) : [abs];
    for (const f of files) {
      if (!TEXT_EXT.test(f) || SKIP_FILES.has(basename(f))) continue;
      let text;
      try { text = readFileSync(f, 'utf8'); } catch { continue; }
      const relFile = relative(root, f).split(sep).join('/');
      const lines = text.split('\n');
      for (const { url, line } of extractUrls(text)) {
        const why = skipReason(url, opts) || hintReason(url, lines[line - 1]);
        if (why) { skipped.set(url, why); continue; }
        try { new URL(url); } catch { invalid.push({ url, file: relFile, line }); continue; }
        if (!found.has(url)) found.set(url, []);
        found.get(url).push({ file: relFile, line });
      }
    }
  }
  return { found, skipped, invalid };
}

// ---------------------------------------------------------------------------
// Evidence quotes
// ---------------------------------------------------------------------------

/** Find every { url, quote } evidence item in a parsed gotchas.json, whatever its exact shape. */
export function collectEvidence(json) {
  const items = [];
  const rulesWithout = [];
  const visit = (node, path) => {
    if (Array.isArray(node)) { node.forEach((n, i) => visit(n, `${path}[${i}]`)); return; }
    if (!node || typeof node !== 'object') return;
    const isRule = typeof node.id === 'string' && ('severity' in node || 'message' in node);
    if ('evidence' in node) {
      const ev = Array.isArray(node.evidence) ? node.evidence : [node.evidence];
      ev.forEach((e, i) => items.push({
        rule: typeof node.id === 'string' ? node.id : path,
        url: e?.url, quote: e?.quote,
        where: `${path}.evidence${Array.isArray(node.evidence) ? `[${i}]` : ''}`,
      }));
    } else if (isRule) {
      rulesWithout.push(node.id);
    }
    for (const [k, v] of Object.entries(node)) if (k !== 'evidence') visit(v, `${path}.${k}`);
  };
  visit(json, '$');
  return { items, rulesWithout };
}

export function normalizeText(s) {
  return String(s)
    .replace(/\\([\\`*_{}[\]()#+\-.!|<>])/g, '$1') // Markdown escapes
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // links and images -> text
    .replace(/<[^>\n]{1,200}>/g, ' ') // HTML / MDX tags
    .replace(/&nbsp;| /g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/[`*_~]/g, '') // emphasis and code markers
    .replace(/^\s*(?:[>|]|[-+]\s|#{1,6}\s|\d+\.\s)/gm, ' ') // quote, table, list and heading markers
    .replace(/\s*\|\s*/g, ' ') // table cell separators
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function quoteFound(quote, pageText) {
  const q = normalizeText(quote);
  return q.length > 0 && normalizeText(pageText).includes(q);
}

/** URL of the Markdown version of a docs page (Mintlify serves <path>.md), else a raw-file URL. */
export function markdownUrl(url) {
  const u = new URL(url);
  u.hash = '';
  if (MD_TWIN_HOSTS.has(u.hostname)) {
    u.search = '';
    let p = u.pathname.replace(/\/+$/, '');
    if (!p.endsWith('.md')) p = (p || '/index') + '.md';
    u.pathname = p;
    return u.toString();
  }
  const gh = /^\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(u.pathname);
  if (u.hostname === 'github.com' && gh) return `https://raw.githubusercontent.com/${gh[1]}/${gh[2]}/${gh[3]}`;
  return u.toString();
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

async function fetchWithTimeout(url, init, timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(url, { redirect: 'follow', ...init, signal: ctl.signal, headers: { 'user-agent': UA, ...(init?.headers ?? {}) } });
  } finally { clearTimeout(t); }
}

async function jsonRpcAlive(url, timeoutMs) {
  try {
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    }, timeoutMs);
    const body = await res.json().catch(() => null);
    return Boolean(body && body.jsonrpc === '2.0' && ('result' in body || 'error' in body));
  } catch { return false; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** -> { status: 'ok' | 'warn' | 'fail', code, note } */
export async function checkUrl(url, { timeoutMs = 20000, retries = 2 } = {}) {
  let last = { status: 'fail', code: null, note: 'not checked' };
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await sleep(1000 * attempt);
    let res;
    try {
      res = await fetchWithTimeout(url, { method: 'GET', headers: { accept: 'text/html,text/markdown,application/json;q=0.9,*/*;q=0.8' } }, timeoutMs);
      await res.body?.cancel().catch(() => {});
    } catch (err) {
      last = { status: 'fail', code: null, note: err?.name === 'AbortError' ? `timeout after ${timeoutMs} ms` : (err?.cause?.code || err?.message || 'network error') };
      continue;
    }
    const code = res.status;
    if (code < 400) return { status: 'ok', code, note: res.redirected ? `redirected to ${res.url}` : '' };
    if (code === 405) return { status: 'ok', code, note: 'endpoint exists (GET not allowed)' };
    const isJson = (res.headers.get('content-type') || '').includes('json');
    if ((code === 400 || code === 404) && isJson && await jsonRpcAlive(url, timeoutMs)) {
      return { status: 'ok', code, note: 'JSON-RPC endpoint answered eth_chainId' };
    }
    if (code === 401 || code === 403) return { status: 'warn', code, note: 'blocked for automated clients; check by hand' };
    if (code === 429) { last = { status: 'warn', code, note: 'rate limited' }; continue; }
    if (code === 404 || code === 410) return { status: 'fail', code, note: 'not found' };
    last = { status: 'fail', code, note: `HTTP ${code}` };
  }
  return last;
}

async function fetchText(url, timeoutMs) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(1000 * attempt);
    try {
      const res = await fetchWithTimeout(url, { headers: { accept: 'text/markdown,text/plain,*/*;q=0.5' } }, timeoutMs);
      if (res.ok) return { ok: true, text: await res.text() };
      if (res.status === 404 || res.status === 410) return { ok: false, note: `HTTP ${res.status}` };
    } catch { /* retry */ }
  }
  return { ok: false, note: 'could not fetch' };
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  });
  await Promise.all(workers);
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function run(opts) {
  const { root = REPO_ROOT, paths = DEFAULT_PATHS, offline = false, corpus = [], strict = false,
    concurrency = 8, timeoutMs = 20000, includeSelf = false } = opts;
  const failures = []; const warnings = []; const notes = [];

  const { found, skipped, invalid } = collectUrls(root, paths, { includeSelf });
  for (const i of invalid) failures.push({ kind: 'invalid-url', url: i.url, where: `${i.file}:${i.line}`, note: 'not a valid URL' });
  for (const [url, refs] of found) {
    if (url.startsWith('http://')) warnings.push({ kind: 'insecure-url', url, where: refs.map((r) => `${r.file}:${r.line}`).join(', '), note: 'use https' });
  }

  // Evidence structure.
  const gotchasFile = join(root, GOTCHAS_REL);
  let evidence = [];
  if (existsSync(gotchasFile)) {
    let json = null;
    try { json = JSON.parse(readFileSync(gotchasFile, 'utf8')); }
    catch (err) { failures.push({ kind: 'gotchas-json', where: GOTCHAS_REL, note: `invalid JSON: ${err.message}` }); }
    if (json) {
      const { items, rulesWithout } = collectEvidence(json);
      evidence = items;
      for (const id of rulesWithout) failures.push({ kind: 'evidence-missing', where: `${GOTCHAS_REL} rule ${id}`, note: 'rule has no evidence {url, quote}' });
      for (const e of items) {
        const where = `${GOTCHAS_REL} rule ${e.rule}`;
        if (typeof e.url !== 'string' || !/^https:\/\//.test(e.url)) failures.push({ kind: 'evidence-url', where, note: `evidence url must be an https URL, got ${JSON.stringify(e.url)}` });
        else {
          const host = new URL(e.url).hostname;
          if (!['docs.arc.io', 'developers.circle.com'].includes(host)) warnings.push({ kind: 'evidence-host', where, url: e.url, note: 'evidence should cite docs.arc.io or developers.circle.com' });
        }
        if (typeof e.quote !== 'string' || !e.quote.trim()) failures.push({ kind: 'evidence-quote', where, note: 'evidence quote is empty' });
        else if (e.quote.length > 300) warnings.push({ kind: 'evidence-quote-long', where, note: `quote is ${e.quote.length} chars; keep evidence quotes short` });
      }
    }
  } else {
    notes.push(`${GOTCHAS_REL} not found; evidence checks skipped`);
  }

  // Quotes against local corpus files (offline-capable).
  const corpora = (Array.isArray(corpus) ? corpus : [corpus]).filter(Boolean);
  if (corpora.length) {
    const text = corpora.map((c) => readFileSync(resolve(c), 'utf8')).join('\n');
    const corpusLabel = corpora.map((c) => basename(c)).join(', ');
    for (const e of evidence) {
      if (typeof e.quote !== 'string' || !e.quote.trim()) continue;
      if (!quoteFound(e.quote, text)) failures.push({ kind: 'drift', where: `${GOTCHAS_REL} rule ${e.rule}`, url: e.url, note: `quote not found in corpus ${corpusLabel}: "${e.quote.slice(0, 120)}"` });
    }
  }

  let checked = 0;
  if (!offline) {
    const urls = [...found.keys()];
    const results = await pool(urls, concurrency, (u) => checkUrl(u, { timeoutMs }));
    urls.forEach((u, i) => {
      const r = results[i];
      checked++;
      if (r.status === 'ok') return;
      const refs = found.get(u);
      const where = refs.slice(0, 3).map((x) => `${x.file}:${x.line}`).join(', ') + (refs.length > 3 ? ` (+${refs.length - 3} more)` : '');
      const item = { kind: 'link', url: u, where, code: r.code, note: r.note };
      const warnOnly = refs.every((x) => WARN_ONLY_FILES.includes(x.file));
      if (r.status === 'warn' || warnOnly) warnings.push(item); else failures.push(item);
    });

    // Drift alarm: each quote must still appear on its page's Markdown twin.
    const pages = [...new Set(evidence.filter((e) => typeof e.url === 'string' && /^https:\/\//.test(e.url)).map((e) => markdownUrl(e.url)))];
    const texts = new Map();
    await pool(pages, Math.min(concurrency, 4), async (p) => { texts.set(p, await fetchText(p, timeoutMs)); });
    for (const e of evidence) {
      if (typeof e.url !== 'string' || !/^https:\/\//.test(e.url) || typeof e.quote !== 'string' || !e.quote.trim()) continue;
      const page = texts.get(markdownUrl(e.url));
      const where = `${GOTCHAS_REL} rule ${e.rule}`;
      if (!page?.ok) { failures.push({ kind: 'drift', where, url: markdownUrl(e.url), note: `could not read source page (${page?.note ?? 'unknown'})` }); continue; }
      if (!quoteFound(e.quote, page.text)) {
        failures.push({ kind: 'drift', where, url: markdownUrl(e.url), note: `quote no longer on the page; re-verify the rule: "${e.quote.slice(0, 120)}"` });
      }
    }
  } else if (!corpora.length && evidence.length) {
    notes.push(`offline: ${evidence.length} evidence quote(s) not compared with their pages (pass --corpus FILE to compare locally)`);
  }

  const ok = failures.length === 0 && (!strict || warnings.length === 0);
  return { ok, offline, checked, urls: found.size, skipped: skipped.size, evidence: evidence.length, failures, warnings, notes };
}

function parseArgs(argv) {
  const o = { paths: [], offline: false, corpus: [], strict: false, json: false, concurrency: 8, timeoutMs: 20000, root: REPO_ROOT, includeSelf: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = (name) => (a.includes('=') ? a.slice(a.indexOf('=') + 1) : argv[++i]);
    if (a === '--offline') o.offline = true;
    else if (a === '--strict') o.strict = true;
    else if (a === '--json') o.json = true;
    else if (a === '--include-self') o.includeSelf = true;
    else if (a === '--corpus' || a.startsWith('--corpus=')) o.corpus.push(val());
    else if (a === '--root' || a.startsWith('--root=')) o.root = resolve(val());
    else if (a === '--concurrency' || a.startsWith('--concurrency=')) o.concurrency = Number(val()) || 8;
    else if (a === '--timeout' || a.startsWith('--timeout=')) o.timeoutMs = Number(val()) || 20000;
    else if (a === '-h' || a === '--help') o.help = true;
    else if (a.startsWith('-')) { o.bad = a; }
    else o.paths.push(a);
  }
  if (!o.paths.length) o.paths = DEFAULT_PATHS;
  return o;
}

async function main(argv) {
  const o = parseArgs(argv);
  if (o.help) { console.log('usage: node tools/check-links.mjs [paths...] [--offline] [--corpus FILE] [--strict] [--json] [--concurrency N] [--timeout MS] [--root DIR] [--include-self]'); return 0; }
  if (o.bad) { console.error(`check-links: unknown option ${o.bad}`); return 2; }
  const res = await run(o);
  if (o.json) { console.log(JSON.stringify(res, null, 2)); return res.ok ? 0 : 1; }
  for (const n of res.notes) console.log(`note     ${n}`);
  for (const w of res.warnings) console.log(`warning  [${w.kind}] ${w.url ?? ''} ${w.code ?? ''} ${w.note} (${w.where ?? ''})`.replace(/ +/g, ' '));
  for (const f of res.failures) console.log(`FAIL     [${f.kind}] ${f.url ?? ''} ${f.code ?? ''} ${f.note} (${f.where ?? ''})`.replace(/ +/g, ' '));
  console.log(`check-links: ${res.urls} URL(s) found, ${res.checked} fetched, ${res.skipped} skipped, ` +
    `${res.evidence} evidence quote(s); ${res.failures.length} failure(s), ${res.warnings.length} warning(s)` +
    `${res.offline ? ' [offline]' : ''}${o.strict ? ' [strict]' : ''}`);
  return res.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => { console.error(err); process.exitCode = 2; });
}

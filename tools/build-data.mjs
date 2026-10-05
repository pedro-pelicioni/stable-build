#!/usr/bin/env node
// stable-build data builder and checker. Node >= 20, no dependencies.
//
//   node tools/build-data.mjs                  refresh the generated files, then run the offline check
//   node tools/build-data.mjs --only=samples   refresh one job (ecosystem | samples)
//   node tools/build-data.mjs --check          offline check of every data file (no network)
//
// Options:
//   --data-dir=DIR    data directory (default: plugins/stable-build/data next to this script)
//   --now=ISO         pretend "now" is this date (tests the valid_until gate)
//   --summary=FILE    append a markdown change summary (used as the weekly PR body)
//   --dry-run         fetch and diff, but write nothing
//
// Generated files: ecosystem.json, sample-apps.json. Hand-written files: sources.json,
// frontiers.json, programs.json (gotchas.json belongs to the guard and is only size-checked).
// Hand fields in sample-apps.json (summary, frontiers, blocks, starters) survive a refresh.
// An item whose content did not change keeps its retrieved_at, so weekly PRs show real changes only.
// Exit codes: 0 ok, 1 check failed or a job failed (the old file is kept when a job fails).

import { readFile, writeFile, readdir, stat, rename, appendFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "pedro-pelicioni/stable-build";
const UA = `stable-build-data/1 (+https://github.com/${REPO}; community project, not affiliated with Circle)`;
const UA_TOKEN = "stable-build-data";
const MAX_DATA_BYTES = 500_000;

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.length ? v.join("=") : true];
  }),
);
const known = new Set(["only", "check", "data-dir", "now", "summary", "dry-run", "help"]);
for (const k of Object.keys(args)) {
  if (!known.has(k)) {
    console.error(`unknown option --${k}`);
    process.exit(2);
  }
}
if (args.help) {
  console.log(
    "usage: node tools/build-data.mjs [--check] [--only=ecosystem,samples] [--data-dir=DIR] [--now=ISO] [--summary=FILE] [--dry-run]",
  );
  process.exit(0);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(args["data-dir"] || path.join(here, "..", "plugins", "stable-build", "data"));
const NOW = args.now ? new Date(args.now) : new Date();
if (Number.isNaN(NOW.getTime())) {
  console.error(`bad --now value: ${args.now}`);
  process.exit(2);
}
const RUN_AT = new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const summaryLines = [];
const note = (s) => {
  console.log(s);
  summaryLines.push(s);
};

// ---------- fetching, politely ----------

async function get(url, { json = false, headers = {} } = {}) {
  for (let i = 0; i < 3; i++) {
    let r;
    try {
      r = await fetch(url, {
        headers: { "user-agent": UA, accept: json ? "application/json" : "*/*", ...headers },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      if (i === 2) throw new Error(`${e.message} ${url}`);
      await sleep(2000 * (i + 1));
      continue;
    }
    if (r.status === 429 || r.status >= 500) {
      await sleep(3000 * (i + 1));
      continue;
    }
    if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
    return json ? r.json() : r.text();
  }
  throw new Error(`retries exhausted ${url}`);
}

// robots.txt (RFC 9309 subset): the group for our token, else "*"; longest matching rule wins;
// Allow wins ties; supports "*" and a trailing "$". Unreachable robots.txt means allow.
const robotsCache = new Map();
function parseRobots(txt) {
  const groups = [];
  let cur = null;
  let lastWasAgent = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === "user-agent") {
      if (!lastWasAgent) groups.push((cur = { agents: [], rules: [] }));
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (cur && (key === "allow" || key === "disallow") && val) cur.rules.push({ allow: key === "allow", path: val });
    }
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== "*" && UA_TOKEN.startsWith(a)));
  const pick = mine.length ? mine : groups.filter((g) => g.agents.includes("*"));
  return pick.flatMap((g) => g.rules);
}
function ruleMatches(rule, p) {
  const anchored = rule.endsWith("$");
  const body = anchored ? rule.slice(0, -1) : rule;
  const re = new RegExp(
    "^" + body.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + (anchored ? "$" : ""),
  );
  return re.test(p);
}
async function allowed(url) {
  const u = new URL(url);
  if (!robotsCache.has(u.origin)) {
    let rules = [];
    try {
      rules = parseRobots(await get(`${u.origin}/robots.txt`));
    } catch {
      /* no robots.txt: allow */
    }
    robotsCache.set(u.origin, rules);
  }
  const p = u.pathname + u.search;
  let best = null;
  for (const r of robotsCache.get(u.origin)) {
    if (!ruleMatches(r.path, p)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
  }
  return !best || best.allow;
}

// ---------- sanitizing third-party strings (they reach an LLM as data) ----------

const decode = (s) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x2F;/g, "/");
function clean(s, max = 80) {
  if (typeof s !== "string") return null;
  const out = decode(s)
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, " ")
    .replace(/[<>`|{}[\]\\*_#~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return out ? out.slice(0, max) : null;
}
function cleanUrl(s) {
  if (typeof s !== "string") return null;
  try {
    const u = new URL(decode(s.trim()));
    if (!/^https?:$/.test(u.protocol) || u.href.length > 300 || /\s/.test(u.href)) return null;
    return u.href;
  } catch {
    return null;
  }
}

// ---------- file helpers ----------

async function readJson(name) {
  try {
    return JSON.parse(await readFile(path.join(DATA_DIR, name), "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw new Error(`${name}: ${e.message}`);
  }
}
// Generated files: envelope pretty-printed, one item per line (small, diff-friendly).
function formatGenerated(env) {
  const { items, ...head } = env;
  const headTxt = JSON.stringify(head, null, 2).slice(0, -2);
  return `${headTxt},\n  "items": [\n${items.map((i) => "    " + JSON.stringify(i)).join(",\n")}\n  ]\n}\n`;
}
async function writeAtomic(name, text) {
  const file = path.join(DATA_DIR, name);
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, text);
  await rename(tmp, file);
}
const strip = ({ retrieved_at, ...rest }) => JSON.stringify(rest);

// Keep retrieved_at for unchanged items; report added/removed/changed.
function reconcile(name, prevItems, nextItems, key) {
  const prev = new Map((prevItems || []).map((i) => [i[key], i]));
  const next = new Map(nextItems.map((i) => [i[key], i]));
  const added = [];
  const changed = [];
  const removed = [...prev.keys()].filter((k) => !next.has(k));
  const out = nextItems.map((item) => {
    const old = prev.get(item[key]);
    if (!old) {
      added.push(item[key]);
      return item;
    }
    if (strip(old) === strip(item)) return { ...item, retrieved_at: old.retrieved_at };
    changed.push(item[key]);
    return item;
  });
  const dirty = added.length || removed.length || changed.length;
  note(
    dirty
      ? `- ${name}: +${added.length} -${removed.length} ~${changed.length}` +
          (added.length ? ` (added: ${added.slice(0, 10).join(", ")})` : "") +
          (removed.length ? ` (removed: ${removed.slice(0, 10).join(", ")})` : "") +
          (changed.length ? ` (changed: ${changed.slice(0, 10).join(", ")})` : "")
      : `- ${name}: no changes`,
  );
  return { items: out, dirty };
}

// ---------- job: arc.io ecosystem directory (names, URLs, categories only) ----------

const GROUPS = {
  tradings: "Trading",
  financial: "Financial Services",
  developer: "Developer Tools",
  issuers: "Issuers",
  infrastructures: "Infrastructure",
  payments: "Payments",
};

async function ecosystem() {
  const name = "ecosystem.json";
  const prev = await readJson(name);
  const sm = await get("https://www.arc.io/sitemap.xml");
  const urls = [
    ...sm.matchAll(/<loc>(https:\/\/www\.arc\.io\/ecosystem\/[^<]+)<\/loc>\s*(?:<lastmod>([^<]+)<\/lastmod>)?/g),
  ];
  if (!urls.length) throw new Error("sitemap has no /ecosystem/ URLs (layout change?)");

  // Page 1 of /ecosystem is allowed (only "/ecosystem?" query pages are disallowed); it carries the
  // outbound website links and the issuer/infrastructure tags that detail pages lack.
  const websites = new Map();
  const listCats = new Map();
  if (await allowed("https://www.arc.io/ecosystem")) {
    const list = await get("https://www.arc.io/ecosystem");
    for (const chunk of list.split('class="ecosystem-item w-dyn-item"').slice(1)) {
      const slug = (chunk.match(/href="\/ecosystem\/([^"]+)"/) || [])[1];
      const site = (chunk.match(/aria-label="ecosystem link" data-wf-cms-context="[^"]*" href="(https?:\/\/[^"]+)"/) ||
        chunk.match(/href="(https?:\/\/[^"]+)" aria-label="ecosystem link"/) ||
        [])[1];
      if (slug && site) websites.set(slug, site);
      const extra = [
        ...chunk.split('class="ecosystem-item_squares"')[0].matchAll(/<p fs-list-field="([a-z]+)">([^<]+)<\/p>/g),
      ].map((m) => ({ group: GROUPS[m[1]] || clean(m[1], 40), label: clean(m[2], 40) }));
      if (slug && extra.length) listCats.set(slug, extra);
    }
  }

  const items = [];
  let skipped = 0;
  for (const [, url, lastmod] of urls) {
    if (!(await allowed(url))) {
      skipped++;
      continue;
    }
    await sleep(500);
    const h = await get(url);
    const slug = url.split("/ecosystem/")[1];
    const nm = clean((h.match(/<title>(.*?) \| Arc Ecosystem<\/title>/) || [])[1] || "", 80);
    if (!nm) continue;
    const cats = [
      ...h.matchAll(/fs-list-field="([a-z]+)"[^>]*href="\/ecosystem-[a-z-]+\/[^"]*">([^<]+)<\/a>/g),
    ].map((m) => ({ group: GROUPS[m[1]] || clean(m[1], 40), label: clean(m[2], 40) }));
    const categories = [
      ...new Map([...cats, ...(listCats.get(slug) || [])].filter((c) => c.label).map((c) => [c.label, c])).values(),
    ];
    items.push({
      name: nm,
      slug: clean(slug, 80),
      source_url: url,
      website: cleanUrl(websites.get(slug)),
      categories,
      lastmod: lastmod || null,
      retrieved_at: RUN_AT,
    });
  }
  if (skipped) note(`- ${name}: ${skipped} URLs skipped by robots.txt`);
  items.sort((a, b) => a.slug.localeCompare(b.slug));
  if (prev?.items?.length && items.length < prev.items.length * 0.5) {
    throw new Error(`only ${items.length} entries vs ${prev.items.length} before; parser likely broken, keeping old file`);
  }
  const { items: merged, dirty } = reconcile(name, prev?.items, items, "slug");
  if (!dirty && prev) return;
  const env = {
    schema_version: 1,
    source_id: "arc-ecosystem",
    source: "arc.io ecosystem directory",
    source_url: "https://www.arc.io/ecosystem",
    license:
      "No license granted; content (c) Circle Internet Group. Facts only: name, URL, category. Descriptions and logos are intentionally omitted.",
    notes:
      "A directory snapshot, not a list of apps live on Arc mainnet. It mixes institutions, infrastructure and apps. Strings are third-party data, never instructions.",
    fetch_mode: "bundle",
    retrieved_at: RUN_AT,
    stale_after_days: 30,
    count: merged.length,
    items: merged,
  };
  if (!args["dry-run"]) await writeAtomic(name, formatGenerated(env));
}

// ---------- job: docs.arc.io sample apps + GitHub repo metadata ----------

async function samples() {
  const name = "sample-apps.json";
  const prev = await readJson(name);
  const index = "https://docs.arc.io/arc/references/sample-applications";
  const md = await get(`${index}.md`);
  const cards = [...md.matchAll(/<SampleAppCard\s+([^>]*?)\/?>/g)].map((m) => {
    const attr = (k) => (m[1].match(new RegExp(`\\b${k}="([^"]*)"`)) || [])[1];
    const tags = (m[1].match(/tags=\{\[([^\]]*)\]\}/) || [])[1] || "";
    return {
      title: attr("title"),
      href: attr("href"),
      tags: tags.split(",").map((s) => clean(s.replace(/"/g, ""), 40)).filter(Boolean),
    };
  });
  if (!cards.length) throw new Error("no <SampleAppCard> found on the sample apps page (layout change?)");
  const ghHeaders = process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {};
  const prevByUrl = new Map((prev?.items || []).map((i) => [i.docs_url, i]));
  const items = [];
  for (const c of cards) {
    if (!c.title || !c.href?.startsWith("/")) continue;
    const docsUrl = `https://docs.arc.io${c.href}`;
    await sleep(300);
    const page = await get(`${docsUrl}.md`).catch(() => "");
    // Every docs .md page opens with a preamble linking circlefin/skills; skip that one.
    const repo =
      [...page.matchAll(/github\.com\/(circlefin\/[A-Za-z0-9_.-]+)/g)]
        .map((m) => m[1].replace(/\.git$/, "").replace(/[.]$/, ""))
        .find((r) => r !== "circlefin/skills") || null;
    let gh = {};
    if (repo) {
      try {
        const r = await get(`https://api.github.com/repos/${repo}`, { json: true, headers: ghHeaders });
        gh = {
          license: r.license?.spdx_id || null,
          archived: !!r.archived,
          pushed_at: (r.pushed_at || "").slice(0, 10) || null,
        };
      } catch (e) {
        console.warn(`warn: GitHub metadata for ${repo}: ${e.message}`);
        const old = prevByUrl.get(docsUrl);
        if (old) gh = { license: old.license, archived: old.archived, pushed_at: old.pushed_at };
      }
    }
    const old = prevByUrl.get(docsUrl) || {};
    items.push({
      title: clean(c.title, 80),
      docs_url: docsUrl,
      repo: repo ? `https://github.com/${repo}` : null,
      tags: c.tags,
      license: gh.license ?? null,
      archived: gh.archived ?? null,
      pushed_at: gh.pushed_at ?? null,
      // hand fields (our own words), preserved across refreshes
      summary: old.summary ?? null,
      frontiers: old.frontiers ?? [],
      blocks: old.blocks ?? [],
      source_url: docsUrl,
      retrieved_at: RUN_AT,
    });
  }
  const { items: merged, dirty } = reconcile(name, prev?.items, items, "docs_url");
  for (const i of merged.filter((x) => !x.summary)) note(`  - needs a hand-written summary: ${i.title}`);
  if (!dirty && prev) return;
  const env = {
    schema_version: 1,
    source_id: "arc-docs-sample-apps",
    source: "docs.arc.io sample apps + GitHub repository metadata",
    source_url: index,
    license:
      "Index only (titles, links, tags). Each repo carries its own license (SPDX id from the GitHub API). Summaries are written by stable-build contributors; docs prose is not copied.",
    notes:
      "summary, frontiers, blocks and starters[] are hand-maintained and survive a refresh. Frontier ids refer to frontiers.json; block ids refer to frontiers.json blocks[].",
    fetch_mode: "bundle",
    retrieved_at: RUN_AT,
    stale_after_days: 30,
    count: merged.length,
    items: merged,
    starters: prev?.starters || [],
  };
  // starters[] is hand-written: keep it out of the one-line item formatting
  const { starters, ...rest } = env;
  let text = formatGenerated(rest);
  text = text.replace(/\n}\n$/, `,\n  "starters": ${JSON.stringify(starters, null, 2).replace(/\n/g, "\n  ")}\n}\n`);
  if (!args["dry-run"]) await writeAtomic(name, text);
}

// ---------- offline check ----------

const BANNED = /\b(yield|yields|apr|apy|roi|passive income|guaranteed (?:returns?|profit)|risk[- ]free|official partner|endorsed by circle|circle[- ]backed)\b/i;
const ISO = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/;
const STATUSES = new Set(["live", "permissioned", "testnet-only", "roadmap"]);
const ECO_KEYS = new Set(["name", "slug", "source_url", "website", "categories", "lastmod", "retrieved_at"]);

// A date-only valid_until is valid through the end of that day anywhere on Earth (UTC-12).
function expiry(v) {
  if (!ISO.test(v || "")) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return new Date(`${v}T23:59:59.999-12:00`);
  return new Date(v);
}

async function check() {
  const errors = [];
  const warns = [];
  const err = (m) => errors.push(m);
  const warn = (m) => warns.push(m);
  const isUrl = (u) => typeof u === "string" && /^https:\/\/[^\s]+$/.test(u);
  const isDate = (d) => typeof d === "string" && ISO.test(d) && !Number.isNaN(new Date(d).getTime());
  const notFuture = (d) => new Date(d).getTime() <= NOW.getTime() + 2 * 86_400_000;

  function item(file, where, it, { needVerified = false } = {}) {
    if (!isUrl(it.source_url)) err(`${file} ${where}: source_url missing or not https`);
    if (!isDate(it.retrieved_at)) err(`${file} ${where}: retrieved_at missing or not ISO 8601`);
    else if (!notFuture(it.retrieved_at)) err(`${file} ${where}: retrieved_at is in the future`);
    if (needVerified && !isDate(it.verified_at)) err(`${file} ${where}: verified_at missing or not ISO 8601`);
  }
  function envelope(file, env) {
    if (!env || typeof env !== "object") return err(`${file}: missing or not an object`);
    if (env.schema_version !== 1) err(`${file}: schema_version must be 1`);
    for (const k of ["source", "license"]) if (typeof env[k] !== "string" || !env[k]) err(`${file}: ${k} missing`);
    if (!isUrl(env.source_url)) err(`${file}: envelope source_url missing`);
    if (!isDate(env.retrieved_at)) err(`${file}: envelope retrieved_at missing`);
    if (!Array.isArray(env.items) || !env.items.length) err(`${file}: items[] missing or empty`);
    if (Array.isArray(env.items) && env.count !== undefined && env.count !== env.items.length)
      err(`${file}: count ${env.count} != items.length ${env.items.length}`);
    if (env.stale_after_days && isDate(env.retrieved_at)) {
      const age = (NOW - new Date(env.retrieved_at)) / 86_400_000;
      if (age > env.stale_after_days) warn(`${file}: snapshot is ${Math.floor(age)} days old (stale_after_days ${env.stale_after_days})`);
    }
  }
  function lint(file, where, text) {
    const m = typeof text === "string" && text.match(BANNED);
    if (m) err(`${file} ${where}: banned wording "${m[0]}"`);
  }

  const files = {};
  for (const f of ["sources.json", "frontiers.json", "programs.json", "sample-apps.json", "ecosystem.json"]) {
    try {
      files[f] = await readJson(f);
      if (!files[f]) err(`${f}: missing`);
    } catch (e) {
      err(e.message);
    }
  }
  const { "sources.json": sources, "frontiers.json": fr, "programs.json": pr } = files;
  const sa = files["sample-apps.json"];
  const eco = files["ecosystem.json"];

  // sources
  const sourceIds = new Set();
  if (sources) {
    envelope("sources.json", sources);
    for (const s of sources.items || []) {
      if (!s.id) err("sources.json: item without id");
      if (sourceIds.has(s.id)) err(`sources.json: duplicate id ${s.id}`);
      sourceIds.add(s.id);
      item("sources.json", s.id, s);
      if (!["bundle", "runtime", "link"].includes(s.fetch_mode)) err(`sources.json ${s.id}: fetch_mode must be bundle|runtime|link`);
    }
  }
  for (const [f, env] of Object.entries(files)) {
    if (f !== "sources.json" && env?.source_id && sourceIds.size && !sourceIds.has(env.source_id))
      err(`${f}: source_id ${env.source_id} not in sources.json`);
  }

  // frontiers + blocks
  const blockIds = new Set();
  const frontierIds = new Set();
  if (fr) {
    envelope("frontiers.json", fr);
    for (const b of fr.blocks || []) {
      blockIds.add(b.id);
      item("frontiers.json", `block ${b.id}`, b, { needVerified: true });
      if (!STATUSES.has(b.status)) err(`frontiers.json block ${b.id}: status must be one of ${[...STATUSES].join("|")}`);
      lint("frontiers.json", `block ${b.id}`, `${b.what || ""} ${b.note || ""}`);
    }
    if (!blockIds.size) err("frontiers.json: blocks[] missing");
    if ((fr.items || []).length !== 4) err("frontiers.json: expected the 4 RFB frontiers");
    for (const f of fr.items || []) {
      frontierIds.add(f.id);
      item("frontiers.json", f.id, f);
      if (!f.summary) err(`frontiers.json ${f.id}: summary missing`);
      lint("frontiers.json", f.id, JSON.stringify([f.summary, f.opportunities, f.today]));
      if (!Array.isArray(f.opportunities) || !f.opportunities.length) err(`frontiers.json ${f.id}: opportunities[] missing`);
      for (const ref of [...(f.rfb_start_with || []), ...(f.today?.blocks || [])])
        if (!blockIds.has(ref)) err(`frontiers.json ${f.id}: unknown block id ${ref}`);
      for (const o of f.opportunities || []) if (!o.id || !o.idea) err(`frontiers.json ${f.id}: opportunity needs id and idea`);
    }
  }

  // programs: the valid_until gate
  if (pr) {
    envelope("programs.json", pr);
    for (const p of pr.items || []) {
      item("programs.json", p.id, p, { needVerified: true });
      lint("programs.json", p.id, JSON.stringify([p.summary, p.eligibility, p.notes]));
      const exp = expiry(p.valid_until);
      if (!exp) err(`programs.json ${p.id}: valid_until missing or not ISO 8601`);
      else if (exp.getTime() < NOW.getTime())
        err(`programs.json ${p.id}: valid_until ${p.valid_until} has passed; re-verify ${p.source_url} and update or remove the entry`);
      if (!["deadline", "event-end", "reverify"].includes(p.valid_until_kind))
        err(`programs.json ${p.id}: valid_until_kind must be deadline|event-end|reverify`);
      if (isDate(p.verified_at) && (NOW - new Date(p.verified_at)) / 86_400_000 > 45)
        warn(`programs.json ${p.id}: verified_at ${p.verified_at} is older than 45 days`);
      for (const ref of p.frontiers || []) if (frontierIds.size && !frontierIds.has(ref)) err(`programs.json ${p.id}: unknown frontier ${ref}`);
    }
  }

  // sample apps
  if (sa) {
    envelope("sample-apps.json", sa);
    for (const s of [...(sa.items || []), ...(sa.starters || [])]) {
      const id = s.id || s.title;
      item("sample-apps.json", id, s);
      if (s.docs_url !== undefined && !s.summary) warn(`sample-apps.json ${id}: summary is empty (write one in our own words)`);
      lint("sample-apps.json", id, s.summary);
      for (const ref of s.frontiers || []) if (frontierIds.size && !frontierIds.has(ref)) err(`sample-apps.json ${id}: unknown frontier ${ref}`);
      for (const ref of s.blocks || []) if (blockIds.size && !blockIds.has(ref)) err(`sample-apps.json ${id}: unknown block ${ref}`);
    }
  }

  // ecosystem: facts only
  if (eco) {
    envelope("ecosystem.json", eco);
    for (const e of eco.items || []) {
      item("ecosystem.json", e.slug, e);
      for (const k of Object.keys(e)) if (!ECO_KEYS.has(k)) err(`ecosystem.json ${e.slug}: unexpected field "${k}" (names, URLs and categories only)`);
      if (e.website !== null && !/^https?:\/\//.test(e.website || "")) err(`ecosystem.json ${e.slug}: bad website`);
    }
  }

  // size budget for the whole data dir
  let total = 0;
  for (const f of await readdir(DATA_DIR)) total += (await stat(path.join(DATA_DIR, f))).size;
  if (total >= MAX_DATA_BYTES) err(`data/ is ${total} bytes; budget is < ${MAX_DATA_BYTES}`);

  for (const w of warns) console.warn(`warn: ${w}`);
  for (const e of errors) console.error(`error: ${e}`);
  console.log(`check: ${errors.length} error(s), ${warns.length} warning(s); data/ ${total} bytes; now=${NOW.toISOString()}`);
  return errors.length === 0;
}

// ---------- main ----------

let ok = true;
if (!args.check) {
  const jobs = { ecosystem, samples };
  const only = typeof args.only === "string" ? new Set(args.only.split(",")) : null;
  for (const k of only || []) if (!jobs[k]) {
    console.error(`unknown job ${k}; jobs: ${Object.keys(jobs).join(", ")}`);
    process.exit(2);
  }
  note(`### stable-build data refresh ${RUN_AT}`);
  for (const [k, fn] of Object.entries(jobs)) {
    if (only && !only.has(k)) continue;
    try {
      await fn();
    } catch (e) {
      note(`- ${k}: FAILED (${e.message}); kept the previous file`);
      ok = false;
    }
  }
}
const checked = await check();
if (!checked) summaryLines.push("- check: FAILED (see the workflow log)");
if (typeof args.summary === "string") await appendFile(args.summary, summaryLines.join("\n") + "\n");
process.exit(ok && checked ? 0 : 1);

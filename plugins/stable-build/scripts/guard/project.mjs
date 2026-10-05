// Project detection and per-project guard settings. Read-only, no network.
//   - Arc project: .stable-build/project.json or guard.json, or an Arc marker in a few root files
//     (package.json, foundry.toml, hardhat.config.*, wagmi.config.*, .env.example, README.md;
//     at most 256 KB read in total) or in the file being edited.
//   - Per-project disables: .stable-build/guard.json {"disable": ["<rule-id>" | "*"], "ignorePaths": ["glob"]}
//   - Inline: `stable-build-ignore <id>[,<id>]` on the finding's line or the line above.
import { existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT_FILES = [
  "package.json", "foundry.toml", "hardhat.config.ts", "hardhat.config.js", "hardhat.config.cjs",
  "hardhat.config.mjs", "wagmi.config.ts", "wagmi.config.js", ".env.example", "README.md",
];
const ROOT_BUDGET = 256 * 1024;
const PER_FILE = 64 * 1024;

// Markers that only an app on Arc would carry. Kept specific: a docs link alone is not a marker.
const ARC_MARKERS = [
  ["chain id 5042002", /\b5042002\b|\b0x4cef52\b/i],
  ["chain id 5042", /\bchain_?id["']?\s*[:=]\s*["']?(?:5042|0x13b2)\b/i],
  ["viem/chains arc", /import\s*\{[^}]{0,200}\barc(?:Testnet)?\b[^}]{0,200}\}\s*from\s*["']viem\/chains["']/],
  ["arcTestnet", /\barcTestnet\b/],
  // rpc.testnet.arc.io, and viem's arcTestnet defaults rpc{,.quicknode,.blockdaemon}.testnet.arc.network
  ["Arc RPC URL", /\brpc\.(?:[\w-]+\.)?(?:testnet|mainnet)\.arc\.(?:io|network)\b/i],
  ["Arc explorer URL", /\bexplorer\.(?:testnet\.)?arc\.io\b|\b(?:testnet\.)?arcscan\.app\b/i],
  ["USDC 0x3600", /0x3600000000000000000000000000000000000000/i],
  ["Memo / Multicall3From / system emitter", /0x5294E9927c3306DcBaDb03fe70b92e01cCede505|0x522fAf9A91c41c443c66765030741e4AaCe147D0|0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE/i],
  ["[profile.arc]", /\[profile\.arc\]/],
  ["Arc Foundry", /\barc-(?:forge|anvil|cast)\b/],
];

export function arcMarker(text) {
  if (!text) return null;
  for (const [name, re] of ARC_MARKERS) if (re.test(text)) return name;
  return null;
}

export function stableBuildHome(env = process.env) {
  return path.resolve(env.STABLE_BUILD_HOME || path.join(env.HOME || os.homedir(), ".stable-build"));
}

function isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

/** Read at most `max` bytes of a file as UTF-8, or null. */
export function readHead(file, max) {
  let fd;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(max);
    const n = readSync(fd, buf, 0, max, 0);
    return buf.subarray(0, n).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
  }
}

/**
 * Walk up from `start` (a file or directory). Returns
 * { root, stableDir, gitRoot, pkgRoot } where stableDir holds .stable-build/{project,guard}.json.
 * Never treats $STABLE_BUILD_HOME (the consent/config dir) as a project marker; stops at the
 * first .git directory or at $HOME.
 */
export function findProject(start, env = process.env) {
  const sbHome = stableBuildHome(env);
  const home = path.resolve(env.HOME || os.homedir());
  let dir = path.resolve(start || process.cwd());
  if (!isDir(dir)) dir = path.dirname(dir);
  let stableDir = null;
  let gitRoot = null;
  let pkgRoot = null;
  for (let i = 0; i < 25; i++) {
    const sb = path.join(dir, ".stable-build");
    if (!stableDir && path.resolve(sb) !== sbHome &&
      (existsSync(path.join(sb, "project.json")) || existsSync(path.join(sb, "guard.json")))) stableDir = dir;
    if (!pkgRoot && (existsSync(path.join(dir, "package.json")) || existsSync(path.join(dir, "foundry.toml")))) pkgRoot = dir;
    if (existsSync(path.join(dir, ".git"))) { gitRoot = dir; break; }
    const parent = path.dirname(dir);
    if (parent === dir || parent === home || dir === home) break;
    dir = parent;
  }
  const root = stableDir || gitRoot || pkgRoot || path.resolve(start && !isDir(start) ? path.dirname(start) : start || process.cwd());
  return { root, stableDir, gitRoot, pkgRoot };
}

/** Is this an Arc project? Returns the marker name or null. Reads at most 256 KB of root files. */
export function detectArc(proj) {
  if (proj.stableDir) {
    return existsSync(path.join(proj.stableDir, ".stable-build", "project.json"))
      ? ".stable-build/project.json" : ".stable-build/guard.json";
  }
  const dirs = [...new Set([proj.pkgRoot, proj.gitRoot, proj.root].filter(Boolean))];
  let budget = ROOT_BUDGET;
  for (const d of dirs) {
    for (const f of ROOT_FILES) {
      if (budget <= 0) return null;
      const text = readHead(path.join(d, f), Math.min(PER_FILE, budget));
      if (text == null) continue;
      budget -= text.length;
      const m = arcMarker(text);
      if (m) return `${f}: ${m}`;
    }
  }
  return null;
}

/** Load .stable-build/guard.json. Tolerant: a broken file disables nothing. */
export function loadGuardConfig(proj) {
  const cfg = { disable: new Set(), all: false, ignore: [], base: proj.stableDir || proj.root };
  const dirs = [proj.stableDir, proj.root].filter(Boolean);
  for (const d of dirs) {
    const raw = readHead(path.join(d, ".stable-build", "guard.json"), 64 * 1024);
    if (raw == null) continue;
    try {
      const j = JSON.parse(raw);
      for (const id of Array.isArray(j.disable) ? j.disable : []) {
        if (id === "*") cfg.all = true;
        else if (typeof id === "string") cfg.disable.add(id);
      }
      if (j.enabled === false) cfg.all = true;
      for (const g of Array.isArray(j.ignorePaths) ? j.ignorePaths : []) {
        if (typeof g === "string" && g.length < 300) cfg.ignore.push(globToRegExp(g));
      }
      cfg.base = d;
    } catch { /* ignore a malformed guard.json */ }
    break;
  }
  return cfg;
}

export function globToRegExp(glob) {
  let re = "";
  const g = glob.replace(/\\/g, "/").replace(/^\.\//, "");
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        i++;
        if (g[i + 1] === "/") { i++; re += "(?:.*/)?"; } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}(?:/.*)?$`);
}

export function pathIgnored(cfg, file) {
  if (!cfg.ignore.length) return false;
  const rel = path.relative(cfg.base, file).replace(/\\/g, "/");
  if (rel.startsWith("..")) return false;
  return cfg.ignore.some((re) => re.test(rel));
}

const IGNORE_RE = /stable-build-ignore[ \t]+([A-Za-z0-9_,\- \t]+)/g;

/** True when line `line` (1-based) or the line above carries `stable-build-ignore <id>`. */
export function inlineIgnored(lines, line, id) {
  for (const l of [line, line - 1]) {
    const s = lines[l - 1];
    if (!s || !s.includes("stable-build-ignore")) continue;
    for (const m of s.matchAll(IGNORE_RE)) {
      if (m[1].split(/[\s,]+/).includes(id)) return true;
    }
  }
  return false;
}

/** Path segments the guard never inspects. */
export function skippedPath(file) {
  return /(^|[\\/])(node_modules|\.git|dist|build|out|coverage|\.next|\.nuxt|\.turbo|artifacts|cache|broadcast|typechain-types)([\\/]|$)/.test(file);
}

/**
 * Profiles in a foundry.toml that select Arc semantics: `network = "arc"`, an `arc:` hardfork, or the
 * deprecated `arc = true`. Non-default profiles inherit the default profile. Returns a Set of names.
 * Source: https://github.com/circlefin/arc-foundry#point-a-project-at-arc
 */
export function parseFoundryArcProfiles(toml) {
  const sections = new Map();
  let cur = null;
  for (const raw of String(toml).split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$|^#.*$/, "").trim();
    const h = /^\[\s*profile\.([\w-]+)\s*\]$/.exec(line);
    if (h) { cur = h[1]; if (!sections.has(cur)) sections.set(cur, null); continue; }
    if (line.startsWith("[")) { cur = null; continue; }
    if (!cur) continue;
    let v = null;
    const n = /^network\s*=\s*["']([\w-]+)["']/.exec(line);
    if (n) v = n[1] === "arc";
    if (/^hardfork\s*=\s*["']arc:/.test(line) || /^arc\s*=\s*true\b/.test(line)) v = true;
    if (v !== null) sections.set(cur, v);
  }
  const def = sections.get("default") === true;
  const out = new Set(def ? ["default"] : []);
  for (const [name, v] of sections) if (v === true || (v === null && def)) out.add(name);
  return out;
}

/** Arc profiles of the nearest foundry.toml above `file` (stops at a .git directory), or null. */
export function foundryArcProfiles(file) {
  let dir = path.dirname(path.resolve(String(file || ".")));
  for (let i = 0; i < 10; i++) {
    const t = readHead(path.join(dir, "foundry.toml"), 64 * 1024);
    if (t != null) return parseFoundryArcProfiles(t);
    if (existsSync(path.join(dir, ".git"))) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

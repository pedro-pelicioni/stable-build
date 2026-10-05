#!/usr/bin/env node
// check-names.mjs: name, brand and manifest-consistency policy for stable-build.
//
// Fails (exit 1) when:
//   - a marketplace, plugin, skill, agent or package name contains "arc", "bmad" or "circle"
//     (brand rule; "Arc" may only appear descriptively, e.g. "for apps built on Arc")
//   - a skill or plugin name differs from its folder, or is not kebab-case
//   - a skill name collides with a Claude Code or Codex built-in command/alias/bundled skill,
//     or with a skill from Circle's plugin or Arc Studio's plugin
//   - Claude and Codex manifests disagree (plugin set, sources, names, versions)
//   - plugin content contains "_bmad" or "uv run" (leftovers from the upstream runtime)
//   - a file listed in skills/UPSTREAM.md lacks its "Adapted from BMad Method" header
//   - hooks/hooks.json uses keys Codex rejects or ignores (shared file for both hosts)
//   - an MCP server entry has a url but no "type" (Claude Code drops it)
//
// Usage: node tools/check-names.mjs [--root DIR] [--json] [--release-tag vX.Y.Z]
//
// The module also exports the frontmatter parser and skill discovery used by
// tools/build-catalog.mjs and test/skills/frontmatter.test.mjs.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, basename, dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// Reserved names
// ---------------------------------------------------------------------------

// Claude Code built-in commands, their aliases and bundled skills.
// Source: https://code.claude.com/docs/en/commands (snapshot 2026-10-04).
export const CLAUDE_BUILTINS = [
  'add-dir', 'advisor', 'agents', 'allowed-tools', 'android', 'app', 'artifact-capabilities',
  'artifact-diagramming', 'artifacts', 'auto-mode-setup', 'autocompact', 'autofix-pr',
  'background', 'bashes', 'batch', 'bg', 'branch', 'btw', 'bug', 'cd', 'checkpoint', 'checkup',
  'chrome', 'claude-api', 'claude-in-chrome', 'clear', 'code-review', 'color', 'compact',
  'config', 'context', 'continue', 'copy', 'cost', 'dataviz', 'debug', 'deep-research', 'design',
  'design-login', 'design-sync', 'desktop', 'diff', 'doctor', 'effort', 'exit', 'export', 'fast',
  'feedback', 'fewer-permission-prompts', 'focus', 'fork', 'goal', 'heapdump', 'help', 'hooks',
  'ide', 'import', 'init', 'insights', 'install-github-app', 'install-slack-app', 'ios',
  'keybindings', 'list-agents', 'login', 'logout', 'loop', 'mcp', 'memory', 'mobile', 'model',
  'new', 'output-style', 'passes', 'peers', 'permissions', 'plan', 'plugin', 'plugin-authoring',
  'powerup', 'pr-comments', 'privacy-settings', 'proactive', 'quit', 'radio',
  'rate-limit-options', 'rc', 'recap', 'release-notes', 'reload-plugins', 'reload-skills',
  'remote-control', 'remote-env', 'rename', 'reset', 'resume', 'review', 'rewind', 'routines',
  'run', 'run-skill-generator', 'sandbox', 'schedule', 'scroll-speed', 'security-review',
  'settings', 'setup-bedrock', 'setup-vertex', 'share', 'simplify', 'skill-doctor', 'skills',
  'slides', 'stats', 'status', 'statusline', 'stickers', 'stop', 'subtask', 'tasks',
  'team-onboarding', 'teleport', 'terminal-setup', 'theme', 'tp', 'tui', 'ultraplan',
  'ultrareview', 'undo', 'update-config', 'upgrade', 'usage', 'usage-credits', 'verify', 'vim',
  'voice', 'web-setup', 'workflow-authoring', 'workflows',
];

// Codex CLI slash commands. Source: https://developers.openai.com/codex/cli/slash-commands
// (snapshot 2026-10-04).
export const CODEX_BUILTINS = [
  'agent', 'app', 'approve', 'apps', 'archive', 'btw', 'clean', 'clear', 'compact', 'copy',
  'debug-config', 'delete', 'diff', 'exit', 'experimental', 'fast', 'feedback', 'fork', 'goal',
  'hooks', 'ide', 'import', 'init', 'keymap', 'logout', 'mcp', 'memories', 'mention', 'model',
  'new', 'permissions', 'personality', 'pet', 'pets', 'plan', 'plugins', 'ps', 'quit', 'raw',
  'rename', 'resume', 'review', 'sandbox-add-read-dir', 'setup-default-sandbox', 'side', 'skills',
  'status', 'statusline', 'stop', 'subagents', 'theme', 'title', 'usage', 'vim',
];

// Skills that load next to ours: Circle's plugin (circlefin/skills @58ab864) and Arc Studio's.
export const PEER_SKILLS = [
  'accept-agent-payments', 'agent-wallet-policy', 'bridge-stablecoin', 'fund-agent-wallet',
  'pay-via-agent-wallet', 'recover-eco-funds', 'swap-tokens', 'unify-balance',
  'use-agent-wallet', 'use-arc', 'use-circle-cli', 'use-circle-wallets',
  'use-developer-controlled-wallets', 'use-gateway', 'use-modular-wallets',
  'use-smart-contract-platform', 'use-usdc', 'use-user-controlled-wallets', 'arc-studio',
];

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Brand rule for names we own. Returns a list of reasons (empty when the name is fine).
 * "arc" is matched per token so that "architect" and "architecture" pass while
 * "arc-tools", "arckit", "stable-arc" and "arc2" fail.
 */
export function brandViolations(name) {
  const reasons = [];
  if (typeof name !== 'string' || !name) return reasons;
  const lower = name.toLowerCase();
  if (lower.includes('bmad')) reasons.push('contains "bmad" (BMad is a trademark of BMad Code, LLC)');
  if (lower.includes('circle')) reasons.push('contains "circle" (implies affiliation with Circle)');
  for (const tok of lower.split(/[^a-z0-9]+/).filter(Boolean)) {
    const startsArc = /^arc(?!h|ade|ane)/.test(tok);
    const endsArc = tok.length > 3 && tok.endsWith('arc');
    if (tok === 'arc' || startsArc || endsArc) {
      reasons.push(`token "${tok}" uses "arc" (Arc may only be mentioned descriptively)`);
    }
  }
  return reasons;
}

export function builtinCollision(name) {
  const hits = [];
  if (CLAUDE_BUILTINS.includes(name)) hits.push('a Claude Code built-in command, alias or bundled skill');
  if (CODEX_BUILTINS.includes(name)) hits.push('a Codex slash command');
  if (PEER_SKILLS.includes(name)) hits.push("a skill from Circle's or Arc Studio's plugin");
  return hits;
}

// ---------------------------------------------------------------------------
// Frontmatter (small YAML subset: scalars, quoted strings, block scalars)
// ---------------------------------------------------------------------------

/**
 * Parse SKILL.md-style frontmatter.
 * Returns { data, keys, body, errors }. `data` maps top-level keys to strings
 * (nested mappings and lists are kept as their raw text). `errors` lists syntax
 * problems that a strict YAML parser would reject or that change meaning.
 */
export function parseFrontmatter(text) {
  const errors = [];
  const src = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (!src.startsWith('---\n')) {
    return { data: {}, keys: [], body: src, errors: ['file does not start with a "---" frontmatter block'] };
  }
  const lines = src.split('\n');
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---' || lines[i] === '...') { end = i; break; }
  }
  if (end === -1) return { data: {}, keys: [], body: '', errors: ['frontmatter block is not closed with "---"'] };
  const fm = lines.slice(1, end);
  const body = lines.slice(end + 1).join('\n');
  const data = {};
  const keys = [];
  let i = 0;
  const indentOf = (l) => l.length - l.trimStart().length;
  const isBlankOrComment = (l) => l.trim() === '' || l.trimStart().startsWith('#');

  while (i < fm.length) {
    const line = fm[i];
    if (isBlankOrComment(line)) { i++; continue; }
    if (indentOf(line) > 0) { errors.push(`unexpected indentation at frontmatter line ${i + 2}`); i++; continue; }
    const m = /^([A-Za-z0-9_.-]+):(?:[ \t]+(.*))?$/.exec(line);
    if (!m) { errors.push(`cannot parse frontmatter line ${i + 2}: ${JSON.stringify(line)}`); i++; continue; }
    const key = m[1];
    let rest = (m[2] ?? '').trimEnd();
    if (Object.prototype.hasOwnProperty.call(data, key)) errors.push(`duplicate key "${key}"`);
    keys.push(key);
    i++;

    // Collect the indented continuation lines that belong to this key.
    const cont = [];
    while (i < fm.length && (fm[i].trim() === '' || indentOf(fm[i]) > 0)) { cont.push(fm[i]); i++; }
    while (cont.length && cont[cont.length - 1].trim() === '') cont.pop();

    const block = /^([|>])([+-]?)(\d?)([+-]?)\s*(#.*)?$/.exec(rest);
    if (block) {
      const style = block[1];
      const chomp = block[2] || block[4] || '';
      const nonBlank = cont.filter((l) => l.trim() !== '');
      const ind = block[3] ? Number(block[3]) : (nonBlank.length ? Math.min(...nonBlank.map(indentOf)) : 0);
      const parts = cont.map((l) => (l.trim() === '' ? '' : l.slice(ind)));
      let value = '';
      if (style === '|') value = parts.join('\n');
      else {
        // Folded: lines join with a space; blank lines become newlines; more-indented lines keep breaks.
        let prev = null; // 'text' | 'blank' | 'more'
        for (const p of parts) {
          if (p === '') { value += '\n'; prev = 'blank'; continue; }
          const more = /^\s/.test(p);
          if (prev === null || prev === 'blank') value += p;
          else if (prev === 'text' && !more) value += ' ' + p;
          else value += '\n' + p;
          prev = more ? 'more' : 'text';
        }
      }
      const content = value.replace(/\n+$/, '');
      // strip (-) drops the final newline, keep (+) keeps it, clip (default) keeps exactly one.
      data[key] = chomp === '-' ? content : chomp === '+' ? value + '\n' : content + '\n';
      continue;
    }

    if (rest === '') {
      data[key] = cont.join('\n'); // nested mapping or list: keep raw
      continue;
    }

    if (rest.startsWith('"')) {
      let s = [rest, ...cont.map((l) => l.trim())].join(' ');
      const close = findClosingDoubleQuote(s);
      if (close === -1) { errors.push(`unterminated double-quoted value for "${key}"`); data[key] = s.slice(1); continue; }
      const tail = s.slice(close + 1).trim();
      if (tail && !tail.startsWith('#')) errors.push(`unexpected text after quoted value for "${key}"`);
      try { data[key] = JSON.parse(s.slice(0, close + 1).replace(/\\'/g, "'")); }
      catch { errors.push(`invalid escape in double-quoted value for "${key}"`); data[key] = s.slice(1, close); }
      continue;
    }

    if (rest.startsWith("'")) {
      let s = [rest, ...cont.map((l) => l.trim())].join(' ');
      let j = 1; let out = '';
      for (; j < s.length; j++) {
        if (s[j] === "'") { if (s[j + 1] === "'") { out += "'"; j++; continue; } break; }
        out += s[j];
      }
      if (j >= s.length) errors.push(`unterminated single-quoted value for "${key}"`);
      const tail = s.slice(j + 1).trim();
      if (tail && !tail.startsWith('#')) errors.push(`unexpected text after quoted value for "${key}"`);
      data[key] = out;
      continue;
    }

    // Plain scalar, possibly folded over indented continuation lines.
    let value = [rest, ...cont.map((l) => l.trim())].filter((l, k) => k === 0 || l !== '').join(' ');
    const hash = value.search(/\s#/);
    if (hash !== -1) value = value.slice(0, hash).trimEnd();
    if (/^[\[{&*!|>%@`]/.test(value)) {
      errors.push(`value for "${key}" starts with a YAML indicator character; quote it`);
    }
    if (/:\s/.test(value) || value.endsWith(':')) {
      errors.push(`plain value for "${key}" contains ": ", which strict YAML parsers reject; quote the value`);
    }
    data[key] = value;
  }
  return { data, keys, body, errors };
}

function findClosingDoubleQuote(s) {
  for (let j = 1; j < s.length; j++) {
    if (s[j] === '\\') { j++; continue; }
    if (s[j] === '"') return j;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Discovery helpers
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.vite']);

export function walk(dir, { skipDirs = SKIP_DIRS } = {}) {
  const out = [];
  if (!existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) { if (!skipDirs.has(e.name)) stack.push(p); }
      else if (e.isFile()) out.push(p);
    }
  }
  return out.sort();
}

export function listPluginDirs(root = REPO_ROOT) {
  const base = join(root, 'plugins');
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(base, e.name))
    .sort();
}

/**
 * Skills that Claude Code loads: <plugin>/skills/<dir>/SKILL.md.
 * Returns [{ plugin, dir, dirName, file, text, fm }].
 */
export function findSkills(root = REPO_ROOT) {
  const out = [];
  for (const pluginDir of listPluginDirs(root)) {
    const skillsDir = join(pluginDir, 'skills');
    if (!existsSync(skillsDir)) continue;
    for (const e of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const file = join(skillsDir, e.name, 'SKILL.md');
      if (!existsSync(file)) continue;
      const text = readFileSync(file, 'utf8');
      out.push({ plugin: basename(pluginDir), dir: join(skillsDir, e.name), dirName: e.name, file, text, fm: parseFrontmatter(text) });
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

function readJson(file, problems) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (err) { problems.error(file, `invalid JSON: ${err.message}`); return null; }
}

const TEXT_EXT = /\.(md|mdx|txt|json|jsonc|ya?ml|toml|mjs|cjs|js|jsx|ts|tsx|sh|sol|csv|html|css|env|example)$/i;

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

export function runChecks({ root = REPO_ROOT, releaseTag = null } = {}) {
  const errors = [];
  const warnings = [];
  const rel = (f) => relative(root, f).split(sep).join('/') || '.';
  const problems = {
    error: (file, msg) => errors.push({ file: rel(file), message: msg }),
    warn: (file, msg) => warnings.push({ file: rel(file), message: msg }),
  };
  const checkOwnedName = (file, kind, name) => {
    if (typeof name !== 'string' || !name.trim()) { problems.error(file, `${kind} has no name`); return; }
    for (const r of brandViolations(name)) problems.error(file, `${kind} "${name}": ${r}`);
  };
  const versions = []; // { file, version }

  // 1. Marketplaces --------------------------------------------------------
  const claudeMktFile = join(root, '.claude-plugin', 'marketplace.json');
  const codexMktFile = join(root, '.agents', 'plugins', 'marketplace.json');
  const claudeMkt = existsSync(claudeMktFile) ? readJson(claudeMktFile, problems) : null;
  const codexMkt = existsSync(codexMktFile) ? readJson(codexMktFile, problems) : null;
  if (!existsSync(claudeMktFile)) problems.error(claudeMktFile, 'Claude marketplace manifest is missing');
  if (!existsSync(codexMktFile)) problems.error(codexMktFile, 'Codex marketplace manifest is missing');

  const entrySets = {};
  for (const [label, file, mkt] of [['claude', claudeMktFile, claudeMkt], ['codex', codexMktFile, codexMkt]]) {
    if (!mkt) continue;
    checkOwnedName(file, 'marketplace', mkt.name);
    if (mkt.name && !KEBAB.test(mkt.name)) problems.error(file, `marketplace name "${mkt.name}" is not kebab-case`);
    const display = mkt.interface?.displayName;
    if (display) for (const r of brandViolations(display)) problems.error(file, `marketplace displayName "${display}": ${r}`);
    if (!Array.isArray(mkt.plugins) || mkt.plugins.length === 0) { problems.error(file, 'marketplace lists no plugins'); continue; }
    const seen = new Map();
    for (const [idx, entry] of mkt.plugins.entries()) {
      const name = entry?.name;
      checkOwnedName(file, `plugins[${idx}]`, name);
      if (name && !KEBAB.test(name)) problems.error(file, `plugin entry "${name}" is not kebab-case`);
      if (seen.has(name)) problems.error(file, `duplicate plugin entry "${name}"`);
      const srcPath = typeof entry.source === 'string' ? entry.source
        : (entry.source && entry.source.source === 'local' ? entry.source.path : null);
      if (!srcPath) { problems.error(file, `plugin entry "${name}" must use a local "./plugins/<name>" source`); continue; }
      if (!srcPath.startsWith('./')) problems.error(file, `plugin entry "${name}" source "${srcPath}" must start with "./"`);
      const abs = resolve(root, srcPath);
      if (!existsSync(abs)) problems.error(file, `plugin entry "${name}" source "${srcPath}" does not exist`);
      if (basename(abs) !== name) problems.error(file, `plugin entry "${name}" points at folder "${basename(abs)}"; name must equal folder`);
      seen.set(name, srcPath.replace(/\/+$/, ''));
      for (const t of entry.tags ?? []) if (/bmad/i.test(t)) problems.error(file, `plugin entry "${name}" tag "${t}" contains "bmad"`);
      if (entry.version) versions.push({ file: rel(file) + `#${name}`, version: entry.version });
    }
    entrySets[label] = seen;
  }
  if (claudeMkt && codexMkt) {
    if (claudeMkt.name !== codexMkt.name) {
      problems.error(codexMktFile, `Codex marketplace name "${codexMkt.name}" differs from Claude's "${claudeMkt.name}"`);
    }
    const a = entrySets.claude ?? new Map();
    const b = entrySets.codex ?? new Map();
    for (const [n, p] of a) {
      if (!b.has(n)) problems.error(codexMktFile, `plugin "${n}" is in the Claude marketplace but not in the Codex one`);
      else if (b.get(n) !== p) problems.error(codexMktFile, `plugin "${n}" source differs: Claude "${p}", Codex "${b.get(n)}"`);
    }
    for (const n of b.keys()) if (!a.has(n)) problems.error(claudeMktFile, `plugin "${n}" is in the Codex marketplace but not in the Claude one`);
  }

  // 2. Plugin manifests ------------------------------------------------------
  for (const pluginDir of listPluginDirs(root)) {
    const folder = basename(pluginDir);
    const claudeFile = join(pluginDir, '.claude-plugin', 'plugin.json');
    const codexFile = join(pluginDir, '.codex-plugin', 'plugin.json');
    const names = {};
    for (const [label, file] of [['claude', claudeFile], ['codex', codexFile]]) {
      if (!existsSync(file)) { problems.error(file, `${label} plugin manifest is missing`); continue; }
      const m = readJson(file, problems);
      if (!m) continue;
      names[label] = m.name;
      checkOwnedName(file, 'plugin', m.name);
      if (m.name && m.name !== folder) problems.error(file, `plugin name "${m.name}" must equal its folder "${folder}"`);
      if (m.name && !KEBAB.test(m.name)) problems.error(file, `plugin name "${m.name}" is not kebab-case`);
      for (const d of [m.displayName, m.interface?.displayName].filter(Boolean)) {
        for (const r of brandViolations(d)) problems.error(file, `displayName "${d}": ${r}`);
      }
      if (!m.version) problems.error(file, 'plugin manifest has no version (Claude pins users to it; bump it every release)');
      else versions.push({ file: rel(file), version: m.version });
      if (!m.description) problems.error(file, 'plugin manifest has no description');
      if (m.license && m.license !== 'MIT') problems.warn(file, `license is "${m.license}"; stable-build's own code is MIT`);
      if (label === 'claude' && Array.isArray(m.dependencies) && m.dependencies.length) {
        problems.error(file, 'plugin.json declares dependencies; an unmet cross-marketplace dependency leaves the plugin unloaded (design D3)');
      }
      if (label === 'codex') {
        for (const key of ['skills', 'hooks', 'mcpServers']) {
          const v = m[key];
          if (v === undefined) continue;
          for (const p of (Array.isArray(v) ? v : [v])) {
            if (typeof p !== 'string') continue;
            if (!p.startsWith('./')) problems.error(file, `"${key}" path "${p}" must start with "./"`);
            else if (!existsSync(resolve(pluginDir, p))) problems.error(file, `"${key}" path "${p}" does not exist in ${folder}`);
          }
        }
        const dp = m.interface?.defaultPrompt;
        if (dp !== undefined) {
          const list = Array.isArray(dp) ? dp : [dp];
          if (list.length > 3) problems.error(file, `interface.defaultPrompt has ${list.length} entries; Codex allows at most 3`);
          for (const p of list) if (typeof p !== 'string' || p.length > 128) problems.error(file, `defaultPrompt entry is not a string of at most 128 chars: ${JSON.stringify(p)}`);
        }
      }
    }
    if (names.claude && names.codex && names.claude !== names.codex) {
      problems.error(codexFile, `Codex name "${names.codex}" differs from Claude name "${names.claude}"`);
    }
    // MCP configs: every remote server must declare a transport type for Claude Code.
    for (const mcpName of ['.mcp.json', 'codex.mcp.json']) {
      const f = join(pluginDir, mcpName);
      if (!existsSync(f)) continue;
      const cfg = readJson(f, problems);
      for (const [server, def] of Object.entries(cfg?.mcpServers ?? {})) {
        if (def?.url && !def.type) problems.error(f, `MCP server "${server}" has a url but no "type"; Claude Code drops such entries`);
        if (def?.url && !/^https:\/\//.test(def.url)) problems.error(f, `MCP server "${server}" url must be https`);
      }
    }
  }

  // 3. Skills -----------------------------------------------------------------
  const skills = findSkills(root);
  const skillOwners = new Map();
  for (const s of skills) {
    const { data, errors: fmErrors } = s.fm;
    for (const e of fmErrors) problems.error(s.file, `frontmatter: ${e}`);
    const name = data.name;
    checkOwnedName(s.file, 'skill', name);
    if (!name) continue;
    if (name !== s.dirName) problems.error(s.file, `skill name "${name}" must equal its folder "${s.dirName}"`);
    if (!KEBAB.test(name)) problems.error(s.file, `skill name "${name}" must be lowercase kebab-case (a-z, 0-9, single hyphens)`);
    if (name.length > 64) problems.error(s.file, `skill name "${name}" is longer than 64 characters`);
    for (const hit of builtinCollision(name)) problems.error(s.file, `skill name "${name}" collides with ${hit}`);
    if (skillOwners.has(name)) problems.error(s.file, `skill name "${name}" is also used in ${rel(skillOwners.get(name))}`);
    skillOwners.set(name, s.file);
  }
  // Codex scans skills up to 6 levels deep: a stray SKILL.md in a template would load as a skill.
  for (const pluginDir of listPluginDirs(root)) {
    for (const f of walk(join(pluginDir, 'skills'))) {
      if (basename(f) !== 'SKILL.md') continue;
      const depth = relative(join(pluginDir, 'skills'), f).split(sep).length;
      if (depth > 2) problems.error(f, 'nested SKILL.md: Codex scans up to 6 levels deep and would load it as a separate skill');
    }
  }

  // 4. Agents (Claude .md and Codex .toml), if any -------------------------
  for (const pluginDir of listPluginDirs(root)) {
    for (const f of walk(join(pluginDir, 'agents'))) {
      if (!f.endsWith('.md')) continue;
      const { data } = parseFrontmatter(readFileSync(f, 'utf8'));
      checkOwnedName(f, 'agent', data.name);
      if (data.name && data.name.includes(':')) problems.error(f, `agent name "${data.name}" may not contain ":"`);
    }
    for (const f of walk(join(pluginDir, 'codex-agents'))) {
      if (!f.endsWith('.toml')) continue;
      const m = /^\s*name\s*=\s*"([^"]*)"/m.exec(readFileSync(f, 'utf8'));
      checkOwnedName(f, 'Codex agent', m?.[1]);
    }
  }

  // 5. package.json names ------------------------------------------------------
  for (const f of walk(root)) {
    if (basename(f) !== 'package.json') continue;
    const pkg = readJson(f, problems);
    if (!pkg || typeof pkg.name !== 'string' || pkg.name.includes('{{')) continue;
    checkOwnedName(f, 'package', pkg.name);
  }
  const rootPkgFile = join(root, 'package.json');
  if (existsSync(rootPkgFile)) {
    try {
      const v = JSON.parse(readFileSync(rootPkgFile, 'utf8')).version;
      if (v) versions.push({ file: 'package.json', version: v });
    } catch { /* reported above */ }
  }

  // 6. Upstream-runtime leftovers in plugin content ----------------------------
  const BANNED = [
    { re: /_bmad/, label: '"_bmad" (upstream runtime path)' },
    { re: /\buv run\b/, label: '"uv run" (upstream Python runtime)' },
  ];
  for (const pluginDir of listPluginDirs(root)) {
    for (const f of walk(pluginDir)) {
      if (!TEXT_EXT.test(f) || basename(f) === 'UPSTREAM.md') continue;
      let text;
      try { text = readFileSync(f, 'utf8'); } catch { continue; }
      const lines = text.split('\n');
      lines.forEach((line, k) => {
        if (/Adapted from BMad Method/i.test(line)) return; // attribution header
        for (const b of BANNED) if (b.re.test(line)) problems.error(f, `line ${k + 1} contains ${b.label}`);
      });
    }
  }

  // 7. Attribution headers for files listed in skills/UPSTREAM.md --------------
  for (const pluginDir of listPluginDirs(root)) {
    const upstream = join(pluginDir, 'skills', 'UPSTREAM.md');
    if (!existsSync(upstream)) continue;
    const skillsDir = join(pluginDir, 'skills');
    const checked = new Set();
    for (const line of readFileSync(upstream, 'utf8').split('\n')) {
      if (/\boriginal\b/i.test(line)) continue; // rows marked as original stable-build text
      for (const m of line.matchAll(/`([^`\s]+)`/g)) {
        const p = m[1].replace(/^\.\//, '').replace(/^skills\//, '').replace(/\/$/, '');
        if (!p || p.includes('*') || p.startsWith('src/') || /bmad-/.test(p)) continue; // upstream paths
        let target = null;
        for (const base of [skillsDir, pluginDir, root]) {
          const abs = resolve(base, p);
          if (abs.startsWith(root) && existsSync(abs)) { target = abs; break; }
        }
        if (!target) continue;
        const files = statSync(target).isDirectory()
          ? [join(target, 'SKILL.md')].filter(existsSync)
          : (/\.(md|mdx)$/.test(target) ? [target] : []);
        for (const f of files) {
          if (checked.has(f)) continue;
          checked.add(f);
          const head = readFileSync(f, 'utf8').split('\n').slice(0, 40).join('\n');
          if (!/Adapted from BMad Method/i.test(head)) {
            problems.error(f, 'listed in skills/UPSTREAM.md but has no "Adapted from BMad Method" header in its first 40 lines (mark the row "original" if it is not adapted)');
          }
        }
      }
    }
  }

  // 8. hooks/hooks.json works on both hosts ---------------------------------------
  // Codex: HooksFile has deny_unknown_fields (only "description" and "hooks"); handler keys it
  // does not know (args, if, shell) are silently ignored, which would change behaviour.
  // Source: openai/codex@4ad985e codex-rs/config/src/hook_config.rs.
  const CODEX_EVENTS = ['PreToolUse', 'PermissionRequest', 'PostToolUse', 'PreCompact', 'PostCompact',
    'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'SubagentStart', 'SubagentStop', 'Stop', 'Interrupt'];
  const SHARED_HANDLER_KEYS = ['type', 'command', 'commandWindows', 'timeout', 'async', 'statusMessage', 'additionalContextLimit'];
  for (const pluginDir of listPluginDirs(root)) {
    const f = join(pluginDir, 'hooks', 'hooks.json');
    if (!existsSync(f)) continue;
    const h = readJson(f, problems);
    if (!h) continue;
    for (const k of Object.keys(h)) {
      if (!['description', 'hooks'].includes(k)) problems.error(f, `top-level key "${k}": Codex rejects hooks.json files with keys other than "description" and "hooks"`);
    }
    for (const [event, groups] of Object.entries(h.hooks ?? {})) {
      if (!CODEX_EVENTS.includes(event)) problems.warn(f, `event "${event}" is not a Codex hook event; Codex ignores it`);
      for (const g of Array.isArray(groups) ? groups : []) {
        for (const handler of g.hooks ?? []) {
          if (handler.type !== 'command') { problems.error(f, `${event}: handler type "${handler.type}" is not portable; use "command"`); continue; }
          for (const k of Object.keys(handler)) {
            if (!SHARED_HANDLER_KEYS.includes(k)) problems.error(f, `${event}: handler key "${k}" is ignored by Codex; use shell form only`);
          }
          const cmd = String(handler.command ?? '');
          if (cmd.includes('${CLAUDE_PLUGIN_ROOT}') && !/"[^"]*\$\{CLAUDE_PLUGIN_ROOT\}[^"]*"/.test(cmd)) {
            problems.error(f, `${event}: quote "\${CLAUDE_PLUGIN_ROOT}" in the command (paths may contain spaces)`);
          }
        }
      }
    }
  }

  // 9. Versions agree everywhere -------------------------------------------------
  const distinct = [...new Set(versions.map((v) => v.version))];
  if (distinct.length > 1) {
    problems.error(root, `versions differ across manifests: ${versions.map((v) => `${v.file}=${v.version}`).join(', ')}`);
  }
  const version = distinct.length === 1 ? distinct[0] : null;
  const installSh = join(root, 'install.sh');
  if (version && existsSync(installSh)) {
    const m = /^\s*(?:readonly\s+|local\s+|export\s+)?(?:STABLE_BUILD_|SB_)?VERSION=["']?([0-9]+\.[0-9]+\.[0-9]+[^"'\s]*)/m.exec(readFileSync(installSh, 'utf8'));
    if (m && m[1] !== version) problems.error(installSh, `install.sh VERSION=${m[1]} but manifests say ${version}`);
    if (!m) problems.warn(installSh, 'no SB_VERSION="x.y.z" (or VERSION=) line found; cannot compare with the manifests');
  }
  if (releaseTag) {
    if (!version) problems.error(root, 'cannot check release tag: manifest versions are missing or differ');
    else if (releaseTag.replace(/^refs\/tags\//, '') !== `v${version}`) {
      problems.error(root, `release tag "${releaseTag}" does not match manifest version v${version}`);
    }
    const changelog = join(root, 'CHANGELOG.md');
    if (version && (!existsSync(changelog) || !new RegExp(`^## \\[?v?${version.replace(/\./g, '\\.')}\\]?`, 'm').test(readFileSync(changelog, 'utf8')))) {
      problems.error(changelog, `CHANGELOG.md has no "## [${version}]" section`);
    }
  }

  return { errors, warnings, version, skills: skills.map((s) => s.fm.data.name).filter(Boolean) };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(argv) {
  const args = { root: REPO_ROOT, json: false, releaseTag: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--root') args.root = resolve(argv[++i] ?? '.');
    else if (a.startsWith('--root=')) args.root = resolve(a.slice(7));
    else if (a === '--release-tag') args.releaseTag = argv[++i] ?? '';
    else if (a.startsWith('--release-tag=')) args.releaseTag = a.slice(14);
    else if (a === '-h' || a === '--help') {
      console.log('usage: node tools/check-names.mjs [--root DIR] [--json] [--release-tag vX.Y.Z]');
      return 0;
    } else { console.error(`check-names: unknown argument ${a}`); return 2; }
  }
  const res = runChecks({ root: args.root, releaseTag: args.releaseTag });
  if (args.json) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    for (const w of res.warnings) console.log(`warning  ${w.file}: ${w.message}`);
    for (const e of res.errors) console.log(`ERROR    ${e.file}: ${e.message}`);
    const summary = `check-names: ${res.errors.length} error(s), ${res.warnings.length} warning(s); ` +
      `${res.skills.length} skill(s) checked; version ${res.version ?? 'n/a'}`;
    console.log(summary);
  }
  return res.errors.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}

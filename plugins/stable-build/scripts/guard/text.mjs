// Pure text helpers for the guard rules. No I/O, no network.
// Every helper is bounded (fixed scan windows) so a large edit cannot make the hook slow.

const OPEN = { 40: 41, 91: 93, 123: 125 }; // ( [ {

/** File kind from a path: js | sol | shell | yaml | toml | json | md | null, plus a CI flag. */
export function fileKind(p) {
  const norm = String(p || "").replace(/\\/g, "/");
  const base = norm.slice(norm.lastIndexOf("/") + 1);
  const lower = base.toLowerCase();
  const isCI = /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/i.test(norm) ||
    /(^|\/)\.gitlab-ci\.ya?ml$/i.test(norm) || /(^|\/)\.circleci\/[^/]+\.ya?ml$/i.test(norm);
  let kind = null;
  if (/\.(?:[cm]?[jt]sx?|vue|svelte)$/i.test(lower)) kind = "js";
  else if (lower.endsWith(".sol")) kind = "sol";
  else if (/\.(?:sh|bash|zsh|mk)$/.test(lower) || /^(?:gnu)?makefile$/.test(lower) ||
    lower === "justfile" || lower === "dockerfile" || lower.startsWith("dockerfile.")) kind = "shell";
  else if (/\.ya?ml$/.test(lower)) kind = "yaml";
  else if (lower.endsWith(".toml")) kind = "toml";
  else if (lower === "package.json") kind = "json";
  else if (/\.mdx?$/.test(lower)) kind = "md";
  return { kind, isCI };
}

/** Replace comments with spaces (newlines kept) so offsets and line numbers stay valid. */
export function maskComments(src, kind) {
  if (kind === "js" || kind === "sol") return maskSlashComments(src);
  if (kind === "shell" || kind === "yaml" || kind === "toml") return maskHashComments(src);
  if (kind === "md") return maskOutsideFences(src);
  return src;
}

function blank(s) {
  return s.replace(/[^\n]/g, " ");
}

function maskSlashComments(s) {
  const n = s.length;
  const ranges = [];
  let i = 0;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 47) { // '/'
      const d = s.charCodeAt(i + 1);
      if (d === 47) { let j = s.indexOf("\n", i); if (j < 0) j = n; ranges.push([i, j]); i = j; continue; }
      if (d === 42) { let j = s.indexOf("*/", i + 2); j = j < 0 ? n : j + 2; ranges.push([i, j]); i = j; continue; }
      i++; continue;
    }
    if (c === 34 || c === 39 || c === 96) { i = skipString(s, i, n) + 1; continue; }
    i++;
  }
  if (!ranges.length) return s;
  let out = "";
  let last = 0;
  for (const [a, b] of ranges) { out += s.slice(last, a) + blank(s.slice(a, b)); last = b; }
  return out + s.slice(last);
}

function maskHashComments(s) {
  return s.replace(/^[^\n]*$/gm, (line) => {
    let q = 0;
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i);
      if (q) { if (c === 92 && q === 34) { i++; continue; } if (c === q) q = 0; continue; }
      if (c === 34 || c === 39) { q = c; continue; }
      if (c === 35 && (i === 0 || line.charCodeAt(i - 1) === 32 || line.charCodeAt(i - 1) === 9)) {
        return line.slice(0, i) + " ".repeat(line.length - i);
      }
    }
    return line;
  });
}

// Markdown: only fenced code blocks count as commands; prose is blanked.
function maskOutsideFences(s) {
  let inFence = false;
  return s.replace(/^[^\n]*$/gm, (line) => {
    if (/^\s{0,3}(```|~~~)/.test(line)) { inFence = !inFence; return blank(line); }
    return inFence ? line : blank(line);
  });
}

/** Index of the closing quote of the string starting at i (or the limit). ' and " stop at a newline. */
export function skipString(s, i, lim) {
  const q = s.charCodeAt(i);
  for (let j = i + 1; j < lim; j++) {
    const e = s.charCodeAt(j);
    if (e === 92) { j++; continue; }
    if (e === q) return j;
    if (e === 10 && q !== 96) return j;
  }
  return lim - 1;
}

/** Given s[open] in ( [ {, return the index just past its matching closer, or -1. */
export function balancedEnd(s, open, max = 4000) {
  const first = OPEN[s.charCodeAt(open)];
  if (!first) return -1;
  const stack = [first];
  const lim = Math.min(s.length, open + max);
  for (let i = open + 1; i < lim; i++) {
    const c = s.charCodeAt(i);
    if (c === 34 || c === 39 || c === 96) { i = skipString(s, i, lim); continue; }
    if (OPEN[c]) stack.push(OPEN[c]);
    else if (c === 41 || c === 93 || c === 125) {
      if (stack.pop() !== c) return -1;
      if (!stack.length) return i + 1;
    }
  }
  return -1;
}

/** Body between s[open] and its closer; falls back to a bounded window when unbalanced (edit fragments). */
export function bodyFrom(s, open, max = 4000) {
  const end = balancedEnd(s, open, max);
  if (end < 0) return s.slice(open + 1, Math.min(s.length, open + 1 + Math.min(max, 800)));
  return s.slice(open + 1, end - 1);
}

/** Index of the '{' (or other opener) that encloses position idx, searching back at most max chars. */
export function enclosingOpen(s, idx, opener = "{", max = 1500) {
  const close = { "{": "}", "(": ")", "[": "]" }[opener];
  let depth = 0;
  for (let i = idx - 1; i >= 0 && i >= idx - max; i--) {
    const ch = s[i];
    if (ch === close) depth++;
    else if (ch === opener) { if (depth === 0) return i; depth--; }
  }
  return -1;
}

/** Split a call-argument or object body on top-level commas. */
export function splitTopLevel(body) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body.charCodeAt(i);
    if (c === 34 || c === 39 || c === 96) { i = skipString(body, i, body.length); continue; }
    if (OPEN[c]) depth++;
    else if (c === 41 || c === 93 || c === 125) depth--;
    else if (c === 44 && depth === 0) { parts.push(body.slice(start, i)); start = i + 1; }
  }
  parts.push(body.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p.length);
}

/** Top-level entries of an object literal body: Map key -> value text (shorthand maps to the key). */
export function objectEntries(body) {
  const map = new Map();
  for (const part of splitTopLevel(body)) {
    if (part.startsWith("...")) continue;
    const m = /^["']?([A-Za-z_$][\w$]*)["']?\s*(:)?/.exec(part);
    if (!m) continue;
    if (map.has(m[1])) continue;
    map.set(m[1], m[2] ? part.slice(m[0].length).trim() : m[1]);
  }
  return map;
}

/** const/let/var (and simple Solidity) assignments: Map name -> right-hand side text (first one wins). */
export function assignments(src) {
  const out = new Map();
  const re = /\b(?:(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=;\n]{1,60})?|(?:u?int\d*|address|bytes32|bytes)\s+(?:(?:constant|immutable|public|private|internal)\s+)*([A-Za-z_$][\w$]*))\s*=(?![=>])\s*/g;
  let m;
  let guard = 0;
  while ((m = re.exec(src)) && guard++ < 2000) {
    const name = m[1] || m[2];
    if (out.has(name)) continue;
    out.set(name, rhsAt(src, re.lastIndex));
  }
  return out;
}

/** Expression text starting at `start`, ending at a top-level , ; newline or unmatched closer. */
export function exprAt(s, start) {
  return rhsAt(s, start);
}

function rhsAt(s, start) {
  const lim = Math.min(s.length, start + 600);
  let depth = 0;
  for (let i = start; i < lim; i++) {
    const c = s.charCodeAt(i);
    if (c === 34 || c === 39 || c === 96) { i = skipString(s, i, lim); continue; }
    if (OPEN[c]) depth++;
    else if (c === 41 || c === 93 || c === 125) { if (depth === 0) return s.slice(start, i).trim(); depth--; }
    else if ((c === 59 || c === 10 || c === 44) && depth === 0) {
      if (c === 10 && i === start) continue;
      return s.slice(start, i).trim();
    }
  }
  return s.slice(start, lim).trim();
}

/** Evaluate a small integer expression (literals, _, n suffix, hex, 1e9, BigInt(), *, **). BigInt or null. */
export function evalInt(expr, consts, depth = 0) {
  if (expr == null || depth > 3) return null;
  let e = String(expr).trim().replace(/\s+as\s+[\w<>\[\]]+$/, "");
  while (/^\(.*\)$/s.test(e) && balancedEnd(e, 0, e.length + 1) === e.length) e = e.slice(1, -1).trim();
  let m = /^BigInt\(\s*(.+)\s*\)$/s.exec(e);
  if (m) return evalInt(m[1].replace(/^['"`]|['"`]$/g, ""), consts, depth + 1);
  m = /^['"`](0x[0-9a-fA-F]+|\d+)['"`]$/.exec(e);
  if (m) e = m[1];
  if (/^\d[\d_]*n?$/.test(e)) return BigInt(e.replace(/[_n]/g, ""));
  if (/^0x[0-9a-fA-F]+n?$/.test(e)) return BigInt(e.replace(/n$/, ""));
  m = /^(\d+)(?:\.(\d+))?e(\d+)$/i.exec(e);
  if (m) {
    const frac = m[2] || "";
    const exp = Number(m[3]) - frac.length;
    if (exp < 0) return null;
    return BigInt(m[1] + frac) * 10n ** BigInt(exp);
  }
  if (consts && /^[A-Za-z_$][\w$]*$/.test(e) && consts.has(e)) return evalInt(consts.get(e), consts, depth + 1);
  const pow = splitOp(e, "**");
  if (pow) {
    const a = evalInt(pow[0], consts, depth + 1);
    const b = evalInt(pow[1], consts, depth + 1);
    return a != null && b != null && b < 80n ? a ** b : null;
  }
  const mul = splitOp(e, "*");
  if (mul) {
    const a = evalInt(mul[0], consts, depth + 1);
    const b = evalInt(mul[1], consts, depth + 1);
    return a != null && b != null ? a * b : null;
  }
  return null;
}

// Split on the first top-level operator (op = "*" or "**").
function splitOp(e, op) {
  let depth = 0;
  for (let i = 0; i < e.length; i++) {
    const c = e[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (depth === 0 && c === "*") {
      const isPow = e[i + 1] === "*";
      if (op === "**" && isPow) return [e.slice(0, i), e.slice(i + 2)];
      if (op === "*" && !isPow && e[i - 1] !== "*") return [e.slice(0, i), e.slice(i + 1)];
      if (isPow) i++;
    }
  }
  return null;
}

/** 1-based line number of index idx in s. */
export function lineAt(s, idx) {
  let n = 1;
  for (let i = s.indexOf("\n"); i >= 0 && i < idx; i = s.indexOf("\n", i + 1)) n++;
  return n;
}

// Normalizes a PostToolUse hook payload into [{ file, text, line }].
//   Claude Code: tool_input.{file_path, content (Write), new_string (Edit), edits[].new_string (legacy MultiEdit)}
//   Codex:       tool_name "apply_patch", tool_input.command = patch text; only "*** Add File:" /
//                "*** Update File:" headers (and "*** Move to:") plus "+" lines are read.
// `line` is the 1-based start line in the file when known (Write = 1), else null; the guard locates
// the text in the written file later. Pure: no I/O.
import path from "node:path";

const MAX_TEXT = 512 * 1024;

export function normalizePayload(payload) {
  if (!payload || typeof payload !== "object") return [];
  const cwd = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : process.cwd();
  const ti = payload.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : {};
  const patch = patchText(payload.tool_name, ti);
  if (patch != null) return parseApplyPatch(patch, cwd);

  const file = typeof ti.file_path === "string" && ti.file_path ? path.resolve(cwd, ti.file_path) : null;
  if (!file) return [];
  const out = [];
  if (typeof ti.content === "string") out.push({ file, text: cap(ti.content), line: 1 });
  if (typeof ti.new_string === "string") out.push({ file, text: cap(ti.new_string), line: null });
  if (Array.isArray(ti.edits)) {
    for (const e of ti.edits) {
      if (e && typeof e.new_string === "string") out.push({ file, text: cap(e.new_string), line: null });
    }
  }
  return out.filter((c) => c.text.trim().length > 0);
}

function patchText(toolName, ti) {
  const v = ti.command ?? ti.patch ?? ti.input;
  const isPatchTool = toolName === "apply_patch";
  let s = null;
  if (typeof v === "string") s = v;
  else if (Array.isArray(v)) s = v.filter((x) => typeof x === "string").join("\n");
  if (s == null) return null;
  if (isPatchTool || /^\*\*\* Begin Patch/m.test(s)) return s;
  return null;
}

/** Parse Codex apply_patch text. Each contiguous run of "+" lines becomes one chunk. */
export function parseApplyPatch(patch, cwd) {
  const out = [];
  let file = null;
  let run = [];
  let isAdd = false;
  const flush = () => {
    if (file && run.length) out.push({ file, text: cap(run.join("\n")), line: isAdd && out.every((c) => c.file !== file) ? 1 : null });
    run = [];
  };
  for (const raw of String(patch).split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const h = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (h) {
      flush();
      file = h[1] === "Delete" ? null : path.resolve(cwd, h[2].trim());
      isAdd = h[1] === "Add";
      continue;
    }
    const mv = /^\*\*\* Move to: (.+)$/.exec(line);
    if (mv) {
      flush();
      if (file) file = path.resolve(cwd, mv[1].trim());
      continue;
    }
    if (line.startsWith("***")) { flush(); if (/^\*\*\* End Patch/.test(line)) file = null; continue; }
    if (!file) continue;
    if (line.startsWith("+")) run.push(line.slice(1));
    else flush();
  }
  flush();
  return out.filter((c) => c.text.trim().length > 0);
}

function cap(s) {
  return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) : s;
}

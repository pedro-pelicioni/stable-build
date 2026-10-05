// SessionStart notice for stable-build (Claude Code and Codex). Runs through run.sh, so only after consent.
// Prints only inside an Arc project. Plain stdout becomes session context on both hosts.
//   - Line 1, at most 400 characters: the notice, in the language saved in $STABLE_BUILD_HOME/config.json
//     ("en" or "pt-BR"; English when none is saved).
//   - Line 2, only when a language other than English is saved: one English instruction for the agent
//     to reply in that language, so plain turns follow it too, not only the skills (whose
//     "## Language" section reads the same setting). With English or nothing saved the output is
//     the notice alone, unchanged.
// Read-only; always exits 0.
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { findProject, detectArc, loadGuardConfig } from "./guard/project.mjs";
import { readLanguage } from "./guard/prefs.mjs";

export const MAX_NOTICE = 400;
export const MAX_WHERE = 48;

const NOTICES = {
  en: {
    on: (where) => `stable-build: Arc project detected (${where}). The edit-time guard checks lines you add against 10 Arc rules from docs.arc.io and reports findings as a one-line advisory notice plus context for the agent, never as an error; it never blocks or undoes an edit. Use the stable-build gotchas skill to explain a rule id, scan the repo, or turn the guard off.`,
    off: (where) => `stable-build: Arc project detected (${where}). The edit-time Arc guard is turned off for this project in .stable-build/guard.json. The stable-build gotchas skill can still explain Arc pitfalls by rule id and scan the repo.`,
  },
  "pt-BR": {
    on: (where) => `stable-build: projeto Arc detectado (${where}). O guard de edição confere as linhas adicionadas com 10 regras da Arc (docs.arc.io) e informa achados como aviso de uma linha mais contexto para o agente, nunca como erro; nunca bloqueia nem desfaz a edição. Use a skill gotchas do stable-build para explicar um id de regra, varrer o repo ou desligar o guard.`,
    off: (where) => `stable-build: projeto Arc detectado (${where}). O guard de edição da Arc está desligado neste projeto em .stable-build/guard.json. A skill gotchas do stable-build ainda explica as pegadinhas da Arc por id de regra e varre o repo.`,
  },
};

// For the agent, so in English whatever the saved language. Keeps to the same boundaries as the
// skills' "## Language" section: prose in the saved language, code and quoted docs as they are.
const REPLY_LANGUAGE = {
  "pt-BR": "stable-build: the user's saved language is pt-BR. Write your replies to the user in Brazilian Portuguese, even when they write in English, unless they ask for another language. Keep code, identifiers, commands, file names, rule ids and docs quotes as they are.",
};

/** The agent instruction for a saved language, or "" for English, none or an unknown value. */
export function replyLanguageLine(lang) {
  return typeof lang === "string" && Object.hasOwn(REPLY_LANGUAGE, lang) ? REPLY_LANGUAGE[lang] : "";
}

/** The notice for a detected marker; `off` when .stable-build/guard.json turns every rule off. */
export function formatSessionNotice(marker, off, lang = "en") {
  const t = Object.hasOwn(NOTICES, lang) ? NOTICES[lang] : NOTICES.en;
  const where = marker.length > MAX_WHERE ? `${marker.slice(0, MAX_WHERE - 3)}...` : marker;
  const text = off ? t.off(where) : t.on(where);
  return text.length > MAX_NOTICE ? `${text.slice(0, MAX_NOTICE - 3)}...` : text;
}

/** The full SessionStart output without its final newline: "" outside an Arc project. */
export function sessionNotice(cwd, env = process.env) {
  const proj = findProject(cwd, env);
  const marker = detectArc(proj);
  if (!marker) return "";
  const lang = readLanguage(env);
  const reply = replyLanguageLine(lang);
  const notice = formatSessionNotice(marker, loadGuardConfig(proj).all, lang);
  return reply ? `${notice}\n${reply}` : notice;
}

function main() {
  let payload = {};
  if (!process.stdin.isTTY) {
    try { payload = JSON.parse(readFileSync(0, "utf8") || "{}") || {}; } catch { payload = {}; }
  }
  const cwd = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : process.cwd();
  const text = sessionNotice(cwd);
  if (text) process.stdout.write(`${text}\n`);
}

function isMain() {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isMain()) {
  try { main(); } catch { /* fail open */ }
  process.exitCode = 0;
}

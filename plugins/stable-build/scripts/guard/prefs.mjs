// User preferences in $STABLE_BUILD_HOME/config.json that the hooks read. Guard consent ("guard")
// lives in the same file but belongs to consent.mjs and run.sh; nothing here grants or implies it.
//   - "language": "en" | "pt-BR", written by install.sh. It picks the language of the two texts the
//     user sees from the hooks: the guard's one-line systemMessage and the SessionStart notice. With
//     pt-BR saved, SessionStart also adds an English line asking the agent to reply in Brazilian
//     Portuguese. The agent-facing additionalContext, rule ids and docs quotes stay in English.
// Read-only and never throws: a missing, unreadable or malformed file, or an unknown value, reads as
// null (no preference), and callers keep the English text they printed before this setting existed.
import { readFileSync } from "node:fs";
import path from "node:path";
import { stableBuildHome } from "./project.mjs";

export const LANGUAGES = Object.freeze(["en", "pt-BR"]);

// The installer's accepted spellings (case-insensitive), so a hand-edited value still reads right.
const ALIASES = new Map([
  ["en", "en"], ["english", "en"],
  ["pt", "pt-BR"], ["pt-br", "pt-BR"], ["pt_br", "pt-BR"], ["portugues", "pt-BR"], ["português", "pt-BR"],
]);

/** "en" | "pt-BR" for a supported spelling, otherwise null. */
export function normalizeLanguage(value) {
  if (typeof value !== "string") return null;
  return ALIASES.get(value.normalize("NFC").trim().toLowerCase()) ?? null;
}

/** The saved language ("en" | "pt-BR"), or null when none is saved or it cannot be read. */
export function readLanguage(env = process.env) {
  try {
    const raw = readFileSync(path.join(stableBuildHome(env), "config.json"), "utf8");
    const j = JSON.parse(raw);
    return j && typeof j === "object" && !Array.isArray(j) ? normalizeLanguage(j.language) : null;
  } catch {
    return null;
  }
}

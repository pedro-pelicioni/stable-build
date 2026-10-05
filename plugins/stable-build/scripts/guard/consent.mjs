// Guard consent in $STABLE_BUILD_HOME/config.json ({"schemaVersion":1,"guard":true,"consentAt":...}).
// Only `guard.mjs --enable/--disable` writes here, and only after the user confirmed in chat.
// Hook mode never writes. Writes are atomic (tmp file + rename) and keep unknown keys.
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { stableBuildHome } from "./project.mjs";

export function configPath(env = process.env) {
  return path.join(stableBuildHome(env), "config.json");
}

/** { exists, config, error } — never throws. */
export function readConfig(env = process.env) {
  const file = configPath(env);
  if (!existsSync(file)) return { file, exists: false, config: null, error: null };
  try {
    const config = JSON.parse(readFileSync(file, "utf8"));
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("not a JSON object");
    return { file, exists: true, config, error: null };
  } catch (e) {
    return { file, exists: true, config: null, error: String(e.message || e) };
  }
}

/**
 * The test run.sh applies before starting node: grep -E '"guard"[[:space:]]*:[[:space:]]*true',
 * which matches within one line (any spaces or tabs around the colon, no newline).
 */
export const CONSENT_GATE = /"guard"[ \t\r\f\v]*:[ \t\r\f\v]*true/;

export function guardEnabled(env = process.env) {
  try {
    return CONSENT_GATE.test(readFileSync(configPath(env), "utf8"));
  } catch {
    return false;
  }
}

/** Set "guard" to on/off. Refuses to overwrite a config.json that is not valid JSON. */
export function writeConsent(on, env = process.env) {
  const cur = readConfig(env);
  if (cur.error) throw new Error(`${cur.file} is not valid JSON (${cur.error}); fix or remove it first`);
  const next = { ...(cur.config || {}), schemaVersion: 1, guard: Boolean(on) };
  if (on) { next.consentAt = new Date().toISOString(); delete next.revokedAt; }
  else next.revokedAt = new Date().toISOString();
  const dir = path.dirname(cur.file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.config.json.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(next) + "\n", { mode: 0o600 });
  renameSync(tmp, cur.file);
  return { file: cur.file, config: next };
}

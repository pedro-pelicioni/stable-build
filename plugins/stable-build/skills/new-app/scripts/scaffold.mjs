#!/usr/bin/env node
// stable-build new-app scaffolder. Copies a starter template into an empty
// directory, fills {{APP_NAME}} and writes .stable-build/project.json.
// It never runs git, npm or any network call. The agent asks the user first,
// then runs those itself.
//
//   node scaffold.mjs --list [--json]
//   node scaffold.mjs --starter payouts --dir ./my-payouts --name my-payouts [--json]
//
// Exit codes: 0 ok; 1 bad arguments; 2 target directory is not empty; 3 internal error.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES = path.resolve(HERE, "..", "templates");
const PLUGIN_ROOT = path.resolve(HERE, "..", "..", "..");
const PLACEHOLDER = "{{APP_NAME}}";
const SKIP = new Set(["node_modules", "dist", "ledgers", ".env", ".DS_Store", "coverage"]);

export const STARTERS = {
  payouts: {
    title: "Payouts / payroll from a CSV",
    summary:
      "Vite + React + viem static app and Node CLI. Pays a CSV of recipients in USDC: one Memo per row, batched through Multicall3From, each row reconciled against its receipt, with an 18-decimal ledger. Testnet by default; mainnet gated.",
    templateVersion: 1,
    docs: [
      "https://docs.arc.io/arc/tutorials/send-usdc-with-transaction-memo",
      "https://docs.arc.io/arc/tutorials/batch-usdc-transfers",
    ],
  },
};

const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;

export function validateName(name) {
  if (typeof name !== "string" || !NAME_RE.test(name)) return "name must be lowercase letters, digits and dashes (1-50 chars), starting and ending with a letter or digit";
  if (name.includes("--")) return "name must not contain a double dash";
  return null;
}

function isBinary(buf) {
  return buf.subarray(0, Math.min(buf.length, 8000)).includes(0);
}

function copyTree(src, dest, name) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isSymbolicLink()) continue; // templates never ship links
    if (entry.isDirectory()) {
      copyTree(from, to, name);
      continue;
    }
    const buf = readFileSync(from);
    const out = isBinary(buf) ? buf : Buffer.from(buf.toString("utf8").split(PLACEHOLDER).join(name), "utf8");
    writeFileSync(to, out, { flag: "wx", mode: statSync(from).mode & 0o777 });
  }
}

/** Real path of `p`; when it does not exist yet, the real path of its nearest existing ancestor plus the rest. */
function realTarget(p) {
  let cur = path.resolve(p);
  const rest = [];
  while (!existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    rest.unshift(path.basename(cur));
    cur = parent;
  }
  let real = cur;
  try { real = realpathSync(cur); } catch { /* keep the resolved path */ }
  return path.join(real, ...rest);
}

const within = (child, parent) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

function listFiles(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(p, base, out);
    else out.push(path.relative(base, p));
  }
  return out;
}

/** Scaffolds `starter` into `dir`. Throws {code:2} when dir is not empty. */
export function scaffold({ starter, dir, name }) {
  const meta = STARTERS[starter];
  if (!meta) throw Object.assign(new Error(`unknown starter "${starter}"; available: ${Object.keys(STARTERS).join(", ")}`), { exitCode: 1 });
  const nameError = validateName(name);
  if (nameError) throw Object.assign(new Error(nameError), { exitCode: 1 });
  const source = path.join(TEMPLATES, starter);
  if (!existsSync(source)) throw Object.assign(new Error(`template folder missing: ${source}`), { exitCode: 3 });
  const target = path.resolve(dir);
  // Checked whether or not the target exists yet: a new folder inside the template would copy the
  // template into itself, and anything inside the installed plugin would be lost on its next update.
  if (within(realTarget(target), realTarget(PLUGIN_ROOT)))
    throw Object.assign(new Error(`refusing to scaffold inside the stable-build plugin folder (${realTarget(PLUGIN_ROOT)}); pass --dir with an absolute path in the user's project`), { exitCode: 1 });
  if (existsSync(target)) {
    if (!lstatSync(target).isDirectory()) throw Object.assign(new Error(`${target} exists and is not a directory`), { exitCode: 2 });
    const entries = readdirSync(target);
    if (entries.length > 0)
      throw Object.assign(new Error(`${target} is not empty (${entries.slice(0, 5).join(", ")}${entries.length > 5 ? ", …" : ""}); choose an empty or new directory`), { exitCode: 2 });
  }
  mkdirSync(target, { recursive: true });
  copyTree(source, target, name);
  const project = { template: starter, templateVersion: meta.templateVersion, network: "testnet", app: name };
  mkdirSync(path.join(target, ".stable-build"), { recursive: true });
  writeFileSync(path.join(target, ".stable-build", "project.json"), JSON.stringify(project, null, 2) + "\n");
  const files = listFiles(target).sort();
  const leftovers = files.filter((f) => {
    const buf = readFileSync(path.join(target, f));
    return !isBinary(buf) && buf.toString("utf8").includes(PLACEHOLDER);
  });
  if (leftovers.length > 0) throw Object.assign(new Error(`placeholder left in ${leftovers.join(", ")}`), { exitCode: 3 });
  return { dir: target, starter, name, project, files, docs: meta.docs };
}

function main() {
  let args;
  try {
    args = parseArgs({
      options: {
        list: { type: "boolean", default: false },
        starter: { type: "string" },
        dir: { type: "string" },
        name: { type: "string" },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    }).values;
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }
  if (args.help || (!args.list && !(args.starter && args.dir && args.name))) {
    console.log("usage: scaffold.mjs --list [--json]\n       scaffold.mjs --starter <name> --dir <empty or new directory> --name <app-name> [--json]");
    process.exit(args.help ? 0 : 1);
  }
  if (args.list) {
    const rows = Object.entries(STARTERS).map(([id, m]) => ({ id, ...m }));
    if (args.json) console.log(JSON.stringify(rows, null, 2));
    else for (const r of rows) console.log(`${r.id}: ${r.title}\n  ${r.summary}\n  docs: ${r.docs.join(" , ")}`);
    return;
  }
  try {
    const result = scaffold({ starter: args.starter, dir: args.dir, name: args.name });
    if (args.json) console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    else {
      console.log(`created ${result.dir} from starter "${result.starter}" (${result.files.length} files)`);
      console.log(`wrote .stable-build/project.json: ${JSON.stringify(result.project)}`);
      console.log("not run yet (ask the user first): git init, npm install, npm test");
    }
  } catch (err) {
    if (args.json) console.log(JSON.stringify({ ok: false, error: err.message, exitCode: err.exitCode ?? 3 }));
    else console.error(`error: ${err.message}`);
    process.exit(err.exitCode ?? 3);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

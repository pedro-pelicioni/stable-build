#!/usr/bin/env node
// Static evidence collector for the go-live gates G1-G14 (see ../references/checklist.md).
// Read-only: it reads files, runs `git` read commands and the stable-build guard scan, and with
// --online makes read-only JSON-RPC calls (eth_chainId, eth_getCode) to Arc's public RPCs and
// `gh repo view`. It never writes files, never deploys, never signs, and redacts key material.
//
// Usage: node evidence.mjs [--dir=.] [--format=md|json] [--online] [--address=0x..]... [--plugin-root=DIR]
// Exit: 0 when no gate failed, 1 when at least one gate failed, 2 on usage errors.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const opt = { dir: ".", format: "md", online: false, addresses: [], pluginRoot: null };
for (const a of argv) {
  const [k, ...rest] = a.replace(/^--/, "").split("=");
  const v = rest.join("=");
  if (k === "dir") opt.dir = v;
  else if (k === "format" && ["md", "json"].includes(v)) opt.format = v;
  else if (k === "online") opt.online = true;
  else if (k === "address" && /^0x[0-9a-fA-F]{40}$/.test(v)) opt.addresses.push(v);
  else if (k === "plugin-root") opt.pluginRoot = v;
  else if (k === "help") {
    console.log("usage: node evidence.mjs [--dir=.] [--format=md|json] [--online] [--address=0x..] [--plugin-root=DIR]");
    process.exit(0);
  } else {
    console.error(`unknown or invalid option: ${a}`);
    process.exit(2);
  }
}
const ROOT = path.resolve(opt.dir);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(opt.pluginRoot || path.join(HERE, "..", "..", ".."));
const DOCS = {
  evm: "https://docs.arc.io/arc/references/evm-differences",
  foundry: "https://docs.arc.io/arc/tutorials/install-arc-foundry",
  rpc: "https://docs.arc.io/arc/references/rpc-endpoints",
  addr: "https://docs.arc.io/arc/references/contract-addresses",
  studio: "https://docs.arc.io/ai/arc-studio-cli",
  deploy: "https://docs.arc.io/arc/tutorials/deploy-on-arc",
  fees: "https://docs.arc.io/arc/references/gas-and-fees",
  feeDisplay: "https://docs.arc.io/integrate/wallets/fee-display",
  connect: "https://docs.arc.io/arc/references/connect-to-arc",
  wallets: "https://docs.arc.io/integrate/wallets",
  deposits: "https://docs.arc.io/integrate/exchanges/deposits",
  sysev: "https://docs.arc.io/arc/references/usdc-system-events",
  memo: "https://docs.arc.io/arc/concepts/transaction-memos",
  batch: "https://docs.arc.io/arc/concepts/batched-transactions",
  lifecycle: "https://docs.arc.io/integrate/wallets/transaction-lifecycle",
  stellar: "https://developers.circle.com/cctp/references/stellar",
  compliance: "https://docs.arc.io/integrate/infrastructure/compliance",
  terms: "https://docs.arc.io/terms",
};

// ---------- collect text files ----------
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", ".next", ".turbo", ".cache", "cache", "coverage",
  "artifacts", "typechain-types", "vendor", ".venv", "target", "broadcast", ".vercel"]);
const TEXT = /\.(ts|tsx|js|jsx|mjs|cjs|sol|json|toml|ya?ml|md|sh|bash|zsh|html|vue|svelte|py|rs|go|txt|env[\w.-]*)$|(^|\/)(Makefile|Dockerfile|justfile|\.env[\w.-]*)$/i;
// Local .env files are never read (they may hold keys); only .env.example/.sample/.template are.
const SKIP_FILE = /(^|\/)\.env(?!\.(example|sample|template)$)(\.[\w.-]+)?$|(^|\/)docs\/go-live-report\.md$|package-lock\.json$|\.(pem|key)$/i;
const hasFoundry = existsSync(path.join(ROOT, "foundry.toml"));
// Comments are blanked so that warnings written in comments ("never use wallet_sendCalls") are not
// read as usage. Line numbers are kept.
function codeView(rel, lines) {
  if (/\.(ts|tsx|js|jsx|mjs|cjs|sol|go|rs|vue|svelte)$/i.test(rel)) {
    let block = false;
    return lines.map((l) => {
      let out = "";
      let rest = l;
      while (rest.length) {
        if (block) {
          const end = rest.indexOf("*/");
          if (end < 0) { rest = ""; break; }
          block = false;
          rest = rest.slice(end + 2);
        } else {
          const start = rest.search(/\/\*/);
          const line = rest.search(/(^|[^:\\])\/\//);
          if (line >= 0 && (start < 0 || line < start)) { out += rest.slice(0, line + (rest[line] === "/" ? 0 : 1)); rest = ""; break; }
          if (start < 0) { out += rest; rest = ""; break; }
          out += rest.slice(0, start);
          rest = rest.slice(start + 2);
          block = true;
        }
      }
      return out;
    });
  }
  if (/\.(py|sh|bash|zsh|ya?ml|toml)$|(^|\/)(Makefile|Dockerfile|justfile)$/i.test(rel)) return lines.map((l) => (/^\s*#/.test(l) ? "" : l));
  return lines;
}
const files = [];
(function walk(dir, depth) {
  if (depth > 12 || files.length >= 4000) return;
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    const rel = path.relative(ROOT, abs).split(path.sep).join("/");
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || (hasFoundry && rel === "lib")) continue;
      walk(abs, depth + 1);
    } else if (e.isFile() && TEXT.test(rel) && !SKIP_FILE.test(rel)) {
      try {
        if (statSync(abs).size > 512 * 1024) continue;
        const lines = readFileSync(abs, "utf8").split(/\r?\n/);
        files.push({ rel, lines, code: codeView(rel, lines) });
      } catch { /* unreadable: skip */ }
    }
  }
})(ROOT, 0);

const isOps = (r) => /(^|\/)(\.github\/workflows\/[^/]+\.ya?ml|Makefile|Dockerfile|justfile|[^/]+\.(sh|bash|zsh)|package\.json|[^/]+\.md|foundry\.toml)$/i.test(r);
const isUi = (r) => /\.(tsx|jsx|vue|svelte|html)$/i.test(r);
const isSol = (r) => /\.sol$/i.test(r);
const isTest = (r) => /(^|\/)(test|tests|__tests__|spec)\/|\.(test|spec|t)\.(ts|tsx|js|jsx|mjs|sol)$/i.test(r);
const isCode = (r) => /\.(ts|tsx|js|jsx|mjs|cjs|sol|vue|svelte|py|rs|go)$/i.test(r) && !isTest(r);
const isDoc = (r) => /\.md$/i.test(r) || isUi(r);

// What counts as "commands" in ops files: code in Markdown, non-comment lines elsewhere.
function opsLines(f) {
  if (!/\.md$/i.test(f.rel)) return f.lines.map((l) => (/^\s*(#|\/\/)/.test(l) ? "" : l));
  let fence = false;
  return f.lines.map((l) => {
    if (/^\s*(```|~~~)/.test(l)) { fence = !fence; return ""; }
    if (fence) return l;
    return [...l.matchAll(/`([^`]+)`/g)].map((m) => m[1]).join(" ; ");
  });
}
function redact(s) {
  let t = s.trim().replace(/0x[0-9a-fA-F]{64}\b/g, "0x<redacted 64-hex>");
  if (/(private[_-]?key|mnemonic|seed[_ -]?phrase|secret)/i.test(t)) t = t.replace(/([=:]\s*).+$/, "$1<redacted>");
  return t.length > 160 ? t.slice(0, 157) + "..." : t;
}
// find(regex, filter) -> [{file, line, text}] (at most `max`); view(f) can narrow what is searched
function find(re, filter = () => true, max = 50, view = (f) => f.code) {
  const out = [];
  for (const f of files) {
    if (!filter(f.rel)) continue;
    view(f).forEach((l, i) => {
      if (out.length < max && re.test(l)) out.push({ file: f.rel, line: i + 1, text: redact(f.lines[i]) });
    });
  }
  return out;
}
const fileHas = (rel, re) => files.find((f) => f.rel === rel)?.code.some((l) => re.test(l));
const raw = (f) => f.lines;
const filesWith = (re, filter = () => true) => new Set(find(re, filter, 100000).map((h) => h.file));
function sh(cmd, args, timeout = 60_000) {
  try {
    return { code: 0, out: execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (e) {
    return { code: typeof e.status === "number" ? e.status : -1, out: `${e.stdout || ""}${e.stderr || ""}` || e.message };
  }
}
async function rpc(url, method, params) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "stable-build-go-live (read-only)" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${j.error.code} ${j.error.message}`);
  return j.result;
}
const RPC = { mainnet: "https://rpc.mainnet.arc.io", testnet: "https://rpc.testnet.arc.io" };

// ---------- project facts ----------
const sol = files.filter((f) => isSol(f.rel));
const ui = files.filter((f) => isUi(f.rel));
const anyCode = files.some((f) => isCode(f.rel));
const hasHardhat = files.some((f) => /(^|\/)hardhat\.config\.(js|ts|cjs|mjs)$/.test(f.rel));
let project = null;
try { project = JSON.parse(readFileSync(path.join(ROOT, ".stable-build", "project.json"), "utf8")); } catch { /* optional */ }
const gates = [];
const gate = (id, title, status, evidence, notes, docs, manual = []) =>
  gates.push({ id, title, status, evidence: evidence.slice(0, 12), notes, manual, docs });

// G1 -------------------------------------------------------------------
// Arc Foundry runs Ethereum rules unless Arc mode is selected: `--network arc`, a FOUNDRY_PROFILE whose
// foundry.toml profile sets network = "arc" (or the default profile does), or a fork of an Arc RPC
// (circlefin/arc-foundry README: "arc-forge test  # Ethereum", "FOUNDRY_PROFILE=arc arc-forge test  # Arc").
function foundryArcProfiles(toml) {
  const sections = new Map();
  let cur = null;
  for (const rawLine of String(toml).split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$|^#.*$/, "").trim();
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
let arcProfiles = null; // null: foundry.toml not read
try { arcProfiles = foundryArcProfiles(readFileSync(path.join(ROOT, "foundry.toml"), "utf8")); } catch { /* none */ }
const fileEnvProfile = (rel) => {
  const f = files.find((x) => x.rel === rel);
  const m = f && f.code.join("\n").match(/\bFOUNDRY_PROFILE\s*(?::=|[:=])\s*["']?([\w-]+)/);
  return m ? m[1] : null;
};
// "on" | "off" | "unknown" for one arc-forge/arc-anvil command line
function arcMode(h) {
  const t = files.find((f) => f.rel === h.file).lines[h.line - 1];
  const at = t.search(/arc-(?:forge|anvil)/);
  const cmd = t.slice(at).split(/&&|\|\||[;|"]/)[0];
  const prefix = t.slice(0, at);
  if (/--network(?:\s+|=)["']?arc\b/.test(cmd)) return "on";
  const fork = /(?:--fork-url|--rpc-url|\s-f)(?:\s+|=)["']?(\S+)/.exec(cmd);
  if (fork) return /^https?:/.test(fork[1]) && !/arc/i.test(fork[1]) ? "off" : "on";
  if (/\bFOUNDRY_NETWORK\s*[:=]\s*["']?arc\b/.test(prefix)) return "on";
  const p = (/\bFOUNDRY_PROFILE\s*[:=]\s*["']?([\w-]+)/.exec(prefix) || [])[1] || fileEnvProfile(h.file);
  if (p) return arcProfiles ? (arcProfiles.has(p) ? "on" : "off") : "unknown";
  if (!arcProfiles) return "unknown";
  return arcProfiles.has("default") ? "on" : "off";
}
{
  const upstream = find(/\bfoundryup\b|foundry\.paradigm\.xyz|foundry-rs\/foundry-toolchain|(?<![\w-])(forge\s+(test|build|create|script|verify-contract)|anvil|cast\s+send)\b/, isOps, 50, opsLines);
  // `arc-anvil` alone in inline code names the tool ("install `arc-anvil`"); it is not a command
  const mention = (h) => /`arc-anvil`/.test(files.find((f) => f.rel === h.file).lines[h.line - 1]) && !/(?<!`)arc-anvil(?!`)/.test(files.find((f) => f.rel === h.file).lines[h.line - 1]);
  const cmds = find(/(?<![\w./-])arc-(?:forge\s+(?:test|coverage|snapshot)|anvil)\b/, isOps, 50, opsLines).filter((h) => !mention(h)).map((h) => ({ ...h, mode: arcMode(h) }));
  const on = cmds.filter((h) => h.mode === "on");
  const off = cmds.filter((h) => h.mode === "off");
  const unk = cmds.filter((h) => h.mode === "unknown");
  let status, notes, evidence = cmds;
  if (upstream.length) { status = "fail"; evidence = upstream; notes = "Upstream Foundry in scripts, CI or docs; use arc-forge test --network arc / arc-anvil --network arc (or FOUNDRY_PROFILE=arc with [profile.arc] network = \"arc\")."; }
  else if (!sol.length) { status = "n/a"; notes = "No Solidity sources found; no upstream Foundry use found."; }
  else if (off.length) { status = "fail"; evidence = off; notes = "arc-forge / arc-anvil run without Arc mode, which executes Ethereum rules: add --network arc, or FOUNDRY_PROFILE=arc with [profile.arc] network = \"arc\" in foundry.toml."; }
  else if (unk.length) { status = "unknown"; evidence = unk; notes = "arc-forge / arc-anvil found, but no foundry.toml at the project root to confirm the profile selects network = \"arc\"; without --network arc they run Ethereum rules."; }
  else if (on.length) { status = "pass"; notes = "Contract tests run with Arc Foundry in Arc mode."; }
  else { status = "unknown"; notes = hasHardhat ? "Hardhat runs a standard EVM; run the tests against arc-anvil --network arc or Arc Testnet." : arcProfiles && arcProfiles.size ? "An Arc profile exists in foundry.toml, but no arc-forge test command was found in scripts, CI or docs." : "Solidity found but no arc-forge test command."; }
  gate("G1", "Tests run on Arc semantics", status, evidence, notes, [DOCS.evm, DOCS.foundry, "https://github.com/circlefin/arc-foundry"]);
}

// G2 -------------------------------------------------------------------
{
  const guard = path.join(PLUGIN, "scripts", "guard.mjs");
  if (!existsSync(guard)) {
    gate("G2", "Guard scan reports 0 errors", "unknown", [], `Guard not found at ${guard}; run the gotchas skill's scan instead.`, []);
  } else {
    const r = sh(process.execPath, [guard, "--scan", ROOT], 120_000);
    const out = r.out.split(/\r?\n/).filter(Boolean).map(redact);
    // Interface assumption: exit 0 = no error-level findings; non-zero = findings. A stack trace or a
    // spawn failure means the scan itself broke, which is unknown, not fail.
    const crashed = r.code === -1 || /^\s+at .+:\d+:\d+\)?$|SyntaxError|Error \[ERR_|Cannot find module/m.test(r.out);
    const status = r.code === 0 ? "pass" : crashed ? "unknown" : "fail";
    gate("G2", "Guard scan reports 0 errors", status, out.slice(0, 12).map((t) => ({ file: "guard --scan", line: 0, text: t })),
      `node scripts/guard.mjs --scan exited ${r.code}.`, []);
  }
}

// G3 -------------------------------------------------------------------
const TESTNET_ONLY = {
  "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a": "EURC (testnet)",
  "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA": "CCTP TokenMessengerV2 (testnet)",
  "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275": "CCTP MessageTransmitterV2 (testnet)",
  "0x0077777d7EBA4688BDeF3E311b846F25870A19B9": "GatewayWallet (testnet)",
  "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B": "GatewayMinter (testnet)",
  "0xd68256f4D69C6BbEcB873D8588AE0Dc6B8E22E10": "StableFX FxEscrow (testnet)",
  "0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF": "cirBTC (testnet)",
  "0x2c4047028a72803939b6fb674D01bC059B5C4961": "WETH (testnet)",
  "0x8004A818BFB912233c491871b3d84c89A494BD9e": "ERC-8004 IdentityRegistry (testnet)",
  "0x8004B663056A597Dffe9eCcC1965A193B7388713": "ERC-8004 ReputationRegistry (testnet)",
  "0x8004Cb1BF31DAf7788923b405b754f57acEB4272": "ERC-8004 ValidationRegistry (testnet)",
  "0x70997970C51812dc3A010C7d01b50e0d17dc79C8": "testnet blocklisted test address",
  "0x8745D906D67C346E5eb1aEEED38Eb87F34DF0C0A": "CCTP TokenMessengerWithFees (testnet)",
  "0xb43db544E2c27092c107639Ad201b3dEfAbcF192": "CCTP TokenMinterV2 (testnet)",
  "0xbaC0179bB358A8936169a63408C8481D582390C4": "CCTP MessageV2 (testnet)",
  "0x63753E722bd2C2A5DF6EE19C5106662208B81077": "CrossChainTokenService (testnet)",
  "0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C": "USYC (testnet)",
  "0xcc205224862c7641930c87679e98999d23c26113": "USYC Entitlements (testnet)",
  "0x9fdF14c5B14173D74C08Af27AebFf39240dC105A": "USYC Teller (testnet)",
};
let mainnetConfigured = false;
{
  const mainnet = find(/(?<![\w.])5042(?!\d)|0x13b2\b|rpc\.mainnet\.arc\.io|\.mainnet\.arc\.io|arc-mainnet\.g\.alchemy\.com|(?<![\w.-])explorer\.arc\.io|import\s*\{[^}]*\barc\b[^}]*\}\s*from\s*["']viem\/chains["']/, (r) => isCode(r) || (/\.(json|toml|ya?ml)$|(^|\/)\.env/.test(r) && !isTest(r)));
  const testnetAddr = find(new RegExp(Object.keys(TESTNET_ONLY).join("|"), "i"), isCode);
  mainnetConfigured = mainnet.length > 0;
  const notes = [];
  let status;
  if (!mainnet.length) { status = "fail"; notes.push("No mainnet chain config found (chain 5042, mainnet RPC, explorer.arc.io or viem `arc`)."); }
  else if (testnetAddr.length) { status = "unknown"; notes.push("Testnet-only addresses are in code; confirm each is selected only on testnet: " + [...new Set(testnetAddr.map((h) => TESTNET_ONLY[Object.keys(TESTNET_ONLY).find((a) => h.text.toLowerCase().includes(a.toLowerCase()))]))].join(", ")); }
  else { status = "pass"; notes.push("Mainnet config present; no testnet-only addresses in code. USDC, Memo and Multicall3From share addresses across networks."); }
  gate("G3", "Mainnet configuration", status, [...mainnet.slice(0, 6), ...testnetAddr.slice(0, 6)], notes.join(" "), [DOCS.rpc, DOCS.addr]);
}

// G4 -------------------------------------------------------------------
const deployments = []; // {name, address, network, from}
{
  for (const d of Array.isArray(project?.deployments) ? project.deployments : []) {
    if (/^0x[0-9a-fA-F]{40}$/.test(d?.address || "")) deployments.push({ name: String(d.name || "contract").slice(0, 60), address: d.address, network: d.network === "mainnet" ? "mainnet" : "testnet", from: ".stable-build/project.json" });
  }
  const bdir = path.join(ROOT, "broadcast");
  if (existsSync(bdir)) {
    for (const script of readdirSync(bdir)) {
      for (const [chain, network] of [["5042", "mainnet"], ["5042002", "testnet"]]) {
        const f = path.join(bdir, script, chain, "run-latest.json");
        try {
          for (const tx of JSON.parse(readFileSync(f, "utf8")).transactions || [])
            if (tx.contractAddress) deployments.push({ name: String(tx.contractName || "contract").slice(0, 60), address: tx.contractAddress, network, from: path.relative(ROOT, f) });
        } catch { /* none */ }
      }
    }
  }
  for (const a of opt.addresses) deployments.push({ name: "--address", address: a, network: "mainnet", from: "--address" });
}
// Code, config and scripts only (prose such as "Arc Studio cannot deploy to mainnet" is not a deploy path).
const isDeployPath = (r) => (isCode(r) || isOps(r) || /\.(json|toml|ya?ml)$/i.test(r)) && !/\.md$/i.test(r);
const studioMainnet = find(/arc-studio.*mainnet|mainnet.*arc-studio/i, isDeployPath);
const studioDeploy = studioMainnet.filter((h) => /arc-studio\s+(?:run|deploy)\b/i.test(h.text));
const g4 = { status: "unknown", evidence: [...studioDeploy, ...studioMainnet.filter((h) => !studioDeploy.includes(h))], notes: [] };
if (studioDeploy.length) { g4.status = "fail"; g4.notes.push("An arc-studio run/deploy targets mainnet; Arc Studio deploys to testnet only. Mainnet deploys go through arc-forge with a key the human holds."); }
else if (studioMainnet.length) g4.notes.push("Lines mention both arc-studio and mainnet; confirm none of them expects Arc Studio to deploy to mainnet.");

// G5 -------------------------------------------------------------------
{
  const verify = find(/verify-contract|--verifier\s+blockscout/);
  const status = sol.length ? "unknown" : "n/a";
  gate("G5", "Contract source verified on the explorer", status, verify,
    sol.length ? "Confirm each mainnet address shows verified source at https://explorer.arc.io/address/<address>. The mainnet verifier URL is UNVERIFIED; the only documented --verifier-url is the testnet explorer API (deploy-on-arc step 5.2)." : "No Solidity sources found.",
    [DOCS.deploy], sol.length ? ["Open each mainnet address on https://explorer.arc.io and check the Contract tab"] : []);
}

// G6 -------------------------------------------------------------------
{
  // Only the expression bound to maxFeePerGas / gasPrice is read (up to the next top-level , } ; or ).
  const boundExpr = (t, at) => {
    let depth = 0, i = at;
    for (; i < t.length; i++) {
      const c = t[i];
      if ("([{".includes(c)) depth++;
      else if (")]}".includes(c)) { if (!depth) break; depth--; }
      else if ((c === "," || c === ";") && !depth) break;
    }
    return t.slice(at, i).trim();
  };
  const weiOf = (e) => {
    let m = /^(?:[\w$]+\.)*parseGwei\(\s*["'`]?(\d+(?:\.\d+)?)["'`]?\s*\)$/.exec(e);
    if (m) return Number(m[1]) * 1e9;
    m = /^(?:[\w$]+\.)*(?:parseUnits|toWei)\(\s*["'`]?(\d+(?:\.\d+)?)["'`]?\s*,\s*(?:["'`]gwei["'`]|9)\s*\)$/i.exec(e);
    if (m) return Number(m[1]) * 1e9;
    m = /^(\d[\d_]*)n?$/.exec(e);
    if (m) return Number(m[1].replace(/_/g, ""));
    m = /^["'`]?(0x[0-9a-fA-F]+)["'`]?$/.exec(e);
    if (m) return Number(BigInt(m[1]));
    return null; // an expression (base * 2n > FLOOR ? …) is not judged here
  };
  const low = [];
  for (const h of find(/maxFeePerGas|gasPrice|--gas-price/, isCode)) {
    const line = files.find((f) => f.rel === h.file).code[h.line - 1];
    for (const m of line.matchAll(/\b(maxFeePerGas|gasPrice)\s*[:=]\s*|--gas-price\s+/g)) {
      // Hardhat's in-process `hardhat` network and `localhost` never reach Arc's mempool
      if (/\b(?:hardhat|localhost)\s*:\s*\{[^}]*$/.test(line.slice(0, m.index))) continue;
      const wei = weiOf(boundExpr(line, m.index + m[0].length));
      if (wei !== null && wei >= 0 && wei < 20e9) { low.push(h); break; }
    }
  }
  const labels = find(/\b(ETH|Gwei|gwei)\b/, isUi).filter((h) => /fee|gas|cost/i.test(h.text));
  const status = low.length ? "fail" : labels.length ? "unknown" : anyCode ? "pass" : "n/a";
  gate("G6", "Fee floor (20 gwei) and fees shown in USDC", status, [...low, ...labels],
    low.length ? "maxFeePerGas/gasPrice below 20 gwei: the mempool drops it with no receipt." : labels.length ? "Fee labels mention ETH or Gwei; show fees in USDC." : "No explicit fee below 20 gwei; no ETH/Gwei fee labels.",
    [DOCS.evm, DOCS.fees, DOCS.feeDisplay]);
}

// G7 -------------------------------------------------------------------
{
  // fail only when + or += joins the two views on one line; reading both (Promise.all) is not a sum
  const sameLine = find(/getBalance[\s\S]*balanceOf|balanceOf[\s\S]*getBalance/, isCode)
    .filter((h) => /(?<![+])\+(?!\+)/.test(files.find((f) => f.rel === h.file).code[h.line - 1].replace(/(["'`])(?:\\.|(?!\1).)*\1/g, "")));
  const both = [...filesWith(/getBalance/, isCode)].filter((f) => fileHas(f, /balanceOf/));
  const any = find(/getBalance|balanceOf/, isCode, 5);
  const status = sameLine.length ? "fail" : both.length ? "unknown" : any.length ? "pass" : "n/a";
  gate("G7", "One USDC balance; ledger at 18 decimals", status, sameLine.length ? sameLine : both.map((f) => ({ file: f, line: 0, text: "uses both getBalance and balanceOf" })),
    sameLine.length ? "Native (18 dp) and ERC-20 (6 dp) balances added on one line; they are the same balance." : both.length ? "Files read both views; check they are never summed or shown as two rows (the G2 guard scan flags sums across lines)." : any.length ? "Balance reads found; none combine the two views." : "No balance reads found.",
    [DOCS.connect, DOCS.wallets, DOCS.deposits]);
}

// G8 -------------------------------------------------------------------
{
  const reads = find(/\b(getLogs|getContractEvents|queryFilter|eth_getLogs)\b/, isCode, 200);
  const rf = [...new Set(reads.map((h) => h.file))];
  const paged = rf.filter((f) => fileHas(f, /9_?999/));
  const retry = filesWith(/-32014/, isCode).size > 0;
  const unpaged = rf.filter((f) => !paged.includes(f));
  const unbounded = unpaged.filter((f) => fileHas(f, /fromBlock\s*:\s*(0n?\b|["']earliest["']|BigInt\(0\))/));
  let status;
  if (!reads.length) status = "n/a";
  else if (unbounded.length) status = "fail";
  else if (unpaged.length) status = "unknown";
  else if (!retry) status = "unknown";
  else status = "pass";
  gate("G8", "Log reads: 9,999-block paging, emitter, -32014 retry", status,
    unpaged.length ? reads.filter((h) => unpaged.includes(h.file)) : reads,
    !reads.length ? "No log reads found." : unbounded.length ? `Log reads from block 0/earliest without a 9,999-block step in: ${unbounded.join(", ")} (error -32012 past 10,000 blocks).` : unpaged.length ? `No 9,999-block step in: ${unpaged.join(", ")}; confirm every range is at most 9,999 blocks.` : retry ? "Paged log reads with -32014 handling." : "Paged, but no -32014 retry found.",
    [DOCS.rpc, DOCS.sysev]);
}

// G9 -------------------------------------------------------------------
{
  const extRe = /0x5294E9927c3306DcBaDb03fe70b92e01cCede505|0x522fAf9A91c41c443c66765030741e4AaCe147D0|\bMulticall3From\b/i;
  const saRe = /\b(sendUserOperation|toCircleSmartAccount|toSafeSmartAccount|toKernelSmartAccount|createSmartAccountClient|bundlerClient|wallet_sendCalls)\b|@safe-global/;
  const ext = find(extRe, isCode);
  const extFiles = filesWith(extRe, isCode);
  const sa = find(saRe, isCode);
  const together = [...extFiles].filter((f) => fileHas(f, saRe));
  const value = find(/aggregate3Value/, isCode);
  const guard = files.some((f) => isCode(f.rel) && f.code.some((l) => /getCode|getBytecode/.test(l))) && files.some((f) => isCode(f.rel) && f.code.some((l) => /0xef0100/i.test(l)));
  let status;
  if (!ext.length) status = "n/a";
  else if (together.length || value.length) status = "fail";
  else if (guard && !sa.length) status = "pass";
  else status = "unknown";
  gate("G9", "Memo and Multicall3From called by an EOA only", status, [...value, ...ext.filter((h) => together.includes(h.file)), ...sa, ...ext].slice(0, 12),
    !ext.length ? "Memo/Multicall3From not used." : together.length ? `Smart-account code in the same file as the extensions: ${together.join(", ")}.` : value.length ? "aggregate3Value is not supported (CallFrom forwards no value)." : guard && !sa.length ? "EOA guard (getCode / 0xef0100) present; no smart-account code." : "Confirm only EOAs reach the extensions (for example a getCode(account) == 0x check).",
    [DOCS.memo, DOCS.batch]);
}

// G10 ------------------------------------------------------------------
{
  const hard = find(/block\.prevrandao|block\.difficulty|\bblobhash\b|\bblobbasefee\b|type:\s*["']eip4844["']|\bblobs\s*:/i, (r) => isCode(r));
  const zero = find(/address\(0\)\)?\.(transfer|send|call)\b|payable\(address\(0\)\)/, isSol);
  const sd = find(/\bselfdestruct\s*\(/, isSol);
  const status = hard.length || zero.length ? "fail" : sd.length ? "unknown" : anyCode ? "pass" : "n/a";
  gate("G10", "EVM differences reviewed", status, [...hard, ...zero, ...sd],
    (hard.length ? "PREVRANDAO is always 0 / blob transactions are rejected on Arc. " : "") + (zero.length ? "Value transfers to address(0) revert. " : "") + (sd.length ? "SELFDESTRUCT has extra value rules on Arc; review each use. " : "") +
      "Transfers to or from blocklisted addresses revert and still cost gas: simulate before sending.",
    [DOCS.evm], ["Confirm sends are simulated (eth_call / estimateGas) before submission"]);
}

// G11 ------------------------------------------------------------------
{
  const hits = find(/confirmations\s*:\s*([2-9]|\d{2,})\b|\.wait\(\s*([2-9]|\d{2,})\s*\)|\bof\s+\d+\s+confirmations\b|["'`>]\s*Confirming\b/i, (r) => isCode(r));
  const status = hits.length ? "fail" : ui.length || anyCode ? "pass" : "n/a";
  gate("G11", "One-confirmation finality in the UX", status, hits,
    hits.length ? "Multi-confirmation waits or 'Confirming' states found; Arc transactions are final on inclusion." : "No multi-confirmation waits found.",
    [DOCS.lifecycle, DOCS.wallets]);
}

// G12 ------------------------------------------------------------------
// Every burn to CCTP domain 27 must set both mintRecipient and destinationCaller to CctpForwarder
// (mainnet CBZL2IH7…DF5T). The mainnet strkey being present somewhere is not enough to pass.
const FWD_MAIN = "CBZL2IH7F6BIDAA3WBNXYKIXSATJGMSW7K5P5MJ6STX5RXN47TZJDF5T";
const FWD_TEST = "CA66Q2WFBND6V4UEB7RD4SAXSVIWMD6RA4X3U32ELVFGXV5PJK4T4VSZ";
function splitArgs(body) {
  const parts = []; let depth = 0, start = 0, q = null;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (q) { if (c === "\\") i++; else if (c === q) q = null; continue; }
    if (c === "\"" || c === "'" || c === "`") q = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "," && !depth) { parts.push(body.slice(start, i).trim()); start = i + 1; }
  }
  parts.push(body.slice(start).trim());
  return parts.filter(Boolean);
}
function balanced(text, open) { // text from the opener to its closer (exclusive), bounded
  let depth = 0;
  for (let i = open; i < Math.min(text.length, open + 3000); i++) {
    if ("([{".includes(text[i])) depth++;
    else if (")]}".includes(text[i]) && --depth === 0) return text.slice(open + 1, i);
  }
  return null;
}
function burnSites() {
  const sites = [];
  for (const f of files.filter((x) => isCode(x.rel))) {
    const text = f.code.join("\n");
    if (!/depositForBurn|destinationDomain|destination_domain/i.test(text)) continue;
    const consts = new Map();
    for (const m of text.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]{1,60})?=\s*([^;\n]+)|\b(?:uint\d*|bytes32|address)\s+(?:(?:constant|immutable|public|private|internal)\s+)*([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/g)) {
      const k = m[1] || m[3]; if (!consts.has(k)) consts.set(k, (m[2] || m[4]).trim());
    }
    const expand = (e) => { let t = String(e || ""); for (let i = 0; i < 3; i++) t = t.replace(/[A-Za-z_$][\w$]*/g, (id) => (consts.has(id) ? ` ${consts.get(id)} ` : id)); return t; };
    const is27 = (e) => /stellar/i.test(e) || /^\s*27\s*$/.test(expand(e).replace(/["'`]/g, "").trim());
    const lineOf = (i) => text.slice(0, i).split("\n").length;
    const add = (i, recipient, caller) => sites.push({ file: f.rel, line: lineOf(i), text: redact(f.lines[lineOf(i) - 1] || ""),
      recipient: recipient == null ? null : { raw: recipient, full: expand(recipient) }, caller: caller == null ? null : { raw: caller, full: expand(caller) } });
    for (const m of text.matchAll(/\bdepositForBurn(?:WithHook)?\s*\(/g)) {
      const body = balanced(text, m.index + m[0].length - 1);
      if (body == null) continue;
      let a = splitArgs(body);
      if (a.length === 1 && a[0].startsWith("[")) a = splitArgs(a[0].slice(1, -1));
      if (a.length >= 3 && is27(a[1])) add(m.index, a[2], a[4]);
    }
    for (const m of text.matchAll(/\bfunctionName\s*:\s*["']depositForBurn(?:WithHook)?["']/g)) {
      const am = /\bargs\s*:\s*\[/.exec(text.slice(m.index, m.index + 800));
      if (!am) continue;
      const body = balanced(text, m.index + am.index + am[0].length - 1);
      const a = body == null ? [] : splitArgs(body);
      if (a.length >= 3 && is27(a[1])) add(m.index, a[2], a[4]);
    }
    for (const m of text.matchAll(/\bdestination_?[dD]omain["']?\s*:\s*([^,}\n]+)/g)) {
      if (!is27(m[1])) continue;
      let open = -1, depth = 0;
      for (let i = m.index - 1; i >= Math.max(0, m.index - 1500); i--) { if (text[i] === "}") depth++; else if (text[i] === "{") { if (!depth) { open = i; break; } depth--; } }
      const body = open >= 0 ? balanced(text, open) || "" : "";
      const entry = (k) => { const e = splitArgs(body).find((p) => new RegExp(`^["']?${k}["']?\\s*(:|$)`).test(p)); return e == null ? null : e.includes(":") ? e.slice(e.indexOf(":") + 1) : e; };
      add(m.index, entry("mintRecipient"), entry("destinationCaller"));
    }
  }
  return sites;
}
{
  const sites = burnSites();
  const main = find(new RegExp(FWD_MAIN));
  const test = find(new RegExp(FWD_TEST));
  const fwdName = /CctpForwarder|CCTP_?FORWARDER|(?:^|[^\w$])(?:cctp_?|stellar_?)?(?:forwarder|fwd)\w*/i;
  const verdict = (e) => {
    if (!e) return "unknown";
    if (e.full.includes(FWD_MAIN)) return "main";
    if (e.full.includes(FWD_TEST)) return "test";
    return [e.raw, e.full].some((t) => fwdName.test(t) && !/trusted/i.test(t)) ? "maybe" : "no";
  };
  const judged = sites.map((x) => ({ ...x, r: verdict(x.recipient), c: verdict(x.caller) }));
  const wrong = judged.filter((x) => x.r === "no" || x.c === "no" || x.r === "test" || x.c === "test");
  const proven = judged.filter((x) => x.r === "main" && x.c === "main");
  let status, notes;
  if (!sites.length) { status = "n/a"; notes = "No Stellar (CCTP domain 27) burns found."; }
  else if (!main.length && !test.length && !judged.some((x) => x.r === "maybe" || x.c === "maybe")) { status = "fail"; notes = "Burns to Stellar without CctpForwarder: funds get stuck and cannot be recovered."; }
  else if (wrong.length) { status = "fail"; notes = `Burn(s) to Stellar whose mintRecipient or destinationCaller is not the mainnet CctpForwarder (${FWD_MAIN.slice(0, 8)}…${FWD_MAIN.slice(-4)}): ${wrong.map((x) => `${x.file}:${x.line}`).join(", ")}.`; }
  else if (!main.length) { status = "fail"; notes = "Only the testnet CctpForwarder is present; mainnet needs CBZL2IH7…DF5T."; }
  else if (proven.length === judged.length) { status = "pass"; notes = "Every domain-27 burn sets mintRecipient and destinationCaller to the mainnet CctpForwarder."; }
  else { status = "unknown"; notes = `Mainnet CctpForwarder present, but these burns do not show both mintRecipient and destinationCaller resolving to it: ${judged.filter((x) => !proven.includes(x)).map((x) => `${x.file}:${x.line}`).join(", ")}. Confirm each.`; }
  gate("G12", "USDC to Stellar goes through CctpForwarder", status, [...judged, ...main, ...test].map(({ file, line, text }) => ({ file, line, text })), notes,
    [DOCS.stellar, "https://developers.circle.com/cctp/references/stellar-contracts"]);
}

// G13 ------------------------------------------------------------------
{
  const tracked = sh("git", ["ls-files"]);
  const envFiles = tracked.code === 0 ? tracked.out.split("\n").filter((f) => /(^|\/)\.env($|\.)/.test(f) && !/example|sample|template/i.test(f)) : [];
  const trackedSet = tracked.code === 0 ? new Set(tracked.out.split("\n")) : null;
  const secrets = find(/(PRIVATE_KEY|MNEMONIC|SEED_PHRASE|SECRET_KEY)[A-Z_]*\s*[=:]\s*["']?(0x)?[0-9a-fA-F]{64}\b|--private-key\s+(0x)?[0-9a-fA-F]{64}\b/, (r) => !trackedSet || trackedSet.has(r), 50, raw);
  const evidence = [...envFiles.map((f) => ({ file: f, line: 0, text: "tracked by git" })), ...secrets];
  const status = evidence.length ? "fail" : "unknown";
  gate("G13", "Operations: keys, monitoring, screening", status, evidence,
    evidence.length ? "Key material or .env files are committed. Rotate those keys and remove them from history." : "No committed key material found. Custody, monitoring and screening need the user's answers.",
    [DOCS.addr, DOCS.compliance],
    ["Who holds the mainnet deploy/admin keys (hardware wallet, KMS, multisig)?", "Who is alerted when a transaction or job fails?", "If you screen addresses offchain, are Memo (0x5294…e505) and Multicall3From (0x522f…47D0) included?"]);
}

// G14 ------------------------------------------------------------------
let programs = [];
let g14Finish = () => {}; // (visibility, mainnetLive) -> sets G14 status and notes; re-run by --online
{
  const claims = find(/official\s+(arc|circle)\b|\b(arc|circle)\s+official\b|partner(ed)?\s+with\s+(arc|circle)\b|endorsed\s+by\s+(arc|circle)\b|\b(arc|circle)[- ]backed\b|backed\s+by\s+(arc|circle)\b/i, isDoc, 50, raw);
  const wording = find(/\b(apy|apr|yield|roi|guaranteed|risk[- ]free|passive income)\b/i, isDoc, 50, raw);
  let name = null;
  try { name = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).name || null; } catch { /* none */ }
  const arcName = name && /(^|[^a-z])arc([^a-z]|$)/i.test(name);
  try {
    const now = Date.now();
    const exp = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T23:59:59.999-12:00`) : new Date(v)).getTime();
    // open = not ended and still taking applications (applications_closed can precede valid_until)
    programs = JSON.parse(readFileSync(path.join(PLUGIN, "data", "programs.json"), "utf8")).items
      .filter((p) => exp(p.valid_until) >= now && !(p.applications_closed && exp(p.applications_closed) < now)
        && p.kind !== "community" && p.kind !== "bug-bounty")
      .map((p) => ({ id: p.id, name: p.name, valid_until: p.valid_until, kind: p.valid_until_kind, requires: p.requires, url: p.source_url, days_left: Math.floor((exp(p.valid_until) - now) / 86_400_000) }));
  } catch { /* data not found */ }
  const remote = sh("git", ["remote", "get-url", "origin"]);
  const remoteUrl = remote.code === 0 ? remote.out.trim().replace(/\/\/[^@/]+@/, "//") : "";
  const notes = [];
  if (claims.length) notes.push("Affiliation claims found; remove them.");
  if (wording.length) notes.push("Return or promise wording found; review it (it can carry regulatory obligations; get legal advice).");
  if (arcName) notes.push(`Package name "${name}" uses Arc; check the Arc Brand Kit (Arc Network Terms section 12).`);
  const mr = programs.filter((p) => p.requires?.mainnet);
  const needsPublic = mr.some((p) => p.requires.public_repo);
  if (mr.length) notes.push(`Open programs requiring mainnet: ${mr.map((p) => `${p.name} (until ${p.valid_until}, ${p.days_left} days left${p.requires.public_repo ? ", public repo" : ""})`).join("; ")}. Mainnet config ${mainnetConfigured ? "found" : "NOT found"}; git remote ${remoteUrl || "not set"}.`);
  // Each requirement of those programs that is not met, or that this collector cannot confirm, is spelled
  // out, and keeps G14 at unknown: a fresh, unpublished app must not come out green for eligibility.
  const requirements = (visibility, mainnetLive) => {
    const out = [];
    if (!mr.length) return out;
    if (!mainnetConfigured) out.push("requirement not met: deployed and working on Arc mainnet (no mainnet config found)");
    else if (!mainnetLive) out.push("requirement unconfirmed: deployed and working on Arc mainnet (confirm the live mainnet app with the user)");
    if (needsPublic) {
      if (!remoteUrl) out.push("requirement not met: public repo (no git remote `origin`)");
      else if (visibility == null) out.push(`requirement unconfirmed: public repo (${remoteUrl}; run with --online, or gh repo view --json visibility)`);
      else if (!/^public$/i.test(visibility)) out.push(`requirement not met: public repo (visibility: ${visibility})`);
    }
    return out;
  };
  gate("G14", "Brand claims and program eligibility", "unknown", [...claims, ...wording], "",
    [DOCS.terms, ...programs.map((p) => p.url)], needsPublic ? ["Confirm the repo is public (gh repo view --json visibility, or --online)"] : []);
  const g14 = gates[gates.length - 1];
  g14Finish = (visibility = null, mainnetLive = false) => {
    const reqs = requirements(visibility, mainnetLive);
    g14.status = claims.length ? "fail" : wording.length || arcName || reqs.length ? "unknown" : "pass";
    g14.notes = [...notes, ...(reqs.length ? [`${reqs.join("; ")}.`] : [])].join(" ") || "No affiliation claims or return wording found.";
  };
  g14Finish();
}

// ---------- online, read-only ----------
if (opt.online) {
  const g3 = gates.find((g) => g.id === "G3");
  try {
    const id = await rpc(RPC.mainnet, "eth_chainId", []);
    g3.evidence.push({ file: "rpc.mainnet.arc.io", line: 0, text: `eth_chainId = ${id} (${parseInt(id, 16)})` });
    if (parseInt(id, 16) !== 5042) { g3.status = "fail"; g3.notes += " Mainnet RPC did not return chain 5042."; }
  } catch (e) { g3.notes += ` RPC check failed: ${e.message}.`; }
  for (const d of deployments.slice(0, 25)) {
    try {
      const code = await rpc(RPC[d.network], "eth_getCode", [d.address, "latest"]);
      const bytes = code && code !== "0x" ? (code.length - 2) / 2 : 0;
      g4.evidence.push({ file: d.from, line: 0, text: `${d.network} ${d.name} ${d.address}: ${bytes ? `${bytes} bytes of code` : "NO CODE"}` });
      if (!bytes && d.network === "mainnet") g4.status = "fail";
    } catch (e) { g4.notes.push(`eth_getCode ${d.address}: ${e.message}`); }
  }
  if (g4.status !== "fail" && deployments.some((d) => d.network === "mainnet")) g4.status = "pass";
  const g14 = gates.find((g) => g.id === "G14");
  const vis = sh("gh", ["repo", "view", "--json", "visibility", "--jq", ".visibility"], 20_000);
  g14.evidence.push({ file: "gh repo view", line: 0, text: vis.code === 0 ? `visibility: ${vis.out.trim()}` : "could not read repo visibility" });
  g14Finish(vis.code === 0 && vis.out.trim() ? vis.out.trim() : null, g4.status === "pass" && deployments.some((d) => d.network === "mainnet"));
}
if (!deployments.length) g4.notes.push(sol.length ? "No deployment addresses recorded (.stable-build/project.json deployments[], broadcast/, or --address)." : "No contracts in this repo.");
else if (!opt.online) g4.notes.push(`${deployments.length} recorded address(es); re-run with --online to check them with eth_getCode.`);
if (!sol.length && !deployments.length && g4.status === "unknown") g4.status = "n/a";
g4.notes.push("Arc Studio deploys to testnet only; deploy mainnet contracts with arc-forge and a key you hold.");
gates.splice(3, 0, { id: "G4", title: "Deploy path (Arc Studio is testnet only) and onchain re-check", status: g4.status, evidence: g4.evidence.slice(0, 12), notes: g4.notes.join(" "), manual: [], docs: [DOCS.studio] });

// ---------- output ----------
const head = sh("git", ["rev-parse", "--short", "HEAD"]);
const result = {
  tool: "stable-build go-live evidence",
  generated_at: new Date().toISOString(),
  dir: ROOT,
  commit: head.code === 0 ? head.out.trim() : null,
  online: opt.online,
  project: { marker: project, files_scanned: files.length, solidity_files: sol.length, ui_files: ui.length, foundry: hasFoundry, hardhat: hasHardhat },
  programs,
  gates,
};
if (opt.format === "json") console.log(JSON.stringify(result, null, 2));
else {
  const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
  const out = [`# go-live evidence (${result.generated_at.slice(0, 10)}${result.commit ? `, commit ${result.commit}` : ""})`, "",
    `Scanned ${files.length} files in ${ROOT}. Online checks: ${opt.online ? "yes" : "no"}. Read-only; nothing was deployed or signed.`, "",
    "| Gate | Status | Notes | Docs |", "|---|---|---|---|",
    ...gates.map((g) => `| ${g.id} ${cell(g.title)} | **${g.status}** | ${cell(g.notes)} | ${g.docs.slice(0, 2).join(" ")} |`), ""];
  for (const g of gates.filter((x) => x.evidence.length || x.manual.length)) {
    out.push(`## ${g.id} evidence`);
    for (const e of g.evidence) out.push(`- \`${cell(e.file)}${e.line ? `:${e.line}` : ""}\` ${cell(e.text)}`);
    for (const m of g.manual) out.push(`- [manual] ${m}`);
    out.push("");
  }
  console.log(out.join("\n"));
}
process.exit(gates.some((g) => g.status === "fail") ? 1 : 0);

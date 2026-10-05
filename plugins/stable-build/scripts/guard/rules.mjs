// The 10 guard rules. One pure function per stable rule id: (ctx) => [{ index, variant? }].
// Regex/token based; no network, no file writes, no I/O at all.
//
// ctx = { full, lo, hi, kind, isCI, file }
//   full   comment-masked text of the whole file (the added text sits at [lo, hi))
//   lo/hi  range of the text just added; a finding must overlap it, so old code is not re-reported
//   kind   js | sol | shell | yaml | toml | json | md   (see text.mjs fileKind)
// Messages, fixes and evidence live in data/gotchas.json; severity variants are keyed by `variant`.
import { bodyFrom, balancedEnd, enclosingOpen, splitTopLevel, objectEntries, assignments, evalInt, exprAt } from "./text.mjs";

const USDC_HEX = /0x3600000000000000000000000000000000000000/i;
const SYS_HEX = /0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE/i;
const TOPIC_HEX = /0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef/i;
const GWEI = 1_000_000_000n;
const FEE_FLOOR = 20n * GWEI;
const MAX_HITS = 50;

// ---------- shared helpers ----------

function* hits(re, ctx, lookback = 200) {
  re.lastIndex = Math.max(0, ctx.lo - lookback);
  let n = 0;
  let m;
  while ((m = re.exec(ctx.full)) && m.index < ctx.hi && n++ < MAX_HITS) {
    if (m[0].length === 0) re.lastIndex++;
    if (m.index + m[0].length > ctx.lo || m.index >= ctx.lo) yield m;
  }
}

function consts(ctx) {
  if (!ctx._consts) ctx._consts = assignments(ctx.full);
  return ctx._consts;
}

/** Resolve an identifier through simple const assignments (two hops). */
function resolve(expr, ctx) {
  let e = String(expr || "").trim();
  for (let i = 0; i < 2 && /^[A-Za-z_$][\w$]*$/.test(e) && consts(ctx).has(e); i++) e = consts(ctx).get(e);
  return e;
}

function objectAt(s, idx) {
  const open = enclosingOpen(s, idx, "{", 1500);
  if (open < 0) return null;
  const body = bodyFrom(s, open, 4000);
  return { open, body, entries: objectEntries(body) };
}

function callArgs(s, m) {
  const open = m.index + m[0].length - 1;
  return bodyFrom(s, open, 4000);
}

// ---------- usdc-native-value-6dp ----------

const TX_FN_BEFORE = /\b(?:sendTransaction|writeContract|simulateContract|estimateGas|estimateContractGas|prepareTransactionRequest|signTransaction|populateTransaction|useSendTransaction|useWriteContract|useSimulateContract|useEstimateGas|deployContract|sendTransactionAsync|writeContractAsync|sendCalls|sendCallsAsync|useSendCalls|call)\s*\(\s*$/;
// viem sendCalls / sendUserOperation rows: calls: [{ to, value }] or calls: rows.map((r) => ({ to, value }))
const CALLS_ARRAY = /\bcalls\s*:\s*\[[^\]]*$/;
const CALLS_MAP = /\bcalls\s*:\s*[\w$.]*\.(?:map|flatMap)\(\s*(?:async\s*)?(?:\([^()]*\)|[\w$]+)\s*=>\s*\(?\s*$/;
// Keys that only a transaction request carries (a payout row { to, value } has none of them).
const TX_ONLY_KEY = /^(?:data|gas|gasLimit|gasPrice|maxFeePerGas|maxPriorityFeePerGas|nonce|account|chainId|chain|type|abi|functionName|args|accessList|authorizationList|dataSuffix)$/;
// ethers call overrides: the last argument of a contract method call, e.g. shop.buy({ value }).
const OVERRIDE_KEYS = new Set(["value", "gasLimit", "gasPrice", "maxFeePerGas", "maxPriorityFeePerGas", "nonce",
  "from", "type", "chainId", "customData", "blockTag", "accessList"]);
const NOT_A_CONTRACT_CALL = /^(?:push|unshift|set|add|append|concat|map|filter|reduce|emit|log|info|warn|error|resolve|json|stringify|assign|from|of|setState|dispatch|render|format)$/;
const TYPED_DATA_KEYS = /^(?:validAfter|validBefore|spender|owner|deadline|primaryType|verifyingContract)$/;
const SIX = String.raw`(?:10n?\s*\*\*\s*6n?|1e6|1_?000_?000n?)(?![\w.])`;
// parseUnits(x, d): d is a literal or a const that resolves to an integer (USDC_DECIMALS = 6)
const R1_DIRECT = /\bvalue\s*:\s*(?:await\s+)?(?:[\w$]+\.)*parseUnits\(\s*(?:[^()]|\([^()]*\)){1,160}?,\s*([\w$.]+)\s*\)/g;
const R1_MUL = new RegExp(String.raw`\bvalue\s*:\s*[^,}\n]{0,80}?\*\s*${SIX}`, "g");
const R1_NAMED = /\bvalue\s*:\s*([A-Za-z_$][\w$]*)\s*(?=[,}\n])/g;
const R1_SHORT = /[{,]\s*value\s*(?=[,}])/g;
const R1_SOL = /msg\.value\s*(?:==|!=|>=|<=|>|<)\s*[^;{)\n]{0,80}?(?:\b1e6\b|\b10\s*\*\*\s*6\b|\b1_?000_?000\b)|\{\s*value\s*:\s*[^}\n]{0,80}?(?:\b1e6\b|\b10\s*\*\*\s*6\b|\b1_?000_?000\b)[^}\n]{0,40}\}/g;
const SIX_PU = /^(?:await\s+)?(?:[\w$]+\.)*parseUnits\(\s*(?:[^()]|\([^()]*\)){1,160}?,\s*([\w$.]+)\s*\)$/;
const SIX_MUL = new RegExp(String.raw`^[^;\n]{0,80}\*\s*${SIX}$`);

/** Integer value of a parseUnits decimals argument (literal or const), or null. */
function decimalsOf(arg, ctx) {
  return evalInt(resolve(arg, ctx), consts(ctx));
}

function isSixRhs(rhs, ctx) {
  const m = SIX_PU.exec(rhs);
  if (m) return decimalsOf(m[1], ctx) === 6n;
  return SIX_MUL.test(rhs);
}

function nativeTxObject(s, idx) {
  const obj = objectAt(s, idx);
  if (!obj || !obj.entries.has("value")) return false;
  for (const k of obj.entries.keys()) if (TYPED_DATA_KEYS.test(k)) return false;
  const before = s.slice(Math.max(0, obj.open - 160), obj.open);
  if (/\b(?:message|types|domain|typedData)\s*:\s*$/.test(before)) return false;
  if (TX_FN_BEFORE.test(before)) return true;
  const keys = [...obj.entries.keys()];
  if (obj.entries.has("to") && keys.some((k) => TX_ONLY_KEY.test(k))) return true;
  // viem sendCalls / sendUserOperation: { calls: [{ to, value }] }
  const lead = s.slice(Math.max(0, obj.open - 400), obj.open);
  if (obj.entries.has("to") && (CALLS_ARRAY.test(lead) || CALLS_MAP.test(lead))) return true;
  if (!/[(,]\s*$/.test(before) || obj.entries.has("to") || !keys.every((k) => OVERRIDE_KEYS.has(k))) return false;
  const paren = enclosingOpen(s, obj.open, "(", 1500);
  if (paren < 0) return false;
  const callee = /\.\s*([A-Za-z_$][\w$]*)\s*$/.exec(s.slice(Math.max(0, paren - 80), paren));
  return Boolean(callee) && !NOT_A_CONTRACT_CALL.test(callee[1]);
}

function usdcNativeValue6dp(ctx) {
  const out = [];
  if (ctx.kind === "sol") {
    for (const m of hits(R1_SOL, ctx)) out.push({ index: m.index });
    return out;
  }
  for (const m of hits(R1_DIRECT, ctx)) {
    if (decimalsOf(m[1], ctx) === 6n && nativeTxObject(ctx.full, m.index)) out.push({ index: m.index });
  }
  for (const m of hits(R1_MUL, ctx)) if (nativeTxObject(ctx.full, m.index)) out.push({ index: m.index });
  const tainted = new Set([...consts(ctx)].filter(([, rhs]) => isSixRhs(rhs, ctx)).map(([k]) => k));
  if (tainted.size) {
    for (const m of hits(R1_NAMED, ctx)) if (tainted.has(m[1]) && nativeTxObject(ctx.full, m.index)) out.push({ index: m.index });
    if (tainted.has("value")) {
      for (const m of hits(R1_SHORT, ctx)) if (nativeTxObject(ctx.full, m.index + 1)) out.push({ index: m.index + 1 });
    }
  }
  return out;
}

// ---------- usdc-erc20-amount-18dp ----------

const R2_FN = /\bfunctionName\s*:\s*["'](?:transfer|approve|transferFrom|increaseAllowance)["']/g;
const R2_CALL = /\b[\w$]*usdc[\w$]*\s*(?:\.\s*connect\([^()]{0,80}\))?\s*(?:\.\s*(?:write|simulate|estimateGas))?\s*\.\s*(?:transfer|approve|transferFrom|increaseAllowance|safeTransfer|safeTransferFrom|safeApprove|safeIncreaseAllowance|forceApprove)\s*\(/gi;
const R2_SOL_CAST = /\bIERC20(?:Metadata)?\s*\(\s*(?:0x3600000000000000000000000000000000000000|[\w$]*usdc[\w$]*)\s*\)\s*\.\s*(?:transfer|approve|transferFrom|safeTransfer|safeTransferFrom|safeApprove|safeIncreaseAllowance|forceApprove)\s*\(/gi;
const R2_CAST = /\b(?:arc-)?cast\s+send\b(?:[^\n\\]|\\\n|\\)*/g;
const DP18 = /parseEther\s*\(|parseUnits\s*\((?:[^()]|\([^()]*\)){1,160}?,\s*(?:18|["']ether["'])\s*\)|\b10n?\s*\*\*\s*18n?(?![\w.])|\b1e18\b|\b1_?000_?000_?000_?000_?000_?000n?\b|\b\d+\s+ether\b|toWei\s*\(\s*[^,()]+\)|toWei\s*\([^()]*,\s*["']ether["']\s*\)/;
const DP18_G = new RegExp(DP18.source, "g");
const USDC_REF = /usdc|0x3600000000000000000000000000000000000000/i;
const LIT18 = /^(?:10n?\s*\*\*\s*18n?|1e18|1_?000_?000_?000_?000_?000_?000n?)$/;
const PU_DEC = /parseUnits\s*\(\s*(?:[^()]|\([^()]*\)){1,160}?,\s*([A-Za-z_$][\w$.]*)\s*\)/g;
const DIVISOR = /\/\s*(\(\s*10n?\s*\*\*\s*18n?\s*\)|10n?\s*\*\*\s*18n?(?![\w.])|1e18\b|1_?000_?000_?000_?000_?000_?000n?\b|[A-Za-z_$][\w$]*)/g;
const TEN18 = 10n ** 18n;

/** A 10^18 literal, or a const that evaluates to 10^18 (WAD = 1e18). */
function isTen18(term, ctx) {
  const t = String(term).trim().replace(/^\(\s*|\s*\)$/g, "");
  if (LIT18.test(t)) return true;
  return /^[A-Za-z_$][\w$]*$/.test(t) && evalInt(resolve(t, ctx), consts(ctx)) === TEN18;
}

// "x * price / 1e18" and "x / WAD" scale an amount down to 6 decimals: blank 10^18 divisors.
function stripDivisors(text, ctx) {
  return text.replace(DIVISOR, (all, term) => (isTen18(term, ctx) ? " ".repeat(all.length) : all));
}

/** Does one amount argument carry 18 decimals? (parseEther, parseUnits(x, 18 or a const = 18), x * 10**18) */
function has18(text, ctx, depth = 0) {
  const t = stripDivisors(text, ctx);
  for (const m of t.matchAll(DP18_G)) {
    // a 10^18 factor followed by a division is a ratio (amount * 1e18 / price), not an 18-decimal amount
    if (LIT18.test(m[0].trim()) && /\/(?![/*])/.test(t.slice(m.index + m[0].length))) continue;
    return true;
  }
  for (const m of t.matchAll(PU_DEC)) if (decimalsOf(m[1], ctx) === 18n) return true;
  if (depth > 0) return false;
  for (const m of t.matchAll(/[A-Za-z_$][\w$]*/g)) {
    const rhs = consts(ctx).get(m[0]);
    if (!rhs) continue;
    if (isTen18(m[0], ctx)) {
      if (!/\/(?![/*])/.test(t.slice(m.index + m[0].length))) return true;
      continue;
    }
    if (has18(rhs, ctx, depth + 1)) return true;
  }
  return false;
}

/** Amount arguments of a call: every top-level argument, with viem's single array argument unwrapped. */
function argList(body) {
  let a = splitTopLevel(body);
  if (a.length === 1 && a[0].startsWith("[") && a[0].endsWith("]")) a = splitTopLevel(a[0].slice(1, -1));
  return a;
}

function usdcErc20Amount18dp(ctx) {
  const out = [];
  const s = ctx.full;
  if (ctx.kind === "shell" || ctx.kind === "yaml") {
    for (const m of hits(R2_CAST, ctx)) {
      const cmd = m[0];
      if (USDC_HEX.test(cmd) && /\b(?:transfer|approve|transferFrom)\(/.test(cmd) &&
        /\$\(\s*(?:arc-)?cast\s+(?:to-wei|tw)\b|parse-units\s+\S+\s+18\b|\b\d{19,}\b|\b\d+ether\b/.test(cmd)) out.push({ index: m.index });
    }
    return out;
  }
  if (ctx.kind === "js") {
    for (const m of hits(R2_FN, ctx)) {
      const obj = objectAt(s, m.index);
      if (!obj) continue;
      const args = obj.entries.get("args");
      if (!args || !(args.startsWith("[") ? argList(args) : [args]).some((a) => has18(a, ctx))) continue;
      let usdc = USDC_REF.test(obj.body.replace(/functionName[^,]*/, ""));
      if (!usdc) {
        const outer = objectAt(s, obj.open);
        usdc = !!outer && USDC_REF.test(outer.body);
      }
      if (usdc) out.push({ index: m.index });
    }
  }
  for (const re of ctx.kind === "sol" ? [R2_CALL, R2_SOL_CAST] : [R2_CALL]) {
    for (const m of hits(re, ctx)) if (argList(callArgs(s, m)).some((a) => has18(a, ctx))) out.push({ index: m.index });
  }
  return out;
}

// ---------- usdc-balance-summed ----------

const NATIVE_REF = /\b(?:getBalance|eth_getBalance)\b|\bmsg\.value\b|\baddress\s*\([^()]{1,60}\)\s*\.balance\b/;
const ERC20_REF = /\bbalanceOf\b/;
const OTHER_TOKEN = /eurc|usyc|weth|wbtc|cirbtc|\bdai\b|usdt/i;
const PLUS = /(?<![+])\+(?![+=])/g;
const R3_PLUS_EQ = /\b([A-Za-z_$][\w$]*)\s*\+=\s*([^;\n]+)/g;
const NATIVE_LABEL = /\b(?:native|gas)\s+USDC\b|\bUSDC\s*\(\s*(?:native|gas)\s*\)/gi;
const ERC20_LABEL = /\bERC-?20\s+USDC\b|\bUSDC\s*\(\s*ERC-?20\s*\)/gi;

function balanceSide(text, ctx) {
  let native = NATIVE_REF.test(text);
  let erc20 = ERC20_REF.test(text) && !OTHER_TOKEN.test(text);
  if (native && erc20) return "both";
  for (const id of text.match(/[A-Za-z_$][\w$]*/g) || []) {
    const rhs = consts(ctx).get(id);
    if (!rhs || OTHER_TOKEN.test(rhs) || OTHER_TOKEN.test(id)) continue;
    if (/\b(?:getBalance|eth_getBalance)\b|\.balance\b/.test(rhs)) native = true;
    else if (/\bbalanceOf\b/.test(rhs)) erc20 = true;
  }
  return native && erc20 ? "both" : native ? "native" : erc20 ? "erc20" : null;
}

function usdcBalanceSummed(ctx) {
  const out = [];
  const s = ctx.full;
  // Statements that overlap the added range.
  const start = Math.max(0, s.lastIndexOf("\n", ctx.lo - 1));
  const end = Math.min(s.length, ctx.hi + 200);
  const segRe = /[^;\n{}]+/g;
  segRe.lastIndex = start;
  let m;
  let guard = 0;
  while ((m = segRe.exec(s)) && m.index < end && guard++ < 2000) {
    const seg = m[0];
    if (!seg.includes("+") || m.index + seg.length <= ctx.lo || m.index >= ctx.hi) continue;
    let flagged = false;
    PLUS.lastIndex = 0;
    let p;
    while (!flagged && (p = PLUS.exec(seg))) {
      const a = balanceSide(seg.slice(0, p.index), ctx);
      const b = balanceSide(seg.slice(p.index + 1), ctx);
      if ((a && b && a !== b) || (a === "both" && b) || (b === "both" && a)) flagged = true;
    }
    if (!flagged) {
      R3_PLUS_EQ.lastIndex = 0;
      const pe = R3_PLUS_EQ.exec(seg);
      if (pe) {
        const a = balanceSide(pe[1], ctx);
        const b = balanceSide(pe[2], ctx);
        if (a && b && a !== b) flagged = true;
      }
    }
    if (flagged) out.push({ index: m.index + (seg.length - seg.trimStart().length) });
  }
  if (ctx.kind === "js") {
    // Two labels only when they sit in different string literals or JSX text runs: one sentence that
    // names both ("Native USDC and ERC-20 USDC are one balance") is the explanation, not two rows.
    const all = (re) => [...s.matchAll(new RegExp(re.source, "gi"))].map((m) => ({ index: m.index, unit: textUnit(s, m.index) }));
    const nat = all(NATIVE_LABEL);
    const erc = all(ERC20_LABEL);
    const apart = (a, b) => a.unit !== b.unit;
    const pairs = nat.flatMap((a) => erc.filter((b) => apart(a, b)).map((b) => [a, b]));
    if (pairs.length) {
      const inRange = (x) => x.index >= ctx.lo && x.index < ctx.hi;
      const hit = pairs.flat().find(inRange);
      if (hit) out.push({ index: hit.index, variant: "two-rows" });
    }
  }
  return out.slice(0, 5);
}

/** Start of the string literal or JSX text run that contains idx (quote, backtick, > < { } or newline). */
function textUnit(s, idx) {
  for (let i = idx - 1; i >= 0 && i > idx - 400; i--) if (/["'`<>{}\n]/.test(s[i])) return i;
  return Math.max(0, idx - 400);
}

// ---------- fee-below-floor ----------

const R4_KEY = /\b(maxFeePerGas|gasPrice)\s*:\s*/g;
const R4_CLI = /--(?:gas-price|with-gas-price)(?:[ \t]+|=)["']?([\w.]+)/g;
const R4_TOML = /^[ \t]*(?:gas_price|gasPrice)[ \t]*=[ \t]*["']?(\d[\d_]*)/gm;

function weiOf(expr, ctx, depth = 0) {
  if (depth > 2) return null;
  const e = trimUnbalanced(expr);
  let m = /^(?:[\w$]+\.)*parseGwei\(\s*["'`]?([\d_.]+)["'`]?\s*\)$/.exec(e);
  if (m) return gweiToWei(m[1]);
  m = /^(?:[\w$]+\.)*(?:parseUnits|toWei)\(\s*["'`]?([\d_.]+)["'`]?\s*,\s*(?:["'`]gwei["'`]|9)\s*\)$/i.exec(e);
  if (m) return gweiToWei(m[1]);
  const v = evalInt(e, consts(ctx));
  if (v != null) return v;
  if (/^[A-Za-z_$][\w$]*$/.test(e) && consts(ctx).has(e)) return weiOf(consts(ctx).get(e), ctx, depth + 1);
  return null;
}

// "parseGwei('1') )" -> "parseGwei('1')": drop trailing closers that belong to an outer call.
function trimUnbalanced(expr) {
  let e = String(expr).trim();
  const count = (c) => e.split(c).length - 1;
  while (e.endsWith(")") && count(")") > count("(")) e = e.slice(0, -1).trimEnd();
  return e;
}

function gweiToWei(x) {
  const [i, f = ""] = x.replace(/_/g, "").split(".");
  if (!/^\d*$/.test(i) || !/^\d*$/.test(f)) return null;
  return BigInt(i || "0") * GWEI + BigInt((f + "000000000").slice(0, 9) || "0");
}

function cliWei(v) {
  let m = /^(\d+(?:\.\d+)?)gwei$/i.exec(v);
  if (m) return gweiToWei(m[1]);
  m = /^(\d+)(?:wei)?$/i.exec(v);
  return m ? BigInt(m[1]) : null;
}

// Hardhat's in-process `hardhat` network and a `localhost` node never reach Arc's mempool.
function inLocalNetwork(s, idx) {
  const obj = objectAt(s, idx);
  return !!obj && /\b(?:hardhat|localhost)["']?\s*:\s*$/.test(s.slice(Math.max(0, obj.open - 40), obj.open));
}

function feeBelowFloor(ctx) {
  const out = [];
  if (ctx.kind === "js") {
    for (const m of hits(R4_KEY, ctx)) {
      const wei = weiOf(exprAt(ctx.full, m.index + m[0].length), ctx);
      if (wei != null && wei < FEE_FLOOR && !inLocalNetwork(ctx.full, m.index)) out.push({ index: m.index });
    }
  }
  if (ctx.kind === "shell" || ctx.kind === "yaml" || ctx.kind === "md") {
    for (const m of hits(R4_CLI, ctx)) {
      const wei = cliWei(m[1]);
      if (wei != null && wei < FEE_FLOOR) out.push({ index: m.index });
    }
  }
  if (ctx.kind === "toml") {
    for (const m of hits(R4_TOML, ctx)) if (BigInt(m[1].replace(/_/g, "")) < FEE_FLOOR) out.push({ index: m.index });
  }
  return out;
}

// ---------- getlogs-unpaged ----------

const LOG_CALL = /\b(getLogs|getContractEvents|queryFilter|getPastEvents|getFilterLogs|createEventFilter|createContractEventFilter)\s*\(/g;
const LOG_RPC = /["']eth_getLogs["']/g;
const LOG_ANY = /\b(?:getLogs|getContractEvents|queryFilter|getPastEvents|getFilterLogs|createEventFilter|createContractEventFilter)\s*\(|eth_getLogs/;
const R5_CAST = /\b(?:arc-)?cast\s+logs\b(?:[^\n\\]|\\\n|\\)*/g;
const R5_CONST = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]{1,40})?=\s*(\d[\d_]*n?|BigInt\(\s*\d[\d_]*\s*\))\s*(?=[;\n])/g;
const R5_STEP = /\b([A-Za-z_$][\w$]*)\s*\+=\s*(\d[\d_]*)n?\b/g;
// Most blocks one eth_getLogs call may cover. Docs: -32012 "when the requested block range exceeds 10,000
// blocks"; live on both public endpoints (2026-10-04) toBlock - fromBlock = 9,999 passes and 10,000 fails.
// So a range is flagged when toBlock - fromBlock >= SPAN (10,001 blocks or more), not at exactly 10,000.
const SPAN = 10_000n;
const FIXED_FROM = /^(?:0n?|["'`](?:earliest|0x0+|0)["'`]|earliest|BigInt\(\s*["'`]?\d[\d_]*["'`]?\s*\)|\d[\d_]*n?|["'`]0x[0-9a-fA-F]+["'`]|[A-Z][A-Z0-9_]{2,}(?:\s+as\s+\w+)?|BigInt\(\s*[A-Z][A-Z0-9_]{2,}\s*\)|Number\(\s*[A-Z][A-Z0-9_]{2,}\s*\))$/;

function toIsHead(expr, ctx) {
  if (expr == null) return true;
  const e = resolve(expr, ctx).trim();
  return /^["'`]?latest["'`]?$/.test(e) || /^(?:await\s+)?[\w$.]*(?:getBlockNumber|blockNumber)\s*\(\s*\)$/.test(e) ||
    /^(?:latest|head|current|tip|chainHead)[\w$]*$/i.test(e) || /^(?:blockNumber|currentBlock|latestBlock|headBlock)$/.test(e) ||
    e === "undefined";
}

/**
 * Net constant offsets of a block expression: "from + CHUNK - 1n" -> CHUNK - 1. The text is cut into additive
 * runs at ternaries, comparisons, commas and parens, so "a + C - 1n < b ? a + C - 1n : b" gives { min 0, max C - 1 }
 * and Math.min(from + STEP - 1n, head) gives STEP - 1. names: the consts that contributed.
 */
function offsetRange(expr, ctx) {
  const text = String(expr).replace(/\b(?:BigInt|Number)\(\s*([\w$]+)\s*\)/g, " $1 ");
  let min = null;
  let max = null;
  const names = new Set();
  for (const run of text.split(/[?:,()<>=&|!;{}[\]]+/)) {
    let net = 0n;
    for (const m of run.matchAll(/([-+])\s*([A-Za-z_$][\w$]*|\d[\d_]*n?)(?![\w$(.])/g)) {
      const v = evalInt(m[2], consts(ctx));
      if (v == null) continue;
      if (/^[A-Za-z_$]/.test(m[2])) names.add(m[2]);
      net += m[1] === "-" ? -v : v;
    }
    if (min == null || net < min) min = net;
    if (max == null || net > max) max = net;
  }
  return { min: min ?? 0n, max: max ?? 0n, names };
}

function rangeOf(method, body) {
  if (method === "queryFilter") {
    const a = splitTopLevel(body);
    if (a.length < 2) return null;
    return { from: a[1], to: a[2] ?? null };
  }
  const args = splitTopLevel(body);
  const objText = method === "getPastEvents" ? args[1] : args[0];
  if (!objText || !objText.startsWith("{")) return null;
  const e = objectEntries(objText.slice(1, -1));
  if (!e.has("fromBlock")) return null;
  return { from: e.get("fromBlock"), to: e.has("toBlock") ? e.get("toBlock") : null };
}

function getlogsUnpaged(ctx) {
  const out = [];
  const s = ctx.full;
  if (!LOG_ANY.test(s) && !/\bcast\s+logs\b/.test(s)) return out;
  const flaggedConsts = new Set();
  if (ctx.kind === "js") {
    for (const m of hits(R5_CONST, ctx, 0)) {
      const v = evalInt(m[2], null);
      if (v == null || v < SPAN || !/range|span|step|chunk|batch|window|page|blocks?|lookback/i.test(m[1])) continue;
      // A page of exactly SPAN blocks is accepted: from + N - 1n, head - N + 1n, or a += N step. from + N
      // and head - N cover N + 1 blocks. Anything larger than SPAN is too large however it is used.
      const use = new RegExp(String.raw`\b(?:from|to|start|end|cursor|latest|head|current|block|tip)\w*\s*([-+]=?)\s*${m[1]}\b(\s*[-+]\s*1n?(?![\w.]))?`, "gi");
      let bad = false;
      for (const u of s.matchAll(use)) {
        const adj = u[2] || "";
        if (v > SPAN || (u[1] === "+" && !adj.includes("-")) || (u[1] === "-" && !adj.includes("+"))) bad = true;
      }
      if (bad) { out.push({ index: m.index, variant: "span" }); flaggedConsts.add(m[1]); }
    }
    for (const m of hits(R5_STEP, ctx, 0)) {
      // a literal step of exactly 10,000 is fine; the toBlock expression is judged at the call
      if (/from|start|cursor|block/i.test(m[1]) && BigInt(m[2].replace(/_/g, "")) > SPAN) out.push({ index: m.index, variant: "span" });
    }
  }
  const check = (index, from, to) => {
    if (from == null) return;
    const f = resolve(from, ctx).trim();
    // two absolute block numbers: flag a range of more than 10,000 blocks
    const fv = evalInt(f, consts(ctx));
    const tv = to != null ? evalInt(resolve(to, ctx).trim(), consts(ctx)) : null;
    if (fv != null && tv != null) {
      if (tv - fv >= SPAN) out.push({ index, variant: "span" });
      return;
    }
    // relative: the widest toBlock - fromBlock the two expressions allow (toBlock defaults to latest)
    const fo = offsetRange(f, ctx);
    const tr = to != null ? offsetRange(resolve(to, ctx), ctx) : { max: 0n, names: new Set() };
    if (tr.max - fo.min >= SPAN) {
      if (![...fo.names, ...tr.names].some((n) => flaggedConsts.has(n))) out.push({ index, variant: "span" });
      return;
    }
    if (FIXED_FROM.test(f) && toIsHead(to, ctx)) out.push({ index });
  };
  if (ctx.kind === "js") {
    for (const m of hits(LOG_CALL, ctx)) {
      const r = rangeOf(m[1], callArgs(s, m));
      if (r) check(m.index, r.from, r.to);
    }
  }
  for (const m of hits(LOG_RPC, ctx)) {
    const w = s.slice(m.index, m.index + 600);
    const f = /["']?fromBlock["']?\s*:\s*([^,}\n]+)/.exec(w);
    const t = /["']?toBlock["']?\s*:\s*([^,}\n]+)/.exec(w);
    if (f) check(m.index, f[1].replace(/\\"/g, '"'), t ? t[1].replace(/\\"/g, '"') : null);
  }
  if (ctx.kind === "shell" || ctx.kind === "yaml" || ctx.kind === "md") {
    for (const m of hits(R5_CAST, ctx)) {
      const cmd = m[0];
      const f = /--from-block[ \t=]+["']?(\w+)/.exec(cmd);
      const t = /--to-block[ \t=]+["']?(\w+)/.exec(cmd);
      const fv = f ? evalInt(f[1], null) : null;
      const tv = t ? evalInt(t[1], null) : null;
      if (fv != null && tv != null) { if (tv - fv >= SPAN) out.push({ index: m.index, variant: "span" }); continue; }
      if (f && /^(?:0|earliest|\d+)$/.test(f[1]) && (!t || t[1] === "latest")) out.push({ index: m.index });
    }
  }
  return out;
}

// ---------- transfer-filter-no-emitter ----------

const R6_CALL = /\b(getLogs|getContractEvents|watchEvent|watchContractEvent|createEventFilter|createContractEventFilter|getPastEvents)\s*\(/g;
const R6_BOUND = /\b([\w$]+)\s*\.\s*(queryFilter|on|once)\s*\(/g;
const R6_RPC = /["']eth_getLogs["']/g;

function mentionsTransfer(text, ctx) {
  if (TOPIC_HEX.test(text) || /\bTRANSFER_TOPIC\b|\btransferTopic\b/i.test(text) || /event\s+Transfer\s*\(/.test(text) ||
    /eventName\s*:\s*["']Transfer["']/.test(text) || /\bfilters\s*\.\s*Transfer\b/.test(text)) return true;
  for (const id of text.match(/[A-Za-z_$][\w$]*/g) || []) {
    const rhs = consts(ctx).get(id);
    if (rhs && (TOPIC_HEX.test(rhs) || /\bTransfer\s*\(/.test(rhs) || /filters\s*\.\s*Transfer\b/.test(rhs))) return true;
  }
  return false;
}

const ADDR_LIT = /^["'`]0x[0-9a-fA-F]{40}["'`]$/;
const TS_SUFFIX = /\s+(?:as|satisfies)\s+[^,;()]*$/;
const FOR_OF = /\bfor\s*(?:await\s*)?\(\s*(?:const|let|var)\s+(\{[^{}]*\}|[A-Za-z_$][\w$]*)\s+of\s+/g;
const ITER_CB = /([\w$.]+|\])\s*\.\s*(?:map|forEach|flatMap|filter|find|some|every)\s*\(\s*(?:async\s+)?(?:\(\s*(\{[^{}]*\}|[A-Za-z_$][\w$]*)[^()]*\)|([A-Za-z_$][\w$]*))\s*=>/g;

const stripTs = (t) => String(t).trim().replace(TS_SUFFIX, "").trim();

function combine(kinds) {
  const k = new Set(kinds);
  if (k.has("both") || (k.has("system") && k.has("usdc"))) return "both";
  if (k.has("usdc")) return "usdc";
  if (k.has("system")) return "system";
  return "other";
}

/** Elements of an array literal, or of a const that holds one (`as const` allowed); null otherwise. */
function arrayElements(expr, ctx) {
  const e = stripTs(resolve(stripTs(expr), ctx));
  return e.startsWith("[") && e.endsWith("]") ? splitTopLevel(e.slice(1, -1)) : null;
}

/** Loop bindings in the file: for (const x of ARR) and ARR.map((x) => …) (forEach, flatMap, …). Cached. */
function loopBindings(ctx) {
  if (ctx._loops) return ctx._loops;
  const s = ctx.full;
  const loops = [];
  let n = 0;
  FOR_OF.lastIndex = 0;
  for (let m; (m = FOR_OF.exec(s)) && n++ < MAX_HITS;) {
    const open = s.indexOf("(", m.index);
    const end = balancedEnd(s, open, 2000);
    if (end > 0) loops.push({ index: m.index, binding: m[1], iterable: s.slice(m.index + m[0].length, end - 1) });
  }
  n = 0;
  ITER_CB.lastIndex = 0;
  for (let m; (m = ITER_CB.exec(s)) && n++ < MAX_HITS;) {
    let iterable = m[1];
    if (iterable === "]") {
      const open = enclosingOpen(s, m.index, "[", 3000);
      if (open < 0) continue;
      iterable = s.slice(open, m.index + 1);
    }
    loops.push({ index: m.index, binding: m[2] || m[3], iterable });
  }
  ctx._loops = loops;
  return loops;
}

/**
 * What a loop variable named `name` iterates over, from the nearest binding before `at`:
 * { elements, prop } where prop is the key a destructured binding ({ address } or { address: a }) reads.
 */
function loopOver(name, at, ctx) {
  let best = null;
  for (const l of loopBindings(ctx)) {
    if (l.index >= at || (best && l.index < best.index)) continue;
    let prop = null;
    if (l.binding.startsWith("{")) {
      for (const part of splitTopLevel(l.binding.slice(1, -1))) {
        const d = /^([A-Za-z_$][\w$]*)\s*(?::\s*([A-Za-z_$][\w$]*))?/.exec(part);
        if (d && (d[2] || d[1]) === name) prop = d[1];
      }
      if (!prop) continue;
    } else if (l.binding !== name) continue;
    best = { index: l.index, iterable: l.iterable, prop };
  }
  if (!best) return null;
  const elements = arrayElements(best.iterable, ctx);
  return elements ? { elements, prop: best.prop } : null;
}

/** el.prop for an object literal element (or a const holding one); the element itself when prop is null. */
function memberOf(el, prop, ctx) {
  if (!prop) return el;
  let e = stripTs(el);
  if (!e.startsWith("{")) e = stripTs(resolve(e, ctx));
  if (!e.startsWith("{")) return null;
  return objectEntries(e.slice(1, -1)).get(prop) ?? null;
}

/**
 * system | usdc | both | other. Decided by value where the value can be found (a literal address, a const,
 * an array, a loop variable over a const array, ARR.map((e) => e.address)); by name only as a last resort.
 */
function classifyAddress(v, ctx, at = ctx.full.length, depth = 0) {
  if (depth > 3) return "other";
  let t = stripTs(v);
  const each = (vals) => combine(vals.filter((x) => x != null).map((x) => classifyAddress(x, ctx, at, depth + 1)));
  if (t.startsWith("[")) return each(splitTopLevel(t.slice(1, -1)));
  const mm = /^([A-Za-z_$][\w$]*)(?:\s*\??\.\s*([A-Za-z_$][\w$]*))?$/.exec(t);
  if (mm && !consts(ctx).has(mm[1])) {
    const loop = loopOver(mm[1], at, ctx);
    if (loop && !(loop.prop && mm[2])) {
      const vals = loop.elements.map((el) => memberOf(el, loop.prop || mm[2] || null, ctx)).filter((x) => x != null);
      if (vals.length) return each(vals);
    }
  }
  const mp = /^([\w$.]+|\[[\s\S]*\])\s*\.\s*map\s*\(\s*\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>\s*\2\s*\.\s*([A-Za-z_$][\w$]*)\s*\)$/.exec(t);
  if (mp) {
    const els = arrayElements(mp[1], ctx);
    if (els) return each(els.map((el) => memberOf(el, mp[3], ctx)));
  }
  t = stripTs(resolve(t, ctx));
  if (t.startsWith("[")) return classifyAddress(t, ctx, at, depth + 1);
  if (SYS_HEX.test(t)) return "system";
  if (USDC_HEX.test(t)) return "usdc";
  if (ADDR_LIT.test(t)) return "other"; // a literal address decides by value, whatever the const is called
  if (/emitter|native_?usdc|system/i.test(t)) return "system";
  if (/usdc/i.test(t)) return "usdc";
  return "other";
}

/**
 * `{ ...x.filters.Transfer(…) }` or `{ ...filter }` with filter = x.filters.Transfer(…): ethers filters
 * carry x's address, so classify x. null = no spread, "unknown" = a spread we cannot resolve.
 */
function spreadEmitter(body, ctx) {
  let kind = null;
  for (const part of splitTopLevel(body)) {
    if (!part.startsWith("...")) continue;
    const src = resolve(part.slice(3).trim(), ctx);
    const m = /^(?:await\s+)?([\w$.]+?)\s*\.\s*filters\s*\.\s*\w+\s*\(/.exec(src);
    if (!m) return "unknown";
    const recv = m[1].split(".").pop();
    kind = /emitter|system|native_?usdc/i.test(recv) ? "system" : /usdc/i.test(recv) ? "usdc" : "other";
  }
  return kind;
}

/** Every match in the whole file (bounded), not only near the added text. */
function* allHits(re, s) {
  re.lastIndex = 0;
  let n = 0;
  let m;
  while ((m = re.exec(s)) && n++ < MAX_HITS) {
    if (m[0].length === 0) re.lastIndex++;
    yield m;
  }
}

/**
 * Every Transfer log filter in the file: [{ index, end, kind }], kind none (no address) | usdc | system |
 * both | other. [index, end) spans the call and its arguments, so an edit to the address line counts.
 */
function transferSites(ctx) {
  const s = ctx.full;
  const sites = [];
  for (const m of allHits(R6_CALL, s)) {
    const body = callArgs(s, m);
    const end = m.index + m[0].length + body.length + 1;
    const args = splitTopLevel(body);
    if (m[1] === "getPastEvents") {
      // web3.js: contract-bound; first arg is the event name.
      const recv = s.slice(Math.max(0, m.index - 80), m.index);
      if (/["']Transfer["']/.test(args[0] || "") && /usdc[\w$]*\s*\.\s*$/i.test(recv)) sites.push({ index: m.index, end, kind: "usdc" });
      continue;
    }
    const objText = args[0];
    if (!objText || !objText.startsWith("{")) continue;
    if (!mentionsTransfer(objText, ctx)) continue;
    const e = objectEntries(objText.slice(1, -1));
    if (!e.has("address")) {
      const spread = spreadEmitter(objText.slice(1, -1), ctx);
      if (spread === "unknown") continue; // a spread we cannot read may carry the address
      sites.push({ index: m.index, end, kind: spread || "none" });
      continue;
    }
    const addr = e.get("address");
    // shorthand `address`: known only when it is a loop binding over a const array
    if (addr === "address" && !loopOver("address", m.index, ctx)) continue;
    sites.push({ index: m.index, end, kind: classifyAddress(addr, ctx, m.index) });
  }
  for (const m of allHits(R6_BOUND, s)) {
    if (!/usdc/i.test(m[1])) continue;
    const body = callArgs(s, m);
    const a0 = splitTopLevel(body)[0] || "";
    if (!/^["']Transfer["']$/.test(a0) && !mentionsTransfer(a0, ctx)) continue;
    sites.push({ index: m.index, end: m.index + m[0].length + body.length + 1, kind: "usdc" });
  }
  for (const m of allHits(R6_RPC, s)) {
    const w = s.slice(m.index, m.index + 600);
    if (!TOPIC_HEX.test(w) && !/TRANSFER_TOPIC/i.test(w)) continue;
    const a = /["']?address["']?\s*:\s*(\[[^\]]*\]|[^,}\n]+)/.exec(w);
    sites.push({ index: m.index, end: m.index + m[0].length, kind: a ? classifyAddress(a[1], ctx, m.index) : "none" });
  }
  return sites;
}

function transferFilterNoEmitter(ctx) {
  const sites = transferSites(ctx);
  const touched = sites.filter((x) => x.index < ctx.hi && x.end > ctx.lo);
  if (!touched.length) return [];
  // Both emitters read by separate filters in one file: an ERC-20 transfer is in each result.
  const sysSite = sites.some((x) => x.kind === "system");
  const usdcSite = sites.some((x) => x.kind === "usdc");
  const knowsSys = SYS_HEX.test(ctx.full) || /\b(?:NATIVE_USDC_EMITTER|SYSTEM_EMITTER|nativeUsdcEmitter|systemEmitter)\b/.test(ctx.full);
  const out = [];
  for (const x of touched) {
    if (x.kind === "none") out.push({ index: x.index });
    else if (x.kind === "both") out.push({ index: x.index, variant: "both-emitters" });
    else if (x.kind === "usdc") {
      if (sysSite) out.push({ index: x.index, variant: "split-emitters" });
      else if (!knowsSys) out.push({ index: x.index, variant: "usdc-only" });
    } else if (x.kind === "system" && usdcSite && !touched.some((y) => y.kind === "usdc")) {
      out.push({ index: x.index, variant: "split-emitters" });
    }
  }
  return out;
}

// ---------- cctp-stellar-no-forwarder ----------

const R7_KEY = /\b(?:destination_?domain|destDomain|stellar_?(?:cctp_?)?domain)["']?\s*[:=]\s*27\b/gi;
const R7_DOMKEY = /\bdestination_?Domain["']?\s*:\s*(?!27\b)([^,}\n]+)/gi;
const R7_CALL = /\bdepositForBurn(?:WithHook)?\s*\(/g;
const R7_FN = /\bfunctionName\s*:\s*["']depositForBurn(?:WithHook)?["']/g;
// The CCTP forwarder by name or contract id. Deliberately not plain "forwarder": ERC-2771
// trustedForwarder and other forwarders are unrelated.
const FORWARDER_REF = /CctpForwarder|CCTP_?FORWARDER|CBZL2IH7F6BIDAA3WBNXYKIXSATJGMSW7K5P5MJ6STX5RXN47TZJDF5T|CA66Q2WFBND6V4UEB7RD4SAXSVIWMD6RA4X3U32ELVFGXV5PJK4T4VSZ/i;
const FORWARDER_NAME = /^(?:cctp_?|stellar_?)?(?:forwarder|fwd)(?:_?(?:b32|bytes32|hex|address|addr|id|strkey|contract|mainnet|testnet))?$/i;
const ZERO_B32 = /^(?:zeroHash|ZERO_BYTES32|ZeroHash|ethers\.ZeroHash|HashZero|ethers\.constants\.HashZero|constants\.HashZero|bytes32\(0\)|bytes32\(\s*uint256\(0\)\s*\)|["'`]0x0*["'`]|0x0+|zeroAddress)$/;

function isStellarDomain(expr, ctx) {
  const e = String(expr || "").trim();
  if (/stellar/i.test(e)) return true;
  return evalInt(resolve(e, ctx), consts(ctx)) === 27n;
}

/** Does this mintRecipient / destinationCaller expression name CctpForwarder (directly or through consts)? */
function isForwarderExpr(expr, ctx) {
  let e = String(expr || "").trim();
  const seen = new Set();
  for (let i = 0; i < 4 && e; i++) {
    if (FORWARDER_REF.test(e)) return true;
    const ids = (e.match(/[A-Za-z_$][\w$]*/g) || []).filter((id) => !seen.has(id));
    if (ids.some((id) => FORWARDER_NAME.test(id))) return true;
    ids.forEach((id) => seen.add(id));
    e = ids.map((id) => consts(ctx).get(id)).filter(Boolean).join(" ");
  }
  return false;
}

function isZeroB32(expr, ctx) {
  const e = String(expr || "").trim();
  return ZERO_B32.test(e) || ZERO_B32.test(resolve(e, ctx).trim());
}

function cctpStellarNoForwarder(ctx) {
  const out = [];
  const s = ctx.full;
  const hasForwarder = FORWARDER_REF.test(s);
  // recipient / caller: expression text, or null when this site does not show it
  const judge = (index, recipient, caller) => {
    const rF = recipient != null ? isForwarderExpr(recipient, ctx) : null;
    const cZero = caller != null && isZeroB32(caller, ctx);
    const cF = caller != null && !cZero ? isForwarderExpr(caller, ctx) : null;
    if (!hasForwarder && rF !== true && cF !== true) out.push({ index });
    else if (rF === false || cF === false) out.push({ index, variant: "recipient-not-forwarder" });
    else if (cZero) out.push({ index, variant: "zero-caller" });
  };
  const fromObject = (index, at) => {
    const obj = objectAt(s, at);
    const e = obj ? obj.entries : new Map();
    judge(index, e.get("mintRecipient") ?? null, e.get("destinationCaller") ?? null);
  };
  for (const m of hits(R7_KEY, ctx)) fromObject(m.index, m.index);
  for (const m of hits(R7_DOMKEY, ctx)) if (isStellarDomain(m[1], ctx)) fromObject(m.index, m.index);
  const positional = (index, a) => {
    if (a.length >= 3 && isStellarDomain(a[1], ctx)) judge(index, a[2] ?? null, a[4] ?? null);
  };
  // ethers depositForBurn(amount, 27, …) and viem write.depositForBurn([amount, 27, …])
  for (const m of hits(R7_CALL, ctx)) positional(m.index, argList(callArgs(s, m)));
  for (const m of hits(R7_FN, ctx)) {
    const obj = objectAt(s, m.index);
    const args = obj && obj.entries.get("args");
    if (args && args.startsWith("[")) positional(m.index, splitTopLevel(args.slice(1, -1)));
  }
  return out;
}

// ---------- upstream-foundry ----------

const R8 = /\bfoundryup\b|foundry\.paradigm\.xyz|foundry-rs\/foundry-toolchain|(?<![\w./-])forge[ \t]+(?:create|test|script)\b|(?<![\w./-])cast[ \t]+send\b|(?:^|[;&|(`"']|\brun:|\$)[ \t]*(?:npx[ \t]+|nohup[ \t]+|exec[ \t]+)?anvil(?=[ \t]|$|[;&|)]|["'`](?!\s*:))/gm;

// Arc Foundry without Arc mode: a bare `arc-forge test` or `arc-anvil` runs Ethereum rules locally
// (circlefin/arc-foundry README: "arc-forge test  # Ethereum").
const R8_ARC = /(?<![\w./-])arc-(?:forge[ \t]+(?:test|script|coverage|snapshot)|anvil)\b[^\n]*/g;
const PROFILE_SET = /\bFOUNDRY_PROFILE\s*(?::=|[:=])\s*["']?([\w-]+)/;
const NETWORK_SET = /\bFOUNDRY_NETWORK\s*(?::=|[:=])\s*["']?arc\b/;

function arcModeOn(cmd, prefix, ctx) {
  if (/--network(?:[ \t]+|=)["']?arc\b/.test(cmd)) return true;
  // forking or simulating against an RPC recognises the chain id and turns Arc mode on
  if (/(?:^|[ \t])(?:--fork-url|--rpc-url|-f)(?=[ \t=])/.test(cmd)) return true;
  if (NETWORK_SET.test(prefix) || NETWORK_SET.test(ctx.full)) return true;
  const pm = PROFILE_SET.exec(prefix) || PROFILE_SET.exec(ctx.full);
  // Set of foundry.toml profiles that select Arc, or null when no foundry.toml was found
  const profiles = typeof ctx.foundryProfiles === "function" ? ctx.foundryProfiles() : null;
  if (pm) return profiles ? profiles.has(pm[1]) : pm[1] === "arc";
  return !!profiles && profiles.has("default");
}

function upstreamFoundry(ctx) {
  const out = [];
  for (const m of hits(R8, ctx)) {
    out.push({ index: m.index, variant: ctx.isCI ? "ci" : undefined });
    if (out.length >= 3) return out;
  }
  for (const m of hits(R8_ARC, ctx)) {
    // `arc-anvil` in backticks names the tool (a docs table inside a fenced template); not a command
    if (ctx.full[m.index - 1] === "`") continue;
    let cmd = m[0];
    if (ctx.kind === "json") cmd = cmd.replace(/(?<!\\)".*$/, "");
    cmd = cmd.split(/&&|\|\||[;|]/)[0];
    const lineStart = ctx.full.lastIndexOf("\n", m.index - 1) + 1;
    const prefix = ctx.full.slice(lineStart, m.index);
    if (arcModeOn(cmd, prefix, ctx)) continue;
    out.push({ index: m.index, variant: ctx.isCI ? "arc-mode-off-ci" : "arc-mode-off" });
    if (out.length >= 3) break;
  }
  return out;
}

// ---------- extension-from-smart-account ----------

const R9_EXT = /0x5294E9927c3306DcBaDb03fe70b92e01cCede505|0x522fAf9A91c41c443c66765030741e4AaCe147D0|\bmulticall3From\w*|\bMULTICALL3_?FROM\w*|\bmemo(?:Contract|Address)\b|\bMEMO_(?:ADDRESS|CONTRACT)\b|\bfunctionName\s*:\s*["']memo["']/gi;
const R9_SA = /\b(?:sendUserOperation|prepareUserOperation|toCircleSmartAccount|toSafeSmartAccount|toKernelSmartAccount|toSimpleSmartAccount|toLightSmartAccount|toCoinbaseSmartAccount|toNexusSmartAccount|toBiconomySmartAccount|toThirdwebSmartAccount|toEcdsaKernelSmartAccount|createSmartAccountClient|createBundlerClient|bundlerClient|toModularTransport)\b|@safe-global\/|\bSafe\.init\b|\bprotocolKit\b/g;
const R9_SOL_CALL = /\.\s*(?:memo|aggregate3)\s*\(/g;
const R9_SOL_CTX = /0x5294E9927c3306DcBaDb03fe70b92e01cCede505|0x522fAf9A91c41c443c66765030741e4AaCe147D0|\bI?Memo\b(?!\s*\()|\bI?Multicall3From\b/;

function extensionFromSmartAccount(ctx) {
  const s = ctx.full;
  if (ctx.kind === "sol") {
    if (/\.(?:t|s)\.sol$/.test(ctx.file || "") || !(R9_SOL_CTX.test(s) || /0x5294E9927c3306DcBaDb03fe70b92e01cCede505|0x522fAf9A91c41c443c66765030741e4AaCe147D0/i.test(s))) return [];
    for (const m of hits(R9_SOL_CALL, ctx)) return [{ index: m.index, variant: "contract-caller" }];
    return [];
  }
  R9_EXT.lastIndex = 0;
  R9_SA.lastIndex = 0;
  if (!R9_EXT.test(s) || !R9_SA.test(s)) return [];
  let first = null;
  for (const re of [R9_EXT, R9_SA]) {
    for (const m of hits(re, ctx, 0)) { if (first == null || m.index < first) first = m.index; break; }
  }
  return first == null ? [] : [{ index: first }];
}

// ---------- multicall3from-value ----------

const MC3F_CTX = /0x522fAf9A91c41c443c66765030741e4AaCe147D0|multicall3From/i;
const R10_NAME = /\baggregate3Value\b|\bCall3Value\b/g;
const R10_FN = /\bfunctionName\s*:\s*["']aggregate3["']/g;
const R10_SOL = /\.\s*aggregate3\s*\{\s*value\s*:/g;
const R10_CALL = /\b[\w$]*multicall3From[\w$]*\s*(?:\.\s*connect\([^()]{0,80}\))?\s*(?:\.\s*(?:write|simulate|estimateGas))?\s*\.\s*aggregate3\s*\(/gi;
const ZERO_VALUE = /^(?:0n?|BigInt\(\s*0\s*\)|0x0+|["']0["'])$/;

function multicall3fromValue(ctx) {
  const out = [];
  const s = ctx.full;
  if (!MC3F_CTX.test(s)) return out;
  for (const m of hits(R10_NAME, ctx)) out.push({ index: m.index });
  if (ctx.kind === "sol") {
    for (const m of hits(R10_SOL, ctx)) out.push({ index: m.index });
    return out;
  }
  for (const m of hits(R10_FN, ctx)) {
    const obj = objectAt(s, m.index);
    if (!obj || !obj.entries.has("value")) continue;
    if (ZERO_VALUE.test(obj.entries.get("value"))) continue;
    if (MC3F_CTX.test(obj.body) || MC3F_CTX.test(resolve(obj.entries.get("address") || "", ctx))) out.push({ index: m.index });
  }
  for (const m of hits(R10_CALL, ctx)) {
    const args = splitTopLevel(callArgs(s, m));
    const last = args[args.length - 1] || "";
    if (args.length >= 2 && last.startsWith("{")) {
      const v = objectEntries(last.slice(1, -1)).get("value");
      if (v != null && !ZERO_VALUE.test(v)) out.push({ index: m.index });
    }
  }
  return out;
}

// ---------- registry ----------

export const RULES = {
  "usdc-native-value-6dp": { kinds: ["js", "sol"], check: usdcNativeValue6dp },
  "usdc-erc20-amount-18dp": { kinds: ["js", "sol", "shell", "yaml"], check: usdcErc20Amount18dp },
  "usdc-balance-summed": { kinds: ["js", "sol"], check: usdcBalanceSummed },
  "fee-below-floor": { kinds: ["js", "shell", "yaml", "toml", "md"], check: feeBelowFloor },
  "getlogs-unpaged": { kinds: ["js", "shell", "yaml", "md"], check: getlogsUnpaged },
  "transfer-filter-no-emitter": { kinds: ["js"], check: transferFilterNoEmitter },
  "cctp-stellar-no-forwarder": { kinds: ["js", "sol"], check: cctpStellarNoForwarder },
  "upstream-foundry": { kinds: ["shell", "yaml", "md", "json"], check: upstreamFoundry },
  "extension-from-smart-account": { kinds: ["js", "sol"], check: extensionFromSmartAccount },
  "multicall3from-value": { kinds: ["js", "sol"], check: multicall3fromValue },
};

export const RULE_IDS = Object.keys(RULES);

/** Run every enabled rule that applies to ctx.kind. Returns [{ id, index, variant }], deduped by id+index. */
export function runRules(ctx, enabled = RULE_IDS) {
  const out = [];
  const seen = new Set();
  for (const id of enabled) {
    const rule = RULES[id];
    if (!rule || !rule.kinds.includes(ctx.kind)) continue;
    let res = [];
    try { res = rule.check(ctx) || []; } catch { res = []; } // a rule bug never breaks the hook
    for (const f of res) {
      const key = `${id}:${f.index}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ id, index: f.index, variant: f.variant });
    }
  }
  return out;
}

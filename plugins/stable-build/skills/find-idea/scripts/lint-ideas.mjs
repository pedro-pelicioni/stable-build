#!/usr/bin/env node
// Checks a find-idea output file: 5 ranked ideas in the template's shape, sources with dates,
// a deadline or "none open" in every program line, no program that is expired or closed for
// applications (../../../data/programs.json), no roadmap block used as required, and the wording
// rules. Usage: node lint-ideas.mjs <file.md | -> [--now=ISO]   Exit: 0 ok, 1 problems, 2 usage error.
// "-" reads the text from stdin, so ideas shown only in chat are checked without writing a file.
// Both templates in ../SKILL.md pass: English, and pt-BR with Portuguese field labels and values.
// The wording rules are checked in both languages on every line, whatever the template.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const nowArg = argv.find((a) => a.startsWith("--now="));
const file = argv.find((a) => a === "-" || !a.startsWith("-"));
const NOW = nowArg ? new Date(nowArg.slice(6)) : new Date();
if (!file || Number.isNaN(NOW.getTime())) {
  console.error("usage: node lint-ideas.mjs <ideas.md | -> [--now=ISO]   (- reads stdin)");
  process.exit(2);
}
let text;
try {
  text = readFileSync(file === "-" ? 0 : file, "utf8");
} catch (e) {
  console.error(`cannot read ${file === "-" ? "stdin" : file}: ${e.message}`);
  process.exit(2);
}
// Composed accents, so "ç" typed as c + U+0327 matches the same patterns as "ç".
text = text.normalize("NFC");

const errors = [];

// A whole word that may start or end with an accented letter. JavaScript's \b knows only ASCII
// letters, so it finds no boundary before "ótimo" and a false one inside "transação".
const L = "[\\p{L}\\p{N}_]";
const word = (src, flags = "iu") => new RegExp(`(?<!${L})(?:${src})(?!${L})`, flags);

// English. APR/APY/ROI are matched in capitals only, so the month "Apr" passes. Bare "returns" is
// fine ("the call returns a hash"); returns or interest that someone earns or is promised are not.
// "official" is flagged only as a claim about an app, product or partnership ("the official Arc
// docs" is a neutral reference).
const BANNED_EN = [
  [/\byields?\b|\bannual percentage (rate|yield)\b/i, "return wording"],
  [/\b(APR|APY|ROI)s?\b/, "return wording"],
  [/\breturns?\s+(on|of)\b|\b(high|higher|steady|stable|guaranteed|expected|attractive|competitive|consistent|strong)\s+returns?\b/i, "return wording"],
  [/\b(earn|earns|earned|earning)\b[^.;]{0,40}?\b(returns?|interest)\b/i, "return wording"],
  [/\bpassive income\b|\bguaranteed\b|\brisk[- ]free\b/i, "promise wording"],
  [/\bofficial (arc|circle)(\s+[\w-]+){0,2}?\s+(partners?|apps?|applications?|products?|integrations?|projects?|plugins?)\b|\bofficial partners?\b|\bofficially (endorsed|supported|approved) by (arc|circle)\b|\bpartner(ed)? with (arc|circle)\b/i, "affiliation claim"],
  [/\bendorsed by (arc|circle)\b|\b(circle|arc)[- ]backed\b|\bbacked by (arc|circle)\b/i, "affiliation claim"],
];
// Portuguese (pt-BR), the same rules. "retorno" alone is fine too ("o valor de retorno da função",
// "dê um retorno ao usuário"); a return that is promised, sized or financial is not. "oficial" is
// flagged only after an app-like noun ("a documentação oficial da Arc" is neutral), and "aprovado
// pela Circle" or "patrocinado pela Circle" can be neutral facts (StableFX access, a hackathon).
// "sem risco" is a promise; "sem risco de pagar duas vezes" names one specific failure, like English.
const ARC = "(?:a\\s+|o\\s+)?(?:arc|circle)";
const BANNED_PT = [
  [word("rendimentos?|rentabilidade|rent[áa]ve(?:l|is)|lucr(?:o|os|ar|a|am|ativ[oa]s?|atividade)|dividendos?"), "return wording"],
  [word("retornos?\\s+(?:garantid[oa]s?|financeir[oa]s?|esperad[oa]s?|alt[oa]s?|elevad[oa]s?|atraentes?|atrativ[oa]s?|est[áa]ve(?:l|is)|consistentes?|fix[oa]s?|cert[oa]s?|segur[oa]s?|anua(?:l|is)|mensa(?:l|is)|sobre\\s+(?:o\\s+)?(?:investimento|capital|aporte)|d[eo]\\s+investimento|de\\s+(?:at[ée]\\s+)?\\d+(?:[.,]\\d+)?\\s*%)"), "return wording"],
  [word("(?:alt[oa]s?|elevad[oa]s?|garantid[oa]s?|[óo]tim[oa]s?|excelentes?|maior(?:es)?)\\s+retornos?|\\d+(?:[.,]\\d+)?\\s*%\\s+de\\s+retorno"), "return wording"],
  [word("(?:ganh|receb|rend)\\p{L}*[^.;]{0,40}?(?<!\\p{L})juros|juros\\s+(?:sobre\\s+(?:o\\s+)?saldo|compostos)|ganhos?\\s+(?:passiv[oa]s?|financeir[oa]s?|garantid[oa]s?)"), "return wording"],
  [word("\\d+(?:[.,]\\d+)?\\s*%\\s*(?:d[oa]\\s+)?CDI"), "return wording"],
  [word("renda\\s+(?:passiva|extra|fixa|garantida)|garantid[oa]s?|sem\\s+riscos?(?!\\s+de\\s)|livre\\s+de\\s+riscos?|risco\\s+zero|zero\\s+risco|dinheiro\\s+f[áa]cil"), "promise wording"],
  [word(`(?:apps?|aplicativos?|aplica[çc](?:[ãa]o|[õo]es)|produtos?|integra[çc](?:[ãa]o|[õo]es)|projetos?|plugins?|solu[çc](?:[ãa]o|[õo]es)|parceir[oa]s?|parcerias?)\\s+oficia(?:l|is)|oficialmente\\s+(?:apoiad|endossad|aprovad|suportad|reconhecid|certificad)\\p{L}*|parceri[ao]s?\\s+(?:com|d[aeo])\\s+${ARC}|parceir[oa]s?\\s+d[ao]\\s+(?:arc|circle)`), "affiliation claim"],
  [word(`(?:apoiad|endossad|respaldad|chancelad)[oa]s?\\s+(?:pel[ao]|por)\\s+${ARC}`), "affiliation claim"],
];
const BANNED = [...BANNED_EN, ...BANNED_PT];
const lines = text.split(/\r?\n/);
lines.forEach((line, i) => {
  const seen = new Set(); // one report per reason per line
  for (const [re, why] of BANNED) {
    const m = line.match(re);
    if (m && !seen.has(why)) { seen.add(why); errors.push(`line ${i + 1}: ${why} "${m[0]}"`); }
  }
});

const heads = [...text.matchAll(/^##\s+(\d+)\.\s+(.+)$/gm)];
const nums = heads.map((h) => Number(h[1]));
if (heads.length !== 5) errors.push(`expected 5 ideas (## 1. … ## 5.), found ${heads.length}`);
else if (nums.join() !== "1,2,3,4,5") errors.push(`ideas must be numbered 1 to 5 in order, found ${nums.join(",")}`);

// Field labels of the English template and of the pt-BR template (find-idea SKILL.md). Either label
// is accepted on each line. `value` is what must follow the label; `empty` allows nothing after it.
const OVERLAP = ["none", "adjacent", "direct", "nenhuma", "adjacente", "direta"];
const FIELDS = [
  { en: "Frontier", pt: "Fronteira" },
  { en: "Blocks", pt: "Blocos" },
  { en: "Closest starter or sample app", pt: "Starter ou app de exemplo mais próximo" },
  { en: "Overlap", pt: "Sobreposição", value: new RegExp(`^\\s+(?:${OVERLAP.join("|")})(?!${L})`, "iu") },
  { en: "Program fit", pt: "Programa compatível" },
  { en: "First 2 hours", pt: "Primeiras 2 horas", empty: true },
  { en: "Sources", pt: "Fontes" },
];
const [FRONTIER, BLOCKS, , , PROGRAM, HOURS, SOURCES] = FIELDS;
const labelRe = (f) => `(?:${f.en}|${f.pt}):`;
/** The text after the field's label on its line, or null when the line is missing. */
const field = (body, f) => {
  const m = body.match(new RegExp(`^-\\s+\\*\\*${labelRe(f)}\\*\\*(.*)$`, "mu"));
  return m ? m[1] : null;
};
const named = (f) => `"${f.en}" (pt-BR "${f.pt}")`;
const DATE = /\b\d{4}-\d{2}-\d{2}(?!\d)/;
const NONE_OPEN = /none open|nenhum aberto/i;
const LATER = /;\s*(?:later|depois):/i;

for (let k = 0; k < heads.length; k++) {
  const start = heads[k].index;
  const end = k + 1 < heads.length ? heads[k + 1].index : text.length;
  const body = text.slice(start, end);
  const tag = `idea ${heads[k][1]}`;
  for (const f of FIELDS) {
    const v = field(body, f);
    const ok = v !== null && (f.empty || (f.value ? f.value.test(v) : /^\s+\S/.test(v)));
    if (!ok) errors.push(`${tag}: missing or malformed ${named(f)} line`);
  }
  const frontier = field(body, FRONTIER) || "";
  if (frontier && !/\b[1-4]\b/.test(frontier)) errors.push(`${tag}: Frontier line must name frontier 1-4`);
  if (frontier && !/https:\/\//.test(frontier)) errors.push(`${tag}: Frontier line must link the RFB`);
  const required = (field(body, BLOCKS) || "").split(LATER)[0];
  if (/privacy|privacidade/i.test(required)) errors.push(`${tag}: Arc Privacy is roadmap; list it only after "later:" (pt-BR "depois:")`);
  const program = field(body, PROGRAM) || "";
  if (program && !DATE.test(program) && !NONE_OPEN.test(program))
    errors.push(`${tag}: Program fit needs a deadline date (YYYY-MM-DD) or "none open" (pt-BR "nenhum aberto")`);
  const sources = field(body, SOURCES) || "";
  if (sources && (!/https:\/\//.test(sources) || !DATE.test(sources)))
    errors.push(`${tag}: Sources need at least one https URL and a retrieved date`);
  const steps = (body.split(new RegExp(`\\*\\*${labelRe(HOURS)}\\*\\*`, "u"))[1] || "")
    .split(new RegExp(`^-\\s+\\*\\*${labelRe(SOURCES)}`, "mu"))[0];
  const n = (steps.match(/^\s+\d+\.\s+\S/gm) || []).length;
  if (n < 3) errors.push(`${tag}: First 2 hours needs at least 3 numbered steps, found ${n}`);
  if (keyMaterial(body)) errors.push(`${tag}: looks like it contains key material`);
  for (const p of unavailablePrograms(program)) errors.push(`${tag}: Program fit names ${p}`);
}
if (!/not affiliated with circle|sem afilia[çc][ãa]o com a circle|n[ãa]o (?:[ée] )?afiliad[oa] [àa] circle/iu.test(text))
  errors.push('missing the closing line "Not affiliated with Circle." (pt-BR "Sem afiliação com a Circle.")');

/**
 * A labelled secret ("private key: ...", PRIVATE_KEY=..., "chave privada: ..."), or a 32-byte hex
 * value on a line that mentions a key or seed. A 32-byte hex value that the line calls a topic, tx
 * or hash (in English or Portuguese) is not one.
 */
function keyMaterial(body) {
  if (/(private[ _-]?key|secret[ _-]?key|seed[ _-]?phrase|mnemonic|chave[ _-]?(privada|secreta)|frase[ _-]?(semente|secreta|de[ _-]recupera[çc][ãa]o)|mnem[ôo]nic[oa])\s*[:=]/iu.test(body)) return true;
  const KEYISH = /private|secret|seed|mnemonic|\bpk\b|signing key|\bkey\b|chave|privada|secreta|semente|mnem[ôo]nic/iu;
  const HASHISH = /\b(topics?|tx|txs|txhash|transactions?|hash(es)?|events?|selector|keccak256|block|receipt)\b|\/tx\/0x|\b(t[óo]picos?|transa[çc](?:[ãa]o|[õo]es)|eventos?|seletor|blocos?|recibos?)(?![\p{L}\p{N}_])/iu;
  return body.split(/\r?\n/).some((l) => /\b0x[0-9a-fA-F]{64}\b/.test(l) && (KEYISH.test(l) || !HASHISH.test(l)));
}

/** Programs named on a Program fit line that are expired or no longer take applications. */
function unavailablePrograms(line) {
  if (!line) return [];
  let items = [];
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    items = JSON.parse(readFileSync(path.join(here, "..", "..", "..", "data", "programs.json"), "utf8")).items || [];
  } catch {
    return []; // the data file is optional for this check
  }
  // A date without a time is valid through the end of that day anywhere on Earth (UTC-12).
  const end = (d) => new Date(/T/.test(d) ? d : `${d}T23:59:59.999-12:00`);
  const lower = line.toLowerCase();
  const out = [];
  for (const it of items) {
    const name = String(it.name || "").replace(/\s*\([^)]*\)/g, "").trim().toLowerCase();
    const mentioned = (name && lower.includes(name)) || (it.apply_url && lower.includes(String(it.apply_url).toLowerCase()));
    if (!mentioned) continue;
    if (it.valid_until && end(it.valid_until) < NOW) out.push(`${it.name}, which ended on ${it.valid_until}`);
    else if (it.applications_closed && end(it.applications_closed) < NOW)
      out.push(`${it.name}, whose applications closed on ${it.applications_closed}; do not list it as a fit`);
  }
  return out;
}

for (const e of errors) console.error(`lint-ideas: ${e}`);
console.log(`lint-ideas: ${errors.length ? "FAIL" : "ok"} (${heads.length} ideas, ${errors.length} problem(s)) ${file}`);
process.exit(errors.length ? 1 : 0);

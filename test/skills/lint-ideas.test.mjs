// Unit tests for plugins/stable-build/skills/find-idea/scripts/lint-ideas.mjs: wording rules in
// English and Portuguese (no false positives on neutral text, no misses on return claims), the
// pt-BR template's labels, key material, and programs that are expired or closed for applications.
// Run: node --test test/skills/lint-ideas.test.mjs
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKILL = join(ROOT, "plugins", "stable-build", "skills", "find-idea");
const LINT = join(SKILL, "scripts", "lint-ideas.mjs");
const PROGRAMS = JSON.parse(readFileSync(join(ROOT, "plugins", "stable-build", "data", "programs.json"), "utf8")).items;
const FAKE_KEY = `0x${"1f".repeat(32)}`; // key-shaped, not a real key
const DIR = mkdtempSync(join(tmpdir(), "sb-lint-ideas-"));
after(() => rmSync(DIR, { recursive: true, force: true }));

function idea(n, { program = "none open; see the Arc House events hub", extra = "" } = {}) {
  return `## ${n}. Idea ${n}: one-line pitch
- **Frontier:** 1 Global money / Borderless payroll (https://www.arc.io/blog/example)
- **Blocks:** usdc (live), memo (live); later: arc-privacy (roadmap, not available)
- **Closest starter or sample app:** payouts starter (stable-build:new-app), reuse the CSV flow
- **Overlap:** adjacent: listed in the directory; receipts differ
- **Program fit:** ${program}
- **Score:** 30/35 (fits the profile)
- **First 2 hours:**
  1. Get testnet USDC at https://faucet.circle.com
  2. Scaffold with stable-build:new-app
  3. Send one testnet payout and open it on https://explorer.testnet.arc.io
- **Sources:** https://docs.arc.io/arc/concepts/transaction-memos (retrieved 2026-10-04)
${extra}
`;
}
function doc(opts = {}) {
  const ideas = [1, 2, 3, 4, 5].map((n) => idea(n, n === 1 ? opts : {})).join("\n");
  return `# Ideas to build on Arc (2026-10-04)\n\nProfile: solo dev. Assumed: none.\n\n${ideas}\nNot affiliated with Circle. No investment, legal or tax advice.\n`;
}
// The pt-BR template of find-idea SKILL.md: Portuguese labels, values and closing line.
function ideaPt(n, { program = "nenhum aberto; veja o hub de eventos do Arc House", overlap = "adjacente", extra = "" } = {}) {
  return `## ${n}. Ideia ${n}: folha de pagamento em USDC a partir de um CSV
- **Fronteira:** 1 Dinheiro global / Folha de pagamento sem fronteiras (https://www.arc.io/blog/example)
- **Blocos:** usdc (live), memo (live); depois: arc-privacy (roadmap, não disponível)
- **Starter ou app de exemplo mais próximo:** starter payouts (stable-build:new-app), reaproveita o fluxo de CSV
- **Sobreposição:** ${overlap}: listado no diretório; os recibos são diferentes
- **Programa compatível:** ${program}
- **Pontuação:** 30/35 (combina com o perfil)
- **Primeiras 2 horas:**
  1. Pegue USDC de testnet em https://faucet.circle.com
  2. Gere o projeto com stable-build:new-app
  3. Envie um pagamento de teste e abra em https://explorer.testnet.arc.io
- **Fontes:** https://docs.arc.io/arc/concepts/transaction-memos (consultado em 2026-10-04)
${extra}
`;
}
const CLOSING_PT = "Sem afiliação com a Circle. Não é aconselhamento de investimento, jurídico ou tributário.";
function docPt(opts = {}, closing = CLOSING_PT) {
  const ideas = [1, 2, 3, 4, 5].map((n) => ideaPt(n, n === 1 ? opts : {})).join("\n");
  return `# Ideias para construir na Arc (2026-10-04)\n\nPerfil: dev solo. Suposições: nenhuma.\n\n${ideas}\n${closing}\n`;
}
let k = 0;
function lint(text, ...args) {
  const f = join(DIR, `ideas-${k++}.md`);
  writeFileSync(f, text);
  return spawnSync(process.execPath, [LINT, f, ...args], { encoding: "utf8" });
}

describe("lint-ideas", () => {
  test("a well-formed file passes", () => {
    const p = lint(doc());
    assert.equal(p.status, 0, p.stderr);
  });

  test("neutral text is not flagged", () => {
    for (const extra of [
      "Note: Developer Grants re-verify by Apr 2027.",
      "Check the official Arc docs for the Memo ABI.",
      "Filter Transfer topic 0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef from the system emitter.",
      "Open https://explorer.testnet.arc.io/tx/0xda546e55a0731e8d21d57f8c467e19d73968082ea3496a8a3031e5a0d435ebf2 to see the receipt.",
      "The batch call returns a receipt with one Memo event per row.",
    ]) {
      const p = lint(doc({ extra }));
      assert.equal(p.status, 0, `${extra}\n${p.stderr}`);
    }
  });

  test("return, promise, affiliation and key wording is flagged", () => {
    for (const [extra, why] of [
      ["Treasury users earn attractive returns and interest on idle balances.", /return wording/],
      ["Holders earn interest every block.", /return wording/],
      ["Shows the APY of each vault.", /return wording/],
      ["A steady yield for savers.", /return wording/],
      ["Payouts are risk-free.", /promise wording/],
      ["Launch it as the official Arc payroll app.", /affiliation claim/],
      ["We partnered with Circle for launch.", /affiliation claim/],
      [`PRIVATE_KEY=${FAKE_KEY}`, /key material/],
      [`Sign with ${FAKE_KEY}.`, /key material/],
    ]) {
      const p = lint(doc({ extra }));
      assert.equal(p.status, 1, extra);
      assert.match(p.stderr, why, extra);
    }
  });

  test("a program that is closed for applications or expired is not a fit", (t) => {
    const closed = PROGRAMS.find((p) => p.applications_closed && !/T/.test(p.applications_closed));
    if (!closed) { t.skip("no program with applications_closed in programs.json"); return; }
    const name = closed.name.replace(/\s*\([^)]*\)/g, "");
    const line = `${name}, deadline ${closed.valid_until} (10 days left), mainnet deploy`;
    const day = (d, n) => new Date(new Date(`${d}T12:00:00Z`).getTime() + n * 86400e3).toISOString();
    let p = lint(doc({ program: line }), `--now=${day(closed.applications_closed, 2)}`);
    assert.equal(p.status, 1, p.stdout);
    assert.match(p.stderr, /applications closed/);
    p = lint(doc({ program: line }), `--now=${day(closed.applications_closed, -2)}`);
    assert.equal(p.status, 0, p.stderr);
    if (!/T/.test(closed.valid_until)) {
      p = lint(doc({ program: line }), `--now=${day(closed.valid_until, 2)}`);
      assert.match(p.stderr, /which ended on/);
    }
  });

  test("the pt-BR template passes, with Portuguese labels, values and closing line", () => {
    for (const overlap of ["nenhuma", "adjacente", "direta", "Adjacente"]) {
      const p = lint(docPt({ overlap }));
      assert.equal(p.status, 0, `${overlap}\n${p.stderr}`);
    }
    const p = lint(docPt({ program: "Microgrants, prazo 2099-01-31 (30 dias restantes), deploy na mainnet" }));
    assert.equal(p.status, 0, p.stderr);
    // NFD text (c + U+0327) reads like the composed form
    assert.equal(lint(docPt().normalize("NFD")).status, 0);
  });

  test("the pt-BR template is held to the same shape", () => {
    for (const [text, why] of [
      [docPt({ overlap: "parcial" }), /malformed "Overlap" \(pt-BR "Sobreposição"\)/],
      [docPt({ program: "Microgrants, sem prazo" }), /deadline date .* "nenhum aberto"/],
      [docPt().replace("arc-privacy (roadmap, não disponível)", "x").replace("memo (live); depois:", "memo (live), Arc Privacidade (roadmap);"), /Arc Privacy is roadmap/],
      [docPt().replace(/^- \*\*Fontes:\*\* .*$/m, "- **Fontes:** docs da Arc"), /Sources need/],
      [docPt().replace("- **Primeiras 2 horas:**", "- **Primeiras horas:**"), /"First 2 hours" \(pt-BR "Primeiras 2 horas"\)/],
      [docPt({}, "Não é aconselhamento de investimento."), /closing line/],
    ]) {
      const p = lint(text);
      assert.equal(p.status, 1, String(why));
      assert.match(p.stderr, why);
    }
  });

  test("neutral Portuguese text is not flagged", () => {
    for (const extra of [
      "Nota: o Developer Grants revalida até abr 2027.",
      "Confira a documentação oficial da Arc para a ABI do Memo.",
      "A chamada em lote retorna um recibo com um evento Memo por linha.",
      "O valor de retorno da função é o hash da transação.",
      "Dê um retorno ao usuário quando a transação confirmar.",
      "Renderize o recibo na página de pagamento.",
      "O acesso ao StableFX precisa ser aprovado pela Circle.",
      "Uma garantia de entrega não faz parte do escopo.",
      "Retomada idempotente, sem risco de pagar a mesma linha duas vezes.",
      "Filtre o tópico Transfer 0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef do emissor do sistema.",
      "Abra a transação 0xda546e55a0731e8d21d57f8c467e19d73968082ea3496a8a3031e5a0d435ebf2 no explorer.",
    ]) {
      for (const text of [docPt({ extra }), doc({ extra })]) {
        const p = lint(text);
        assert.equal(p.status, 0, `${extra}\n${p.stderr}`);
      }
    }
  });

  test("Portuguese return, promise, affiliation and key wording is flagged", () => {
    for (const [extra, why] of [
      ["Usuários recebem rendimento sobre o saldo parado.", /return wording "rendimento"/],
      ["Rentabilidade acima da poupança.", /return wording/],
      ["Retorno garantido para quem deposita.", /return wording/],
      ["Um retorno de 12% ao ano.", /return wording/],
      ["Ótimo retorno para a tesouraria.", /return wording "Ótimo retorno"/],
      ["Calcula o retorno sobre o investimento de cada cliente.", /return wording/],
      ["Mostra o APR de cada cofre.", /return wording "APR"/],
      ["Calcula o ROI da tesouraria.", /return wording "ROI"/],
      ["O app gera lucro para quem usa.", /return wording "lucro"/],
      ["Um negócio lucrativo desde o primeiro mês.", /return wording/],
      ["Ganhe juros a cada bloco.", /return wording/],
      ["O saldo rende 110% do CDI.", /return wording/],
      ["Uma fonte de renda passiva.", /promise wording/],
      ["Pagamentos sem risco.", /promise wording/],
      ["Entrega garantida em um bloco.", /promise wording/],
      ["Lance como o app oficial da Arc para folha de pagamento.", /affiliation claim/],
      ["Fechamos parceria com a Circle no lançamento.", /affiliation claim/],
      ["Somos parceiros da Circle.", /affiliation claim/],
      ["Projeto apoiado pela Circle.", /affiliation claim/],
      [`CHAVE_PRIVADA=${FAKE_KEY}`, /key material/],
      [`Assine com a chave privada ${FAKE_KEY}.`, /key material/],
    ]) {
      for (const text of [docPt({ extra }), doc({ extra })]) {
        const p = lint(text);
        assert.equal(p.status, 1, extra);
        assert.match(p.stderr, why, extra);
      }
    }
  });

  test("'-' lints text from stdin, so chat-only ideas need no scratch file", () => {
    const ok = spawnSync(process.execPath, [LINT, "-"], { input: doc(), encoding: "utf8" });
    assert.equal(ok.status, 0, ok.stderr);
    const bad = spawnSync(process.execPath, [LINT, "-", "--now=2026-10-04"], { input: doc({ extra: "Guaranteed returns for holders." }), encoding: "utf8" });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /wording/);
    assert.equal(spawnSync(process.execPath, [LINT], { input: "", encoding: "utf8" }).status, 2);
  });
});

// The "Language" rule every stable-build skill carries, word for word: skills read the language saved
// by install.sh ("language" in $STABLE_BUILD_HOME/config.json) once per session and write what the user
// reads in it, falling back to the user's language when none is saved. Change the wording here and in
// every SKILL.md together.
// Run: node --test test/skills/language.test.mjs
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PLUGIN = join(ROOT, "plugins", "stable-build");
const SKILLS = join(PLUGIN, "skills");
const { LANGUAGES } = await import(pathToFileURL(join(PLUGIN, "scripts", "guard", "prefs.mjs")));

export const LANGUAGE_RULE = [
  "## Language",
  "",
  "Before your first reply in a session, read the saved language once: `cat \"${STABLE_BUILD_HOME:-$HOME/.stable-build}/config.json\" 2>/dev/null`. If it sets `\"language\"`, write everything the user reads in that language (`pt-BR` is Brazilian Portuguese, `en` is English): replies, questions, menus, tables and the documents you generate, such as reports, briefs, PRDs, stories and idea lists. With no saved language, use the user's language. Wherever this skill says \"the user's language\", it means this choice. Keep code, identifiers, file names, paths, frontmatter keys and status values, rule ids, commands, CLI flags, commit messages and verbatim docs quotes in English.",
].join("\n");

const skills = readdirSync(SKILLS, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(SKILLS, d.name, "SKILL.md")))
  .map((d) => ({ name: d.name, file: join(SKILLS, d.name, "SKILL.md") }));

const count = (hay, needle) => hay.split(needle).length - 1;

describe("Language rule in every SKILL.md", () => {
  test("all 16 skills are found", () => {
    assert.ok(skills.length >= 16, `found ${skills.length} skills: ${skills.map((s) => s.name).join(", ")}`);
  });

  for (const s of skills) {
    test(`${s.name} carries the rule word for word, once, as its own section`, () => {
      const md = readFileSync(s.file, "utf8").replace(/\r\n/g, "\n");
      assert.equal(count(md, `\n${LANGUAGE_RULE}\n`), 1, `${s.name}/SKILL.md must contain the Language section exactly once, word for word`);
      assert.equal(count(md, "\n## Language\n"), 1, `${s.name}/SKILL.md has more than one Language heading`);
      // the section ends at the next heading or at the end of the file, so nothing else hides inside it
      const after = md.slice(md.indexOf(`\n${LANGUAGE_RULE}\n`) + LANGUAGE_RULE.length + 2);
      assert.match(after, /^(\s*$|\n#{1,2} )/, `${s.name}: text right after the Language rule must start a new section`);
    });
  }

  test("the rule reads the same config.json as the hooks and names every supported language", () => {
    const run = readFileSync(join(PLUGIN, "scripts", "run.sh"), "utf8");
    assert.ok(run.includes('H="${STABLE_BUILD_HOME:-$HOME/.stable-build}"'));
    assert.ok(run.includes('"$H/config.json"'));
    assert.ok(LANGUAGE_RULE.includes('"${STABLE_BUILD_HOME:-$HOME/.stable-build}/config.json"'));
    for (const code of LANGUAGES) assert.ok(LANGUAGE_RULE.includes(`\`${code}\``), code);
    assert.ok(LANGUAGE_RULE.includes("With no saved language, use the user's language."), "unset keeps today's behavior");
  });

  test("the rule only reads: no writes, no network, no credentials", () => {
    const cmds = [...LANGUAGE_RULE.matchAll(/`([^`]+)`/g)].map((m) => m[1]).filter((c) => /\s/.test(c));
    assert.deepEqual(cmds, ['cat "${STABLE_BUILD_HOME:-$HOME/.stable-build}/config.json" 2>/dev/null']);
    assert.doesNotMatch(LANGUAGE_RULE, />\s*[^&/]|\btee\b|\bcurl\b|\bwget\b|arc-studio|\.env\b|token/i);
  });
});

// find-idea's pt-BR template must produce a list its linter accepts, with every label translated.
describe("find-idea in pt-BR", () => {
  const SKILL = join(SKILLS, "find-idea");
  const LINT = join(SKILL, "scripts", "lint-ideas.mjs");
  const md = readFileSync(join(SKILL, "SKILL.md"), "utf8").replace(/\r\n/g, "\n");

  // The two templates under "## Output template", copied from SKILL.md.
  const block = (lang) => (new RegExp(`\\n${lang}:\\n\\n\`\`\`markdown\\n([\\s\\S]*?)\\n\`\`\`\\n`).exec(md) || [])[1] || "";
  const en = block("English");
  const pt = block("pt-BR");
  const labels = (t) => [...t.matchAll(/^- \*\*([^*]+):\*\*/gm)].map((m) => m[1]);
  const closing = pt.trim().split("\n").pop();

  test("SKILL.md has an English and a pt-BR template with the same fields", () => {
    assert.deepEqual(labels(en), ["Frontier", "Blocks", "Closest starter or sample app", "Overlap", "Program fit", "Score", "First 2 hours", "Sources"]);
    assert.deepEqual(labels(pt), ["Fronteira", "Blocos", "Starter ou app de exemplo mais próximo", "Sobreposição", "Programa compatível", "Pontuação", "Primeiras 2 horas", "Fontes"]);
    assert.match(pt, /\*\*Sobreposição:\*\* <nenhuma \| adjacente \| direta>/);
    assert.match(pt, /\| nenhum aberto$/m);
    assert.match(pt, /; depois: </);
    assert.match(closing, /^Sem afiliação com a Circle\./);
    for (const token of ["`**Fronteira:**`", "`**Fontes:**`", "`nenhuma`", "`adjacente`", "`direta`", "`nenhum aberto`", "`depois:`"]) {
      assert.ok(md.includes(token), `find-idea/SKILL.md should name ${token} for pt-BR`);
    }
  });

  test("a pt-BR idea list written from that template passes lint-ideas.mjs", () => {
    const [frontier, blocks, starter, overlap, program, score, hours, sources] = labels(pt);
    const idea = (n) => `## ${n}. Ideia ${n}: folha de pagamento em USDC a partir de um CSV
- **${frontier}:** 1 Dinheiro global / Folha de pagamento sem fronteiras (https://www.arc.io/blog/the-unfinished-business-of-finance-machine-commerce-and-global-money)
- **${blocks}:** usdc (live), memo (live); depois: arc-privacy (roadmap, não disponível)
- **${starter}:** starter payouts (stable-build:new-app), reaproveita o fluxo de CSV
- **${overlap}:** adjacente: listado no diretório; os recibos são diferentes
- **${program}:** nenhum aberto; veja o hub de eventos do Arc House
- **${score}:** 30/35 (combina com o perfil)
- **${hours}:**
  1. Pegue USDC de testnet em https://faucet.circle.com
  2. Gere o projeto com stable-build:new-app
  3. Envie um pagamento de teste e abra em https://explorer.testnet.arc.io
- **${sources}:** https://docs.arc.io/arc/concepts/transaction-memos (consultado em 2026-10-04)
`;
    const text = `# Ideias para construir na Arc (2026-10-04)\n\nPerfil: dev solo. Suposições: nenhuma.\n\n${[1, 2, 3, 4, 5].map(idea).join("\n")}\n${closing}\n`;
    const p = spawnSync(process.execPath, [LINT, "-", "--now=2026-10-04T12:00:00Z"], { input: text, encoding: "utf8" });
    assert.equal(p.status, 0, p.stderr + p.stdout);
    // the same list with a Portuguese return claim fails
    const bad = spawnSync(process.execPath, [LINT, "-", "--now=2026-10-04T12:00:00Z"], { input: text.replace("combina com o perfil", "rendimento garantido"), encoding: "utf8" });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /return wording/);
  });
});

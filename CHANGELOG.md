# Changelog

This file lists the notable changes to stable-build. It follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and version numbers follow [Semantic Versioning](https://semver.org/).

Every release does three things:

- Bumps `version` in all four plugin manifests and in the root `package.json`. Claude Code keeps users on a version until it changes. `node tools/check-names.mjs --release-tag vX.Y.Z` checks that they all agree.
- Records the upstream versions it was tested against, including the circlefin/skills commit, since that repo has no tags.
- Calls out changes to the guard's rules and any Arc fact that was re-verified.

## [Unreleased]

### Added

- English and Brazilian Portuguese (`pt-BR`) across the kit.
  - Installer: `--lang=<v>` or `--lang <v>`, and `STABLE_BUILD_LANG`. Accepted values, in any case: `en`, `english`, `pt`, `pt-br`, `pt_BR`, `portugues`, `português`. In a terminal, the first prompt is "Language / Idioma: [1] English [2] Português (Brasil)", defaulting from `LC_ALL`, then `LC_MESSAGES`, then `LANG` (`pt*` picks pt-BR). With no terminal, with `--yes` or in an agent session, the detected default is used without a prompt. Precedence: `--lang` > `STABLE_BUILD_LANG` > the saved choice > the prompt or detection. An unknown value exits 1 with a bilingual error. Every message, `--help` and argument errors come from two message tables (`_msg_en`, `_msg_pt`).
  - The choice is saved as `"language"` in `$STABLE_BUILD_HOME/config.json` (atomic write, other keys kept; it never turns the guard on, which still needs `"guard": true`). The manifest records `language` and whether `config.json` was `createdByUs` (or only got `languageAddedByUs`), so `--uninstall` deletes `config.json` only when the installer created it and otherwise removes only the keys it wrote. Reruns, `--update`, `--uninstall` and `--help` reuse the saved choice; `--help` reads it from the `--prefix` sandbox whether `--prefix` comes before or after it. Spaces around a saved value (and around `--lang` and `STABLE_BUILD_LANG` values) are ignored in the installer and the hooks alike.
  - Hooks: the guard's one-line `systemMessage` and the SessionStart notice follow the saved language (`scripts/guard/prefs.mjs`), and `guard.mjs --status` reports it. With `pt-BR` saved, the SessionStart output adds one English line telling the agent to reply in Brazilian Portuguese even when the user writes in English, so plain turns outside a skill follow the saved language too (the hooks run only after guard consent and print only in an Arc project). The agent-facing context, rule ids and docs quotes stay in English.
  - Skills: every `SKILL.md` has a `## Language` section. Skills read the saved language once per session and write replies and generated documents in it; with none saved they answer in the user's language.
  - `find-idea`: a pt-BR output template with Portuguese field labels and values. `lint-ideas.mjs` accepts it, checks the wording rules in Portuguese as well (for example "rendimento", "rentabilidade", "lucro", "retorno garantido", "renda passiva", "juros" someone earns, "garantido", "sem risco", "app oficial", "parceria com a Circle"), and recognizes Portuguese key labels ("chave privada") and hash words ("tópico", "transação").
  - Docs: `README.pt-BR.md` and the payouts template's `README.pt-BR.md`. `tools/check-docs-sync.mjs` keeps each translation in step with its English original (headings, code blocks, cross-links, anchors); it runs in `npm run check`, CI and the release workflow.
  - Tests: `test/install/i18n.test.mjs` (both message tables complete, matching placeholders and argument counts, no untranslated or literal prose), language scenarios L1 to L6 in `test/install/roundtrip.sh`, a pseudo-terminal test of the prompt (`test/install/tty-drive.py`, needs python3), and `test/guard/language.test.mjs` and `test/skills/language.test.mjs`.
- Landing page in `site/`: a static page (no framework, no build step) with an EN/PT toggle, the one-command install, the guard's real before/after on a USDC `Transfer` filter, the journey, the three install paths, Open Graph image and `vercel.json`. One Copy button per command (the dry-run preview and the real install are separate, and each `/plugin` line has its own); the Portuguese copy loads only for Portuguese visitors and is applied before the first paint; no layout shift from the toggle, the Copy buttons or the font swap; credits name the tech-writer's BMad version and Arc Studio's adapted wording; the MCP card says it is added by default and that the installer checks both servers.
  - `test/site/site.test.mjs`: the page's commands and options table match the README, its rule list (ids, links, severities) matches `data/gotchas.json`, the guard demo is the guard's real output and the fixed file is clean, every translatable key has Portuguese copy, and every id the page points at exists. `tools/check-links.mjs` now also checks `site/` (bare origins in preconnect hints and CSP sources are not fetched).

### Changed
- Landing page: rule severities read "likely bug" / "check" (pt-BR "provável bug" / "conferir") instead of red "error" / "warn" chips, and the guard notice uses the amber info style, so the page no longer looks like it is failing.

- Installer: `config.json` is now written on install to hold the language, not only after you turn the guard on. A file that is not valid JSON is left untouched, with a warning.
- Guard hook: every finding, error or warn, is now non-blocking advisory output. The hook always exits 0 and prints one JSON object: `hookSpecificOutput.additionalContext` carries the findings for the agent (`[error]`/`[warn]` labels, rule id, file:line, fix, docs URL; still at most 5 findings and 2,000 characters), and `systemMessage` carries a one-line notice for the user ("stable-build guard: 1 Arc gotcha in src/history.ts (transfer-filter-no-emitter) — advisory, edit kept"). Error findings no longer exit 2, so Claude Code no longer labels them "blocking error". Consent gate, fail-open behavior and the latency budget are unchanged, and so are the `--scan` exit codes for CI. The session-start notice describes the new output.
- Guard `transfer-filter-no-emitter`: addresses are judged by value, including loop variables over a const array (`for (const e of EMITTERS)`, `.map`, destructuring), so a loop over both emitters is now an error (`both-emitters`); both emitters in separate queries of one file are a new warning (`split-emitters`); an Edit of only the `address` line re-checks the enclosing filter. Each variant has its own fix: replace 0x3600… with the system emitter, never add it next to 0x3600….
- Guard `getlogs-unpaged`: flags only ranges the RPC rejects (more than 10,000 blocks; re-verified live on both public endpoints on 2026-10-04). Exactly 10,000 blocks (`from + 10_000n - 1n`) is no longer reported. The fix explains -32014; notes record the undocumented -32602 result cap.
- Guard hook context: each finding now carries the dated docs quote behind its rule (`Docs: <url> says "<quote>" (checked <date>)`), so the agent can act on the fix when it cannot fetch the page. Over the 2,000-character cap, quotes are dropped first (last finding first), then docs links. `transfer-filter-no-emitter`'s `usdc-only` variant has its own quote (the system emitter logs native sends and ERC-20 transfers at 18 decimals; verified 2026-10-05); `--explain` prints variant quotes.
- Hook launcher (`run.sh`): always exits 0 and discards node's stderr, so a missing or broken plugin module (a partial install) no longer surfaces as a hook error with a Node stack trace. Previously a module that failed to load made the guard exit 1 before its own handlers ran.
- `guard.mjs --scan <subdir>` text output prints paths that open from the current directory.
- Skills: `guide` opens with what the kit is and handles `--plugin-dir` loads; `find-idea` lints chat-only ideas from stdin (`lint-ideas.mjs -`); `new-app` and `go-live` run plain `node` calls; `go-live` reads the checklist first and reports RPC calls and docs queries separately; `architecture` asks before registry and GitHub API checks; the fee floor is marked as documented for testnet.

## [0.1.0] - unreleased

First release.

### Added

- Marketplace `stable-build` for Claude Code (`.claude-plugin/marketplace.json`) and Codex (`.agents/plugins/marketplace.json`). It offers two plugins:
  - `stable-build`: skills for apps built on Arc, the data files they read, and an edit-time Arc gotcha guard. The guard stays dormant until the user opts in.
  - `stable-build-mcp` (optional): the Arc docs MCP server, plus Circle's codegen MCP server for Claude Code, both over HTTP.
- `install.sh`. It works only through the native `claude plugin` and `codex plugin` commands, keeps a manifest of what it added, and supports `--dry-run`, `--update` and `--uninstall`.
- Builder-journey skills: `guide` (with a catalog generated from skill frontmatter), `find-idea`, `new-app`, `gotchas`, `go-live` and `studio-delegate`.
- Role skills and shared workflows adapted from BMad Method v6.12.1 (tech writer from v6.10.0): `analyst`, `pm`, `ux-designer`, `architect`, `dev`, `tech-writer`, `product-brief`, `architecture`, `stories` and `layered-review`.
- Edit-time guard with 10 rules, each with a docs.arc.io or developers.circle.com quote and `verified_at`. It is advisory, local, and dormant until the user opts in. `guard.mjs --scan` runs the same rules on demand.
- Payouts starter (`new-app`): CSV payroll as `Memo.memo(USDC.transfer)` rows batched through `Multicall3From.aggregate3` from an EOA, receipt reconciliation into an 18-decimal ledger, idempotent resume, CLI and GitHub Pages workflow. Testnet by default.
- Data snapshots for `find-idea` and `go-live`: frontiers, programs (with `valid_until`), sample apps, ecosystem names/URLs/categories and their sources, plus a weekly refresh workflow.
- README with install paths, the full list of files and settings touched, skills, guard rules, uninstall and open UNVERIFIED items.
- Governance:
  - MIT license and third-party notices (BMad Method MIT notice; links to circlefin/skills and the Arc Studio CLI).
  - Security policy and contributing guide.
  - CI: shell syntax and shellcheck, node tests, the name and brand check, `claude plugin validate --strict`, an install round trip on macOS and Ubuntu, the payouts starter (scaffold, test, build, guard scan), and a weekly docs-drift check. Actions are pinned to commit SHAs.

### Tested against

| Component | Version |
|---|---|
| Claude Code | 2.1.280 |
| Codex CLI | not run yet (UNVERIFIED; checked against openai/codex source at `4ad985e`) |
| circlefin/skills | commit `58ab8648bb1ae9d037a3bf5197ad3bb01262f5b1`, plugin version 1.6.0 |
| Arc Studio CLI | 1.1.3 |
| BMad Method (adapted) | v6.12.1 (`790dae9c`); tech writer from v6.10.0 (`081e64ee`) |
| Node.js | 22 (minimum 20) |

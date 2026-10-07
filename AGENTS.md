# AGENTS.md

Instructions for coding agents (Claude Code, Codex and others) working **on this repository**. Users of the kit do not need this file. Human contributors should read [CONTRIBUTING.md](CONTRIBUTING.md), which has the full rules.

## What this repo is

stable-build is a community kit for apps built on Arc. It is not affiliated with Circle. One repo serves as both a Claude Code marketplace and a Codex marketplace, each offering two plugins:

| Path | What it is |
|---|---|
| `.claude-plugin/marketplace.json` | Claude Code marketplace `stable-build` |
| `.agents/plugins/marketplace.json` | Codex marketplace `stable-build` (same plugins) |
| `plugins/stable-build/` | Skills, `data/`, `hooks/hooks.json`, `scripts/` (guard), with `.claude-plugin/` and `.codex-plugin/` manifests |
| `plugins/stable-build-mcp/` | `.mcp.json` (Claude: `arc-docs` + `circle-codegen`) and `codex.mcp.json` (Codex: `arc-docs` only) |
| `install.sh` | Thin wrapper around `claude plugin` / `codex plugin`; keeps `$STABLE_BUILD_HOME/manifest.json` and the language in `config.json` |
| `README.md`, `README.pt-BR.md` | User docs in English and Brazilian Portuguese, kept in step by `tools/check-docs-sync.mjs` |
| `tools/` | `check-names.mjs`, `check-links.mjs`, `build-catalog.mjs`, `build-data.mjs`, `check-docs-sync.mjs` |
| `test/` | `node --test` suites, install round trip (`test/install/roundtrip.sh`), installer i18n checks, guard fixtures |
| `third_party/`, `THIRD_PARTY_NOTICES.md` | Upstream licenses and attribution |

Product constants:

- `PRODUCT=stable-build`
- home directory `${STABLE_BUILD_HOME:-$HOME/.stable-build}`
- environment variable prefix `STABLE_BUILD_`
- GitHub repo `pedro-pelicioni/stable-build`

## Commands

```sh
npm test                               # all node tests
npm run check                          # names/brand + catalog freshness + offline link/evidence check + docs sync
node tools/build-catalog.mjs           # regenerate skills/guide/references/catalog.md after skill changes
node tools/check-links.mjs             # network link check + docs-drift check of gotchas evidence quotes
bash -n install.sh && /bin/bash -n install.sh   # syntax, including macOS bash 3.2
HOME="$(mktemp -d)" bash test/install/roundtrip.sh   # installer round trip with stub CLIs (CI also runs it under /bin/bash)
```

Validate plugins only with a throwaway HOME:

```sh
T="$(mktemp -d)"; HOME="$T" CLAUDE_CONFIG_DIR="$T/.claude" claude plugin validate --strict .
```

Run it on `.`, `plugins/stable-build` and `plugins/stable-build-mcp`.

## Hard rules

1. **Never touch the real `~/.claude`, `~/.codex` or `~/.stable-build`.**
   - Any command that runs `claude`, `codex` or `install.sh` needs `HOME=$(mktemp -d)`, `CLAUDE_CONFIG_DIR=$HOME/.claude`, `CODEX_HOME=$HOME/.codex` and `STABLE_BUILD_HOME=$HOME/.stable-build`.
   - Never run `arc-studio login` or `arc-studio skills install`, or anything that reads credentials.
2. **No keys and no transactions.** Never sign or send transactions on any network. Read-only RPC calls are fine.
3. **Brand rule.**
   - Names of marketplaces, plugins, skills, agents and packages never contain "bmad" or "circle", and never use "arc" as a name token (`arc`, `arc-tools`, `arckit`, `stable-arc`, `arc2`). `tools/check-names.mjs` enforces this per token, so the English words `architect` and `architecture` (the design's persona and workflow skill names) are allowed: they do not refer to Arc. Do not add other names that start with "arc".
   - Use Arc only descriptively, as in "for apps built on Arc" or "community project, not affiliated with Circle".
4. **Sources.**
   - Every Arc or Circle fact in skills or data links to docs.arc.io or developers.circle.com.
   - Data items carry `verified_at`.
   - Mark anything you could not confirm as UNVERIFIED.
5. **Licensing.**
   - Do not copy code or text from repositories without an open-source license.
   - Do not vendor Circle's skills or the Arc Studio CLI.
   - BMad-derived files keep their attribution header and a row in `skills/UPSTREAM.md`. See `THIRD_PARTY_NOTICES.md`.
6. **Wording.** Write for builders, concisely. No hype, and no yield, returns, APR or ROI language. The same holds in Portuguese: no "rendimento", "rentabilidade", "lucro", "retorno garantido", "renda passiva", "garantido" or "sem risco", and no "app oficial" or "parceria com a Circle".

## Plugin format details that are easy to get wrong

- **Claude Code** auto-discovers `skills/`, `hooks/hooks.json` and `.mcp.json`.
  - Do not add `"hooks"` or `"mcpServers"` keys that point at those default files in `.claude-plugin/plugin.json`, or they load twice.
  - Do not add `dependencies`: an unmet cross-marketplace dependency leaves the plugin unloaded.
- **Codex** handles manifest paths differently. In `.codex-plugin/plugin.json`, `hooks` and `mcpServers` paths *replace* the defaults.
  - `plugins/stable-build` declares `"skills": "./skills/"` and `"hooks": "./hooks/hooks.json"`.
  - `plugins/stable-build-mcp` declares `"mcpServers": "./codex.mcp.json"`.
  - `interface.defaultPrompt` takes at most 3 entries of at most 128 characters each.
- **MCP entries** with a `url` need `"type": "http"`, or Claude Code drops them.
- **Hooks** are shared by both hosts:
  - Use shell form only, with no `args` or `if`, and quote `"${CLAUDE_PLUGIN_ROOT}"`.
  - The guard runs on PostToolUse and always exits 0. Findings (error and warn alike) go out as one JSON object on stdout: `hookSpecificOutput.additionalContext` for the agent and a one-line `systemMessage` for the user.
  - Never exit 2 from any hook, the guard included: Claude Code shows exit 2 as a "blocking error".
  - `scripts/run.sh` runs node without `exec`, discards its stderr and ends with `exit 0`. A module that fails to load stops node before the guard's own handlers run, so only the launcher can keep that silent.
  - Without consent in `$STABLE_BUILD_HOME/config.json` the hooks stay dormant.
- **Skills:**
  - Frontmatter has only `name` (equal to the folder, kebab-case, at most 64 characters) and `description` (at most 1,024 characters).
  - Paths are relative to the skill folder.
  - `${CLAUDE_PLUGIN_ROOT}` does not expand in Codex.
  - Never put a `SKILL.md` below a skill's top folder, because Codex would load it as a separate skill.
  - Avoid built-in names: `help`, `new`, `clear`, `review`, `code-review` and others.
- **Versions:** bump `version` in all four plugin manifests and `package.json` together. Claude Code keeps users on a version until it changes.

## Languages (en, pt-BR)

The kit speaks English and Brazilian Portuguese. The choice is `"language": "en" | "pt-BR"` in `$STABLE_BUILD_HOME/config.json`, written by `install.sh` (`--lang` > `STABLE_BUILD_LANG` > the saved value > the prompt, where Enter keeps English > English). English is the default everywhere, on the landing page too: never pick Portuguese from the locale or the browser language. The manifest records `language`, and `files["config.json"].createdByUs` or `languageAddedByUs`, so `--uninstall` removes only what the installer wrote. A `config.json` that holds only the language is not consent: `run.sh` starts the hooks only on `"guard": true`. Accepted spellings live in `norm_lang` (`install.sh`) and `ALIASES` (`plugins/stable-build/scripts/guard/prefs.mjs`); change both together.

### Installer messages

Every user-facing string is a message id in the two tables inside `main()`: `_msg_en` and `_msg_pt`.

1. Add `my_id) _T="…" ;;` to `_msg_en`, and the same id at the same position in `_msg_pt`.
2. Use the same number and order of `%s` in both, and no other printf conversion. Write `\n` for a line break and escape `\"` and `\$`.
3. Print it with `say_t my_id args` (stdout), `err_t`, `warn_t` or `die_t` (stderr), `section`, `ask`, or `"$(msg my_id args)"` inside `line`. Never print prose through `printf`, `echo`, `say` or `line` directly.
4. Keep commands, flags, paths, environment variables and product names in English inside both templates. Text shown before the language is known (`lang_banner`, `lang_menu`, `err_lang_*`) is bilingual and identical in both tables.
5. If an entry is identical in both tables on purpose, add it with a reason to `SAME_OK` in `test/install/i18n.test.mjs`.
6. Keep bash 3.2 syntax: no `${v,,}`, `declare -A` or `mapfile`.

`test/install/i18n.test.mjs` (in `npm test`) fails on a missing id, an unused entry, a `%s` mismatch, a wrong argument count, an untranslated or English-looking pt-BR entry, and literal prose. New behavior also needs a check in `test/install/roundtrip.sh` and a line in both READMEs.

### Hooks, skills and docs

- **Hooks** (under `plugins/stable-build/`): only the texts the user sees are translated: the guard's `systemMessage` (`NOTICE_TEXT` in `scripts/guard.mjs`) and the SessionStart notice (`NOTICES` in `scripts/session-start.mjs`). They read the language with `readLanguage()` from `scripts/guard/prefs.mjs`. `additionalContext`, rule ids and docs quotes stay in English. Tests: `test/guard/language.test.mjs`.
- **Skills:** every `SKILL.md` ends with a `## Language` section whose text is `LANGUAGE_RULE` in `test/skills/language.test.mjs`, word for word, once. Copy it into a new skill. To change it, edit the test and every `SKILL.md` in the same change. When a script checks a skill's output, ship a pt-BR template the script accepts: `find-idea` has one, and `lint-ideas.mjs` accepts its Portuguese labels and checks the wording rules in both languages.
- **Docs:** `README.md` and `README.pt-BR.md`, and the payouts template's README pair, must match: same heading outline, identical code blocks, cross-links at the top and valid in-page anchors. `node tools/check-docs-sync.mjs` checks this (`--strict` also compares inline code spans). Edit both files in the same change.

## When you finish a change

- Run `npm test` and `npm run check`. If you touched manifests, also run `claude plugin validate --strict` with a temporary HOME. If you touched `install.sh`, also run `bash -n` and `/bin/bash -n` on it and the round trip with a temporary HOME.
- Regenerate the catalog if any skill frontmatter changed.
- Add a line to `CHANGELOG.md` under `[Unreleased]`.
- Do not commit, push or publish unless a human asked for it.

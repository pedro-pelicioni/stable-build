# stable-build

[Leia em português](README.pt-BR.md) · Website: https://stable-build.vercel.app

Skills, a payouts starter, an opt-in edit-time guard and a go-live checklist for apps built on Arc, for **Claude Code** and **Codex**. It covers the builder journey from "what should I build?" to a mainnet readiness report:

```
find-idea -> new-app -> product-brief / pm / ux-designer / architect / stories -> dev -> gotchas / layered-review -> go-live
```

- **Community project, not affiliated with Circle.** No Circle or Arc endorsement is implied. Arc facts link to docs.arc.io or developers.circle.com, and anything we could not confirm is marked UNVERIFIED.
- **Circle's own skills are not bundled.** The installer fetches Circle's `circle-skills` plugin from [circlefin/skills](https://github.com/circlefin/skills), and stable-build skills hand product questions to it.
- **Version 0.1.0, not released yet.** Tested with Claude Code 2.1.280. The Codex path is built from Codex's docs and source and has **not been run** (see [Status](#status-and-unverified-items)).

## Install

Requirements: Node.js 20 or newer, plus Claude Code 2.1.280 or newer and/or a Codex CLI that has `codex plugin`. The installer needs bash 3.2 or newer (the macOS default works).

### 1. Installer (Claude Code and Codex)

```sh
curl -fsSL https://raw.githubusercontent.com/pedro-pelicioni/stable-build/main/install.sh | bash
```

To read it first, download it, then preview the plan:

```sh
curl -fsSLO https://raw.githubusercontent.com/pedro-pelicioni/stable-build/main/install.sh
bash install.sh --dry-run
bash install.sh
```

Run it in a normal terminal, not inside an agent session. It asks at most two questions: the language (the first time only), then one confirmation that lists only what is missing on your machine:

- **stable-build**: the six role skills, the workflow skills and the Arc gotcha guard, which is advisory (see [The guard](#the-guard)).
- **MCP servers**: the Arc docs and Circle codegen servers (`stable-build-mcp`).
- **Circle's skills**: installing Circle's plugin accepts the Circle Developer Terms, so the list links them (https://console.circle.com/legal/developer-terms).
- **Arc Studio**: the CLI (`npm install -g @circle-fin/arc-studio-cli@latest`), its Claude Code plugin (`arc-studio skills install --tool claude-code`), then the sign-in: `arc-studio login` opens your browser and you click Authorize. Ctrl+C skips only the sign-in.
- **Arc Foundry** (`arc-forge`, `arc-cast`, `arc-anvil`): the release for your platform from [circlefin/arc-foundry](https://github.com/circlefin/arc-foundry), checked against its `.sha256`, tried with `arc-forge --version` before it replaces anything, and installed in `~/.local/bin`, as in https://docs.arc.io/arc/tutorials/install-arc-foundry. If that folder is not on your `PATH`, two marked lines go into `~/.zshrc` (zsh), `~/.bash_profile` (bash on macOS; `~/.bash_login` or `~/.profile` instead when that is the file bash reads there) or `~/.bashrc` (bash on Linux); open a new terminal afterwards. Intel Macs, Windows and musl Linux have no prebuilt archive: build from source.

One yes covers the whole list; a no changes nothing. With `--update`, the update itself needs no yes: the question lists only what is not set up yet (on a first `--update` after v0.1.0, the Arc Studio CLI and Arc Foundry), and a no skips just those, then the update goes on. Only Enter takes the default: any other answer that is not a yes or a no is asked again, and after three tries it counts as no. When the Arc Studio sign-in is all that is missing (for example after an install with `--yes`), the one question is whether to sign in now, and a no skips just the sign-in: the rest of the run, such as `--update`, goes on (`--no-login` stops the question). Then it prints one line per component (`✓` done, `–` skipped, `✗` failed, with the fix) and a short closing. The raw output of every command goes to `~/.stable-build/install.log`. A failed npm install, Foundry download or sign-in is reported on its line and the rest goes on. Rerunning is safe: what is already in place is neither asked about nor changed.

| Option | Effect |
|---|---|
| `--dry-run` | Print the full plan and change nothing (nothing is downloaded) |
| `--yes` | Install everything without asking, which accepts Circle's terms and turns the guard on; the sign-in is skipped. A guard you turned off earlier stays off |
| `--no-hooks` | Leave the guard off, now and on later runs |
| `--no-mcp` | Skip the `stable-build-mcp` plugin |
| `--no-circle` | Skip Circle's skills plugin |
| `--no-studio` | Skip the Arc Studio CLI, its plugin and the sign-in |
| `--no-login` | Skip only the Arc Studio sign-in; run `arc-studio login` later |
| `--no-foundry` | Skip Arc Foundry |
| `--verbose` | Print every command and its raw output |
| `--update` | Update stable-build, plus Circle's plugin, the Arc Studio CLI and plugin, and Arc Foundry if this installer added them. Never turns the guard on |
| `--uninstall` | Remove only what this installer added |
| `--ref=TAG` | Install a tag or branch (default `main`, which moves only at releases) |
| `--prefix=DIR` | Sandbox: every CLI call runs with `HOME=DIR`, npm installs into `DIR/.npm-global` and Arc Foundry into `DIR/.local/bin`, so nothing outside `DIR` is written |
| `--lang=LANG` | Language of the installer and of the kit's replies, `en` or `pt-BR`; saved for later runs (see [Language](#language)) |

With no terminal attached (or inside a Claude Code or Codex session) and no `--yes`, nobody can answer, so the installer adds only stable-build and `stable-build-mcp`. Nothing third-party is installed (Circle's plugin, Arc Studio, Arc Foundry, the rc-file lines) and the guard stays off; one line names what was left out and how to add it. With `--yes`, everything installs except the sign-in, which needs you at the browser: run `arc-studio login` later. A guard turned off with `--no-hooks` (or declined with an earlier version of the installer) stays off on later runs, even with `--yes`; turn it on with `/stable-build:gotchas enable`.

#### Language

The installer, the guard's one-line warning, the session-start notice and what the skills write for you (chat replies, `docs/go-live-report.md`, PRDs, stories, idea lists) come in English or Brazilian Portuguese (`pt-BR`). English is the default everywhere: the installer's first question is "Language / Idioma", Enter keeps English, and your system locale (`LANG`, `LC_ALL`) is never used to switch. To pick Portuguese up front:

```sh
bash install.sh --lang=pt-BR
curl -fsSL https://raw.githubusercontent.com/pedro-pelicioni/stable-build/main/install.sh | STABLE_BUILD_LANG=pt-BR bash
```

- `--lang` (or `--lang pt-BR`, with a space) wins over `STABLE_BUILD_LANG`, which wins over the language saved by an earlier run. Accepted values, in any case: `en`, `english`, `pt`, `pt-BR`, `pt_BR`, `portugues`, `português`. Any other value stops the installer with an error.
- With `--yes`, with no terminal (an agent session counts as none) or with `STABLE_BUILD_NO_TTY=1`, and no language given or saved, the installer uses English without asking.
- The choice is saved as `"language"` in `~/.stable-build/config.json` (any other keys in that file are kept) and recorded in `manifest.json`. Reruns, `--update`, `--uninstall`, `--help` and error messages reuse it; change it on any run with `--lang`. `--dry-run` saves nothing. Saving the language does not turn the guard on: the guard runs only when that file contains `"guard": true`.
- Code, file names, rule ids, CLI flags and commit messages stay in English. Skills reply in the saved language. In plain chat outside a skill, the agent learns it only from the session-start notice, which runs in an Arc project with the guard on (`"guard": true`); there, with `pt-BR` saved, it replies in Portuguese even when you write in English. Elsewhere, and with no saved language (for example after a `/plugin` or `codex plugin` install), replies follow the language you write in.

### 2. Claude Code, with `/plugin`

```text
/plugin marketplace add circlefin/skills
/plugin install circle-skills@circle
/plugin marketplace add pedro-pelicioni/stable-build
/plugin install stable-build@stable-build
/plugin install stable-build-mcp@stable-build
/reload-plugins
```

`stable-build-mcp` is optional. To turn the guard on, run `/stable-build:gotchas enable`; the skill explains the guard and asks before it writes anything. Start with `/stable-build:guide`.

### 3. Codex, with `codex plugin` (UNVERIFIED: not run yet)

```sh
codex plugin marketplace add circlefin/skills --ref master
codex plugin add circle@circle-skills
codex plugin marketplace add pedro-pelicioni/stable-build --ref main
codex plugin add stable-build@stable-build
codex plugin add stable-build-mcp@stable-build
```

`stable-build-mcp` is optional; in Codex it adds only the Arc docs server, because Circle's Codex plugin brings its own. If you turn the guard on, also open `/hooks` in Codex and trust the stable-build hooks: Codex skips plugin hooks until you do.

## What gets touched

This is the complete list. The installer itself writes under `~/.stable-build` and, with your yes, three files in `~/.local/bin` and two lines in one shell rc file. Everything in Claude Code's and Codex's folders is written by their own `claude plugin` and `codex plugin` commands; the installer never edits `settings.json`, `.claude.json`, `config.toml` or `hooks.json` by hand. `--uninstall` reverses only the entries it recorded as `addedByUs`.

| Where | Written by | What | When |
|---|---|---|---|
| `~/.stable-build/manifest.json` | installer | What it added, with `addedByUs` per entry, versions, the circlefin/skills commit, the language, whether it created `config.json`, and when you declined the guard | Always (not with `/plugin` or `codex plugin` installs) |
| `~/.stable-build/install.log` | installer | The raw output of the commands the last run made (overwritten each run) | Every install or `--update` run, except `--dry-run` and a "no" at the confirmation; `--uninstall` deletes it |
| `~/.stable-build/config.json` | installer or the `gotchas` skill | `{"schemaVersion":1,"language":"en"}`, plus `"guard":true` and `"consentAt"` once the guard is on. In an existing file only these keys change | Install (the language); the guard keys only after you agree to turn the guard on |
| `~/.claude/settings.json` | `claude plugin` | `extraKnownMarketplaces`: `stable-build`, and `circle` if added. `enabledPlugins`: `stable-build@stable-build`, `stable-build-mcp@stable-build`, and `circle-skills@circle` / `arc-studio@arc-studio-cli` if added | Install |
| `~/.claude/plugins/` | `claude plugin` | `known_marketplaces.json`, `installed_plugins.json`, a clone of each marketplace under `marketplaces/`, plugin copies under `cache/<marketplace>/<plugin>/<version>/` | Install |
| `~/.claude.json` | Claude Code | Its own bookkeeping, updated on every CLI run | Any `claude` call |
| `~/.codex/config.toml` | `codex plugin` | `[marketplaces.stable-build]`, `[marketplaces.circle-skills]` if added, and plugin entries (UNVERIFIED: from Codex docs and source) | Install |
| `~/.codex/plugins/` | `codex plugin` | Plugin copies under `cache/<marketplace>/<plugin>/<version>/` and marketplace snapshots (UNVERIFIED) | Install |
| Codex hook trust | Codex | Recorded when you trust the hooks in `/hooks` | Only if you do |
| Arc Studio CLI | `npm install -g` | The `@circle-fin/arc-studio-cli` package in npm's global prefix, which puts `arc-studio` on your `PATH` | Only if `arc-studio` is missing and you agree |
| Arc Studio plugin | `arc-studio skills install --tool claude-code` | Marketplace `arc-studio-cli` (a folder inside the Arc Studio npm package) and plugin `arc-studio@arc-studio-cli` in Claude Code | Only if the plugin is absent and you agree |
| Arc Studio sign-in | `arc-studio login` | Its token, in the macOS Keychain or in `~/.arc-studio/credentials.json` (0600) elsewhere. The installer never reads it | Only if you are not signed in, you are at a terminal, and you agree |
| `~/.local/bin/arc-forge`, `arc-cast`, `arc-anvil` | installer | Arc Foundry from its GitHub release for your platform, checksum verified, mode 0755. The manifest records each file's sha256, so a file you put there later is never overwritten or removed | Only if `arc-forge` is missing and you agree |
| `~/.zshrc`, `~/.bash_profile` (or `~/.bash_login` / `~/.profile`) or `~/.bashrc` | installer | Two lines at the end: `# added by stable-build (Arc Foundry)` and `export PATH="$HOME/.local/bin:$PATH"` | Only if `~/.local/bin` is not on your `PATH` and you agree |

Never touched: the other lines of your shell profiles, npm packages other than `@circle-fin/arc-studio-cli`, an `arc-forge` the installer did not install, permission allow-rules, other plugins or skills you already have, the Arc Studio token after sign-in, and your projects. Skills write into a project only when you ask: `new-app` scaffolds into an empty folder you name, the planning skills write `docs/plan/` and `docs/stories/`, and `go-live` writes `docs/go-live-report.md`.

Network use at install: the plugin CLIs clone `pedro-pelicioni/stable-build` and `circlefin/skills` from GitHub, and the installer may run `git ls-remote` on circlefin/skills to record its commit. npm downloads the Arc Studio CLI from its registry. `arc-studio whoami` checks your sign-in with Arc Studio, only when you are at a terminal. Arc Foundry's latest tag comes from `api.github.com` and its archive and `.sha256` from `github.com`. To avoid duplicate MCP tools it runs `claude mcp get arc-docs` and `claude mcp get circle` (and `codex mcp get arc-docs`); if you already have a server with one of those names, that command connects to it. After installing `stable-build-mcp` it checks only its two servers with `claude mcp get plugin:stable-build-mcp:arc-docs` and `…:circle-codegen`, which connect to `https://docs.arc.io/mcp` and `https://api.circle.com/v1/codegen/mcp`. It never runs `claude mcp list`, which would start every MCP server you have configured. Anything that already exists before the installer runs (for example Circle's marketplace or a user-scope `arc-docs` MCP server) is recorded as not ours and is kept on uninstall.

## Skills

In Claude Code, run a skill as `/stable-build:<name>`, or describe the task and the agent picks it. In Codex, ask for it by name (how Codex displays plugin skills is UNVERIFIED). The list below matches [`skills/guide/references/catalog.md`](plugins/stable-build/skills/guide/references/catalog.md), which is generated from the skills' frontmatter.

| Skill | What it does |
|---|---|
| `guide` | Start here. Read-only environment check (Circle plugin, Arc Studio, guard, Arc Foundry), asks your stage, names the next skill. Routes product questions to Circle's skills and states where Circle's `use-arc` differs from docs.arc.io. |
| `find-idea` | Short interview, then 5 ranked ideas grounded in Arc's Request for Builders, live building blocks, sample apps and current programs, each with sources, deadlines and a first-2-hours plan. |
| `new-app` | Scaffolds a starter into an empty folder. Starter #1, `payouts`: CSV payroll as `Memo.memo(USDC.transfer)` rows batched through `Multicall3From` from an EOA, reconciled from receipts into an 18-decimal ledger, idempotent resume, static GitHub Pages deploy. Testnet by default. |
| `gotchas` | Explains a guard finding, scans a repo, turns the edit-time guard on or off after you confirm. |
| `go-live` | Testnet-to-mainnet checklist (14 gates) with evidence, written to `docs/go-live-report.md`. Never deploys and never touches keys. |
| `studio-delegate` | Hands contract writing, auditing or testnet deploys to Circle's Arc Studio CLI and treats its output as untrusted until checked onchain. You log in to Arc Studio yourself. |
| `analyst` | **Sam.** Brainstorming and quick market or technical research; idea hunting goes through `find-idea`. |
| `pm` | **Bobbilee.** PRD in `docs/plan/prd.md` with an Onchain section (network, assets, EOA or smart account, blocklist, fees in USDC). |
| `ux-designer` | **Joshua.** UX specs with Arc states: one USDC balance, fees in USDC, one-confirmation finality, dropped and reverted transactions, testnet banner. |
| `architect` | **Tim.** Architecture spine that starts from Arc's protocol invariants, plus a readiness check. |
| `dev` | **Pedro.** Implements one story at a time, test first, contract tests on Arc Foundry. A story is done only with passing tests and a recorded testnet transaction hash. |
| `tech-writer` | **Mike.** Docs, explainers and Mermaid diagrams with a docs.arc.io source for every Arc fact. |
| `product-brief` | One-to-two page brief in `docs/plan/brief.md`. |
| `architecture` | Creates, updates or validates `docs/plan/architecture.md`. |
| `stories` | Epics and dev-ready story files with Arc acceptance criteria. |
| `layered-review` | Code review in independent layers, including an Arc gotcha hunter that runs the guard scan. |

The six role skills have first names, so you can just say "talk to Tim" or "Sam, what should I build on Arc?": Tim (`architect`, leads the plan), Bobbilee (`pm`), Sam (`analyst`), Joshua (`ux-designer`), Pedro (`dev`) and Mike (`tech-writer`). The names are a tribute to people from the Arc community, with the kit's author as the developer. They did not build or endorse this kit, and the agents never claim to be them or speak for them or for Circle.

The role skills and shared workflows (`analyst` through `layered-review`) are adapted from [BMad Method](https://github.com/bmad-code-org/BMAD-METHOD) v6.12.1 (MIT); see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [`skills/UPSTREAM.md`](plugins/stable-build/skills/UPSTREAM.md). The optional `stable-build-mcp` plugin adds the Arc docs MCP server (`https://docs.arc.io/mcp`) and, in Claude Code, Circle's codegen docs server (`https://api.circle.com/v1/codegen/mcp`); see [its README](plugins/stable-build-mcp/README.md).

## The guard

An advisory check that runs after each Write/Edit (Claude Code) or apply_patch (Codex) inside an Arc project and looks only at the lines just added.

- **Off until you opt in.** The hook launcher exits without starting Node unless `~/.stable-build/config.json` contains `"guard": true`. Codex also requires you to trust the hooks in `/hooks`.
- **Advisory.** The edit is already applied; the guard never blocks, undoes or rewrites it, and it always exits 0, so it never shows up as a hook error. Every finding, error or warn, comes back the same way, at most 5 per edit:
  - you see a one-line warning in the saved language (the hook's `systemMessage`), for example "stable-build guard: 1 pegadinha da Arc em src/history.ts (transfer-filter-no-emitter) — aviso, edição mantida" in Portuguese, or `stable-build guard: 1 Arc gotcha in src/history.ts (transfer-filter-no-emitter) — advisory, edit kept` in English;
  - the agent gets the details as added context (`hookSpecificOutput.additionalContext`, at most 2,000 characters): `[error]` or `[warn]`, rule id, file:line, the fix, the docs link and the dated docs quote behind the rule, so the agent can apply the fix without fetching the page.
- **Local.** No network calls, no file writes, no telemetry. If Node is missing, a plugin file is missing or broken, or anything else fails, it exits 0 quietly.
- **Arc projects only.** A project counts when it has `.stable-build/project.json`, or a marker such as chain id 5042 or 5042002, `arc`/`arcTestnet` from `viem/chains`, an `rpc.*.arc.io` URL or the USDC address `0x3600…0000`.
- **Scan on demand** without the hook: `node <plugin>/scripts/guard.mjs --scan .` (exit 0 clean, 1 errors). `--explain <id>` prints a rule with its docs quote.
- **Silence** one line with a `stable-build-ignore <id>` comment on that line or the line above; disable a rule for a project in `.stable-build/guard.json` (`{"disable": ["<id>"], "ignorePaths": ["glob"]}`).

| Rule | Severity | Flags | Source |
|---|---|---|---|
| `usdc-native-value-6dp` | error | Native transaction value or `msg.value` built with 6 decimals; native USDC uses 18 | https://docs.arc.io/integrate/wallets |
| `usdc-erc20-amount-18dp` | error | USDC `transfer` / `approve` / `transferFrom` with 18-decimal amounts; the ERC-20 interface uses 6 | https://docs.arc.io/arc/references/contract-addresses |
| `usdc-balance-summed` | error | `getBalance` added to `balanceOf`, or two USDC balance rows: one balance, two views | https://docs.arc.io/integrate/wallets |
| `fee-below-floor` | error | `maxFeePerGas` or `gasPrice` under 20 gwei; such transactions never get a receipt (dropped, or rejected as `transaction underpriced`) | https://docs.arc.io/arc/references/evm-differences |
| `getlogs-unpaged` | error | Log queries from a fixed block to latest without paging, or ranges over 10,000 blocks (the RPC's limit; the fix pages by 9,999 as the docs advise) | https://docs.arc.io/arc/references/rpc-endpoints |
| `transfer-filter-no-emitter` | error / warn | `Transfer` filters with no address or on both USDC emitters, also through a loop over both (double counting); on `0x3600…` only (misses native sends); or both emitters in separate queries of one file | https://docs.arc.io/arc/references/usdc-system-events |
| `cctp-stellar-no-forwarder` | error | CCTP burn to Stellar (domain 27) whose mintRecipient or destinationCaller is not CctpForwarder (ethers, viem `write([…])` and object forms), or is zero | https://developers.circle.com/cctp/references/stellar |
| `upstream-foundry` | warn (error in CI) | `foundryup`, `foundry-toolchain`, bare `forge` / `anvil` / `cast send`; also `arc-forge test` / `arc-anvil` without Arc mode (`--network arc`, or `FOUNDRY_PROFILE=arc` with `[profile.arc] network = "arc"`), which run Ethereum rules | https://docs.arc.io/arc/references/evm-differences |
| `extension-from-smart-account` | error | Memo or Multicall3From used from a smart account, Safe, bundler or another contract; they accept only a direct EOA caller | https://docs.arc.io/arc/concepts/transaction-memos |
| `multicall3from-value` | error | `aggregate3Value`, or value on `aggregate3` through Multicall3From, which forwards no value | https://docs.arc.io/arc/concepts/batched-transactions |

Each rule's docs quote and `verified_at` date are in [`data/gotchas.json`](plugins/stable-build/data/gotchas.json). CI checks every quote against the live docs page weekly and opens an issue when one drifts.

## Uninstall

If you used the installer:

```sh
curl -fsSL https://raw.githubusercontent.com/pedro-pelicioni/stable-build/main/install.sh | bash -s -- --uninstall
```

It removes, in reverse order, only what its manifest says it added: the plugins, then the Arc Studio CLI (`npm uninstall -g`, in the npm prefix it went into, even after a node switch), Arc Foundry's three binaries (only while each is still the file it wrote, by its recorded sha256) and its two PATH lines (the rest of your rc file stays byte for byte). It asks before removing Circle's plugin, deletes `manifest.json`, `config.json` and `install.log` from `~/.stable-build` (from a `config.json` that also holds keys of your own, only the language and guard keys come out) and the folder only if nothing else is in it, then re-lists both hosts and exits 1 if any stable-build entry is left. It never runs `arc-studio logout`. The npm package goes only after its Claude Code plugin, so while that plugin is registered and no `claude` CLI is available, the package is kept and the run ends incomplete, keeping the manifest for a later run. With neither Claude Code nor Codex available, it still removes Arc Foundry and the PATH lines, then reports the plugin entries it could not remove. Claude Code 2.1.280 can leave empty `enabledPlugins` and `extraKnownMarketplaces` objects in `settings.json`; they are harmless.

By hand:

```text
# Claude Code
/plugin uninstall stable-build-mcp@stable-build
/plugin uninstall stable-build@stable-build
/plugin marketplace remove stable-build

# Codex (UNVERIFIED)
codex plugin remove stable-build-mcp@stable-build
codex plugin remove stable-build@stable-build
codex plugin marketplace remove stable-build

# Both
rm -f ~/.stable-build/manifest.json ~/.stable-build/config.json ~/.stable-build/install.log
rmdir ~/.stable-build

# Arc Studio CLI and Arc Foundry, if the installer added them
npm uninstall -g @circle-fin/arc-studio-cli
rm -f ~/.local/bin/arc-forge ~/.local/bin/arc-cast ~/.local/bin/arc-anvil
```

Then delete the two lines stable-build added to your shell rc file: `# added by stable-build (Arc Foundry)` and the `export PATH="$HOME/.local/bin:$PATH"` line after it.

Remove Circle's plugin (`circle-skills@circle`, Codex `circle@circle-skills`) only if you do not use it elsewhere.

## Privacy

- No telemetry, analytics or install counters, in the installer, the hooks or the skills.
- The guard runs locally and sends nothing.
- Prompts that trigger the optional MCP servers send the query to docs.arc.io or to Circle. Do not put secrets in them.
- Apart from those MCP queries, skills ask before making network calls: `find-idea` may run `gh search repos` for public repo metadata, `go-live --online` makes read-only RPC calls (`eth_chainId`, `eth_getCode`) and `gh repo view`, and `studio-delegate` sends the task you approve to Arc Studio through your own logged-in CLI.
- No skill asks for, reads or stores private keys, seed phrases or `.env` contents, and none signs or sends a transaction. The payouts starter reads its signing key from your shell only when you run its CLI yourself.

## Status and UNVERIFIED items

What has been run (2026-10-04):

- `claude plugin validate --strict` passes on the marketplace and both plugins (Claude Code 2.1.280). With `--plugin-dir`, all 16 skills and both hooks load, and both MCP servers report Connected.
- Node tests pass: the guard (every rule against good and bad fixtures, four payload shapes, exit codes, p95 latency under 150 ms), skill frontmatter and links, the Arc Studio result parser, and the scaffolder.
- The installer round trip passes with stub CLIs (install, rerun with no changes, update, ref switch, uninstall with no residue, truncated download does nothing) and with real Claude Code 2.1.280 in a throwaway HOME.
- The payouts starter scaffolds, passes its 89 tests offline against recorded Arc Testnet receipts, builds, and scans clean.
- The batched composition (`Multicall3From.aggregate3` over `Memo.memo(USDC.transfer)` from an EOA) is not documented on docs.arc.io. It was confirmed read-only from 72 existing Arc Testnet transactions; see [`batch-memo-evidence.md`](plugins/stable-build/skills/new-app/templates/payouts/docs/batch-memo-evidence.md).

Not run yet, or UNVERIFIED:

- **Codex: nothing has been run.** Codex is not installed on the build machine. The Codex manifests, `codex plugin` commands, `config.toml` handling, hook payloads, `/hooks` trust, and how skills are listed come from Codex's docs and source (openai/codex at `4ad985e`) only.
- **shellcheck and actionlint** run in CI only; CI has not run yet because nothing has been pushed.
- **Claude Code minimum version**: only 2.1.280 was tested; older versions are refused.
- **Payouts starter**: the starter's own testnet end-to-end run needs a funded testnet key and has not been run. Not verified: a real mainnet batch, the production chunk size (starts at 50 rows), public RPC rate limits, and EIP-7702 delegated senders (refused by the starter).
- **Arc Studio**: no live run (it needs a login); the parser fixtures are synthetic, built from the 1.1.3 source.
- **Installer, Arc Studio CLI and Arc Foundry steps**: run only against stubs (npm, curl, `arc-studio`), never against the npm registry, GitHub releases or a real `arc-studio login`. Where `forge`, `cast` and `anvil` sit inside a real Arc Foundry archive (top level or one folder down; both are accepted) and what `arc-forge --version` prints are taken from the install guide: UNVERIFIED.
- **go-live**: the mainnet contract-verification URL, and `--account` / `--ledger` / `arc-cast code` in Arc Foundry, are not documented on docs.arc.io.
- **Program data**: deadlines in `data/programs.json` have a `valid_until`; the data check fails after one passes until the entry is updated. Several program details are marked UNVERIFIED in the file.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md). Run `npm test` and `npm run check` before a pull request. Security reports: [SECURITY.md](SECURITY.md).

## License

MIT for stable-build's own code and text ([LICENSE](LICENSE)). Adapted BMad Method material keeps its MIT notice; Circle's skills and the Arc Studio CLI are fetched from upstream, not redistributed. Details in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

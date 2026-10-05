# Security policy

stable-build is a community project that is not affiliated with Circle. It installs agent skills, an optional edit-time hook and optional MCP server configuration for apps built on Arc. This page explains how to report a problem and what each part is allowed to do.

## Reporting a vulnerability

- Report privately through GitHub: https://github.com/pedro-pelicioni/stable-build/security/advisories/new. Do not open a public issue for a security problem.
- Include the affected version or commit, the host (Claude Code or Codex, and its version), steps to reproduce, and the impact.
- This is a volunteer project. We aim to acknowledge reports within 7 days and, for confirmed issues, to ship a fix or mitigation (or explain why none is needed) within 30 days. Reporters are credited unless they prefer otherwise.
- Supported versions: the latest release and `main`.

**Out of scope here.** Report these to their owners:

- Vulnerabilities in Arc itself, in Circle products or APIs, in Circle's skills (circlefin/skills), in the Arc Studio CLI, or in the hosted MCP servers (docs.arc.io/mcp, api.circle.com/v1/codegen/mcp). Report them to Circle through its own disclosure channels.
- Vulnerabilities in Claude Code or Codex. Report them to Anthropic or OpenAI.

## What each component may do

### `install.sh`

- Calls only the native plugin CLIs: `claude plugin …` and `codex plugin …`. It never edits `settings.json`, `.claude.json`, `config.toml` or `hooks.json` by hand.
- Writes only under `${STABLE_BUILD_HOME:-$HOME/.stable-build}`: `manifest.json`, and `config.json` with the language you chose plus, only with your consent, the guard keys. Both are written atomically, and other keys already in `config.json` are kept.
- Records which marketplaces and plugins it added (`addedByUs`). `--uninstall` removes only those and leaves alone anything that was there before.
- Wraps all its code in `main()`, so a truncated download does nothing. It refuses to run as root and never uses `sudo`.
- Never logs in to any service, never reads credentials, and never handles private keys. When Arc Studio needs a login, it prints the command for you to run yourself.
- Sends no telemetry. `--dry-run` prints every planned action without changing anything.
- Verify a release download with the `install.sh.sha256` file attached to each GitHub release.

### Edit-time guard (`plugins/stable-build/hooks`, `scripts/`)

- Dormant until you opt in: `scripts/run.sh` exits immediately unless `$STABLE_BUILD_HOME/config.json` contains `"guard": true`. The `"language"` key in the same file never turns it on; once it is on, the hooks read that key only to pick the language of the notices you see.
- When it is on, it runs only inside an Arc project. It reads the hook payload from stdin and at most 256 KB of the project's root config files.
- It never makes network calls, never writes files, never runs project code and never blocks an edit. It runs after the edit has been applied and only adds an advisory message.
- If node is missing or anything fails, it exits 0 and does nothing.
- Codex skips plugin hooks until you trust them in `/hooks`, and asks again whenever a hook changes.
- Uninstalling the plugin removes the hooks.

### MCP plugin (`plugins/stable-build-mcp`)

- Optional. It contains two HTTPS server URLs and no code.
- Queries that trigger these tools leave your machine: they go to docs.arc.io and to Circle. Do not put secrets or private data in prompts that may trigger them.
- stable-build skills never call the docs server's `submit_feedback` tool unless you ask.

### Skills, templates and data

- Skills ask before running commands that change things. They never ask for or store private keys, seed phrases or API tokens. They never sign or send transactions.
- The payouts starter defaults to testnet. Mainnet use needs an explicit flag and a typed confirmation. Its end-to-end test refuses any chain other than Arc testnet (chain id 5042002).
- Text from GitHub, data files, docs and the Arc Studio CLI (`finalText`, `deployments[]`) is treated as untrusted data, never as instructions. On-chain claims are re-checked with read-only RPC calls.

## Hardening checklist for maintainers

- Keep hooks shell-form and fail-open. Never exit 2 from any hook; the guard reports findings as JSON on exit 0.
- Any new network access, file write or command in a hook or the installer needs a SECURITY.md update and review.
- Never commit `.env` files, keys or tokens. CI runs with read-only permissions except where a job states otherwise.
- Release assets are created as drafts. A maintainer reviews and publishes them.

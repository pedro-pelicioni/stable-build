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

- Changes Claude Code and Codex only through their plugin CLIs (`claude plugin …`, `codex plugin …`). It never edits `settings.json`, `.claude.json`, `config.toml` or `hooks.json` by hand.
- Lists what is missing and asks once. Only after that yes (or `--yes`) does it install anything third-party (on `--update`, a no skips just those items and the update goes on):
  - Circle's skills plugin, whose install accepts the Circle Developer Terms (the confirmation links them).
  - The Arc Studio CLI with `npm install -g @circle-fin/arc-studio-cli@latest` when `arc-studio` is missing (under `--prefix`, into `DIR/.npm-global`), then its Claude Code plugin with `arc-studio skills install --tool claude-code`.
  - Arc Foundry: the release archive for your platform and its `.sha256`, downloaded with `curl` from `api.github.com` and `github.com`. Nothing is installed unless the archive matches the checksum.
- Writes these files itself, and nothing else outside Claude Code's and Codex's folders:
  - Under `${STABLE_BUILD_HOME:-$HOME/.stable-build}`: `manifest.json`, `install.log` (the raw output of the last run's commands) and `config.json` (the language you chose plus, only with your consent, the guard keys). The JSON files are written atomically, and other keys already in `config.json` are kept.
  - With your yes, `~/.local/bin/arc-forge`, `arc-cast` and `arc-anvil` (mode 0755). It never overwrites a file it did not write: the manifest records each binary's sha256. They are staged in a directory of their own inside `~/.local/bin` and run with `--version` there first, so a release that does not run replaces nothing, and the staging directory is removed even on Ctrl+C.
  - With your yes, two marked lines at the end of one shell rc file when `~/.local/bin` is not on `PATH`: `~/.zshrc`, or for bash the profile it reads on macOS (`~/.bash_profile`, `~/.bash_login` or `~/.profile`) and `~/.bashrc` on Linux. A symlink there that points at nothing is not followed: you get the PATH line to add instead.
- Records everything it added: `addedByUs` for each plugin and marketplace, the npm package and the npm prefix it went into, the Foundry binaries with their sha256, and the rc file with the two lines. `--uninstall` removes only those. It leaves the rest of the rc file byte for byte, a binary that no longer matches its sha256, and anything that was there before.
- Starts the Arc Studio sign-in only with you at the terminal and after your yes: `arc-studio login` runs on your terminal and you authorize in your browser. It never signs in with `--yes`, without a terminal or in an agent session. It checks the sign-in with `arc-studio whoami`, a network call to Arc Studio. It never reads the token and never runs `arc-studio logout`.
- Without a terminal (or in an agent session) and without `--yes`, it installs only the two stable-build plugins: no npm install, no download, no rc-file edit, and the guard stays off.
- Its other network use (the plugin CLIs cloning from GitHub, `git ls-remote` on circlefin/skills, the MCP health checks) is listed in the README under "What gets touched".
- Wraps all its code in `main()`, so a truncated download does nothing. It refuses to run as root and never uses `sudo`.
- Never reads credentials and never handles private keys.
- Sends no telemetry. `--dry-run` prints every planned action, downloads nothing and changes nothing.
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

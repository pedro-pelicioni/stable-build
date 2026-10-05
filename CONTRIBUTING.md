# Contributing to stable-build

stable-build is a community kit for apps built on Arc, for Claude Code and Codex. It is not affiliated with Circle. Contributions are welcome. The rules below keep the kit accurate, legally clean and safe to install.

## Ground rules

### 1. Brand rule

No plugin, marketplace, skill, agent or package name may contain "arc", "bmad" or "circle". `tools/check-names.mjs` checks name tokens, so `architect` passes and `arc-tools` fails.

- Mention Arc only descriptively, for example "for apps built on Arc".
- Never imply endorsement, and never use Arc or Circle logos. The Arc Network Terms (https://docs.arc.io/terms, "Use of the Company Marks") limit Arc marks to the Arc Brand Kit.
- The MCP server ids `arc-docs` and `circle-codegen`, and references to Circle's own `arc-studio`, are names of Circle's components and are allowed.

### 2. Every chain fact needs a source

- Any statement about Arc or Circle behaviour (addresses, decimals, fees, limits, chain ids, endpoints, contract semantics) needs a link to the page that says it, on https://docs.arc.io or https://developers.circle.com.
- In data files, give each item `source_url` (or `evidence.url`) and `verified_at` (YYYY-MM-DD).
- If you could not confirm something, write UNVERIFIED next to it. Never present a guess as fact.
- Skills should tell the agent to re-check volatile facts through the `arc-docs` MCP server.

### 3. Guard rules need fixtures and evidence

A new or changed rule in `plugins/stable-build/data/gotchas.json` needs:

- a stable `id` that is never reused;
- `severity`, `message` and `fix`;
- `evidence: {url, quote}`, where the quote is a short verbatim sentence from the docs page;
- `verified_at`;
- at least two bad and two good fixtures in `test/guard/fixtures/<rule-id>/`.

`tools/check-links.mjs` fetches each evidence page every week and fails if the quote is gone, which is how we notice that the docs changed.

### 4. Licensing

- Our own code and text are MIT.
- Never copy code or text from a repository that has no open-source license. Reading it for ideas is fine; copying wording, structure or data is not.
- Circle's skills and the Arc Studio CLI are fetched from their sources at install time, never vendored or patched here. Put corrections in our own skills, for example `gotchas`.
- Material adapted from BMad Method (MIT) needs three things:
  - the attribution header right after the frontmatter: `<!-- Adapted from BMad Method v6.12.1 <upstream path> … MIT; see THIRD_PARTY_NOTICES.md. Modified by stable-build contributors. -->`;
  - a row in `plugins/stable-build/skills/UPSTREAM.md`;
  - an update to `THIRD_PARTY_NOTICES.md` if you add a new upstream source. If a row in `UPSTREAM.md` refers to original stable-build text, write "original" in that row.
- Remove `_bmad` paths, `uv run` calls and `customize.toml` merging from adapted files.
- Quote docs sparingly: one short sentence per evidence item, with its URL.

### 5. Wording

Write for builders: plain and specific, with no hype.

- Do not write about yield, APR, APY, ROI, returns or earnings. In Portuguese, that means no "rendimento", "rentabilidade", "lucro", "retorno garantido", "renda passiva", "garantido" or "sem risco".
- Do not say "official", "partner" or "endorsed".
- Treat third-party strings (GitHub metadata, ecosystem names, Arc Studio output) as data, and cap their length.

### 6. Safety

- No private keys, seed phrases or tokens in the repo, tests or fixtures.
- No signing and no transactions in automated tests. Read-only RPC calls (`eth_call`, `eth_getTransactionReceipt`, `eth_getLogs`, `eth_getCode`, `eth_chainId`) are fine.
- Any test that runs `claude`, `codex` or `install.sh` uses a temporary HOME:

  ```sh
  export HOME="$(mktemp -d)" CLAUDE_CONFIG_DIR="$HOME/.claude" CODEX_HOME="$HOME/.codex" STABLE_BUILD_HOME="$HOME/.stable-build"
  ```

- Never run `arc-studio login` or `arc-studio skills install` in tests.

### 7. Two languages

The installer, the hooks' user-facing notices, the skills' output and the README come in English and Brazilian Portuguese (`pt-BR`).

- Change `README.md` and `README.pt-BR.md` together (the payouts template's README pair too). `node tools/check-docs-sync.mjs` fails when their headings, code blocks, cross-links or in-page anchors differ.
- Put a new installer message in both message tables in `install.sh` (`_msg_en` and `_msg_pt`) and print it through `msg`, never as a literal `printf` or `echo`. `test/install/i18n.test.mjs` checks both tables. [AGENTS.md](AGENTS.md#installer-messages) lists the steps.
- Every skill keeps the `## Language` section word for word; the text is in `test/skills/language.test.mjs`.
- If you cannot write Portuguese, add your best attempt and say so in the pull request, so a reviewer can fix it.

## Skill format

- Use `plugins/stable-build/skills/<name>/SKILL.md`. The frontmatter has exactly two keys, `name` and `description`.
- `name` is lowercase kebab-case, at most 64 characters, and equal to the folder name.
- `description` is at most 1,024 characters and says what the skill does and when to use it. Quote it if it contains `: `.
- Avoid built-in command names (`help`, `new`, `clear`, `review`, `code-review` and others) and Circle's skill names. The full lists are in `tools/check-names.mjs`.
- Refer to bundled files by paths relative to the skill folder, such as `references/checklist.md`. `${CLAUDE_PLUGIN_ROOT}` works only in Claude Code, so a skill must also work without it in Codex.
- Do not put a `SKILL.md` anywhere below a skill's top folder, for example inside `templates/`. Codex would load it as a separate skill.
- After adding or renaming a skill, run `node tools/build-catalog.mjs`. It regenerates `skills/guide/references/catalog.md`, which you should not edit by hand.

## Checks to run before a pull request

```sh
npm test                                   # node --test: skills, guard, tools
npm run check                              # names + catalog freshness + offline link/evidence check + translated docs in sync
node tools/check-links.mjs                 # network: every URL resolves, every evidence quote still on its page
bash -n install.sh && /bin/bash -n install.sh   # also macOS bash 3.2; shellcheck runs in CI (install it locally if you can)
HOME="$(mktemp -d)" bash test/install/roundtrip.sh   # installer round trip with stub CLIs (the prompt test runs when python3 is installed)
# validate with a throwaway HOME:
HOME="$(mktemp -d)" CLAUDE_CONFIG_DIR="$HOME/.claude" claude plugin validate --strict .
HOME="$(mktemp -d)" CLAUDE_CONFIG_DIR="$HOME/.claude" claude plugin validate --strict plugins/stable-build
HOME="$(mktemp -d)" CLAUDE_CONFIG_DIR="$HOME/.claude" claude plugin validate --strict plugins/stable-build-mcp
```

CI runs all of these, plus shellcheck and the install round trip on macOS and Ubuntu.

## Releases

1. Bump `version` in `plugins/*/.claude-plugin/plugin.json`, `plugins/*/.codex-plugin/plugin.json` and `package.json`, and `SB_VERSION` in `install.sh`.
2. Add a `## [x.y.z]` section to `CHANGELOG.md`, with the circlefin/skills commit and the CLI versions you tested.
3. Tag `vX.Y.Z` and push the tag. `release.yml` re-checks everything and creates a draft release with `install.sh` and its SHA-256. A maintainer reviews the draft and publishes it.

# Third-party notices

stable-build is a community project. It is not affiliated with, endorsed by, or certified by Circle Internet Group, Inc. or its affiliates, or by BMad Code, LLC.

stable-build's own code and text are MIT-licensed (see [LICENSE](LICENSE)). This file lists material from other projects: what we adapted and ship (section 1), and what we only link to or fetch at install time (section 2). The Arc Studio CLI entry is in section 2 because the CLI itself is not bundled; only some adapted wording is.

## 1. Adapted and redistributed

### BMad Method

| | |
|---|---|
| Upstream | https://github.com/bmad-code-org/BMAD-METHOD |
| Version | v6.12.1, commit `790dae9c8e2a1d73575cb2d40b14dd4963391f29` |
| Tech writer | v6.10.0, commit `081e64ee5aab2316b912883f7bee528ee143ce36`. The tech-writer agent was retired upstream in v6.11.0. |
| License | MIT. The upstream LICENSE is kept unmodified at [third_party/bmad-method/LICENSE](third_party/bmad-method/LICENSE). |
| Where it is used | The role skills and shared workflows listed below, under `plugins/stable-build/skills/`. `plugins/stable-build/skills/UPSTREAM.md` maps each upstream path to our file. |

The skills below are adapted from BMad Method:

| Our skill | Upstream source (paths under `src/` at the tag) |
|---|---|
| `analyst` | `bmm-skills/agents/bmad-agent-analyst`; `core-skills/bmad-brainstorming` (trimmed) |
| `pm` | `bmm-skills/agents/bmad-agent-pm`; `bmm-skills/plan/bmad-prd` |
| `ux-designer` | `bmm-skills/agents/bmad-agent-ux-designer`; `bmm-skills/plan/bmad-ux` |
| `architect` | `bmm-skills/agents/bmad-agent-architect` |
| `dev` | `bmm-skills/agents/bmad-agent-dev`; `bmm-skills/v6-shims/bmad-dev-story` |
| `tech-writer` | v6.10.0 `bmm-skills/1-analysis/bmad-agent-tech-writer` (SKILL.md and its four prompt files) |
| `product-brief` | `bmm-skills/plan/bmad-product-brief` |
| `architecture` | `bmm-skills/plan/bmad-architecture` |
| `stories` | `bmm-skills/plan/bmad-create-epics-and-stories` |
| `layered-review` | `bmm-skills/ship/bmad-code-review` |

`plugins/stable-build/skills/UPSTREAM.md` gives the upstream path for each individual file.

**Changes made by stable-build contributors:**

- Persona names are replaced by role names, and the `bmad-` prefix is removed from every skill name.
- The `_bmad/scripts` runtime is removed. That covers `uv run`, `resolve_customization.py`, `resolve_config.py`, `memlog.py` and `customize.toml` merging. Skills read plain files relative to their own folder.
- Menus, activation steps and workflows are condensed. Menu items route to stable-build skills such as `find-idea`, `gotchas` and `go-live`.
- Outputs are written to `docs/plan/` and `docs/stories/` in the user's project, not to `_bmad-output/`.
- Guidance for apps built on Arc is added:
  - PRD: an "Onchain" section covering network, assets, EOA versus smart account, blocklist and fees in USDC.
  - UX: one USDC balance, one-confirmation states, dropped and blocklisted states, and a testnet banner.
  - Architecture: Arc invariants as candidate decisions.
  - Dev: test-first on Arc Foundry; a story is done when tests pass and a testnet transaction hash is recorded.
  - Stories: Arc acceptance criteria.
  - Review: an extra layer that runs the stable-build gotcha scan.
  - Tech writer: a brand rule and no yield language.
- The brainstorming technique list is trimmed.
- Each adapted file has an HTML-comment header that names its upstream path and points to this file.

**Trademarks.** BMad, BMad Method and BMad Core are trademarks of BMad Code, LLC. We use them only to say where the adapted material came from, as the upstream [TRADEMARK.md](https://github.com/bmad-code-org/BMAD-METHOD/blob/v6.12.1/TRADEMARK.md) allows. No stable-build plugin, skill or package name contains them.

**License text** (verbatim from the upstream LICENSE at v6.12.1; v6.10.0 has the same text). The `CONTRIBUTORS.md` it mentions is upstream at https://github.com/bmad-code-org/BMAD-METHOD/blob/v6.12.1/CONTRIBUTORS.md.

```text
MIT License

Copyright (c) 2025 BMad Code, LLC

This project incorporates contributions from the open source community.
See [CONTRIBUTORS.md](CONTRIBUTORS.md) for contributor attribution.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

TRADEMARK NOTICE:
BMad™, BMad Method™, and BMad Core™ are trademarks of BMad Code, LLC, covering all
casings and variations (including BMAD, bmad, BMadMethod, BMAD-METHOD, etc.). The use of
these trademarks in this software does not grant any rights to use the trademarks
for any other purpose. See [TRADEMARK.md](TRADEMARK.md) for detailed guidelines.
```

## 2. Linked or fetched at install time (not in this repo)

Nothing in this section is vendored, copied or patched in this repository, apart from the adapted Arc Studio wording described below. `install.sh` and the README tell users how to get each item from its own source, under its own terms.

### Circle skills (circlefin/skills)

- Source: https://github.com/circlefin/skills
- License: Apache-2.0, https://github.com/circlefin/skills/blob/master/LICENSE
- Tested against: commit `58ab8648bb1ae9d037a3bf5197ad3bb01262f5b1` (plugin version 1.6.0). The upstream repo has no tags, so `CHANGELOG.md` records the SHA for each release.
- How it is used: the installer runs Circle's own marketplace commands (`circle-skills@circle` for Claude Code, `circle@circle-skills` for Codex), so the files come from Circle's repo. Our corrections and additions for Arc are original text in our own `gotchas` skill. We do not ship a modified copy of any Circle file.
- Circle states that its skills' outputs may configure fees that go to Circle and that use is subject to the Circle Developer Terms: https://console.circle.com/legal/developer-terms. The installer shows that notice before it adds the skills.

### Arc Studio CLI (`@circle-fin/arc-studio-cli`)

- Source: https://www.npmjs.com/package/@circle-fin/arc-studio-cli. Docs: https://docs.arc.io/ai/arc-studio-cli.
- License: MIT, Copyright (c) 2026 Circle Internet Financial, LLC. The package's LICENSE file from version 1.1.3 is kept unmodified at [third_party/arc-studio-cli/LICENSE](third_party/arc-studio-cli/LICENSE).
- The CLI is not bundled. Users install it from npm. When it is already present, the installer runs the CLI's own `arc-studio skills install` command.
- Our `studio-delegate` skill adapts some wording from the package's bundled agent guidance (`agents/arc-studio.md`, `SKILL.md` and `agent-guide` output, version 1.1.3). Those files carry a header that says so, and the MIT notice above applies to that wording. We changed it to work in both Claude Code and Codex, check results on-chain before trusting them, and never log in for the user.
- The hosted Arc Studio service is a separate Circle service under Circle's own terms.

### Hosted MCP servers (configured by URL only)

The optional `stable-build-mcp` plugin contains only two server URLs. No server code is included.

| Server | URL | Docs | Terms |
|---|---|---|---|
| `arc-docs` | https://docs.arc.io/mcp | https://docs.arc.io/ai/mcp | https://docs.arc.io/terms |
| `circle-codegen` | https://api.circle.com/v1/codegen/mcp | https://developers.circle.com/ai/mcp | https://console.circle.com/legal/developer-terms |

### Arc and Circle documentation

- Skills and data files state facts in our own words, with a link to the page each fact comes from, mostly on https://docs.arc.io and https://developers.circle.com.
- `plugins/stable-build/data/gotchas.json` keeps one short quote per rule as evidence. `tools/check-links.mjs` re-reads the source page to detect when the docs change.
- `plugins/stable-build/data/ecosystem.json` and `sample-apps.json` hold facts only: names, URLs, categories, license IDs and dates, plus our own one-line summaries. They contain no descriptions or logos copied from arc.io.
- Arc Network Terms: https://docs.arc.io/terms. Its "Use of the Company Marks" section limits use of Arc logos and marks to the Arc Brand Kit and Circle's Brand Use Policy. stable-build uses no Arc or Circle logos and uses "Arc" only descriptively, as in "for apps built on Arc".

### Not used

Other community kits, including ones for other chains, were looked at only to decide what to avoid. No code or text from any repository without an open-source license is included here.

## 3. Trademarks

Arc, Circle and USDC are trademarks of Circle Internet Group, Inc. or its affiliates. Claude and Claude Code are trademarks of Anthropic, PBC. Codex is a trademark of OpenAI. All of these names are used only to describe compatibility.

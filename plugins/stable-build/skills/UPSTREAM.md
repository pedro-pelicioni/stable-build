# Upstream sources for the methodology skills

The methodology skills (`analyst`, `pm`, `ux-designer`, `architect`, `dev`, `tech-writer`, `product-brief`, `architecture`, `stories`, `layered-review`) are adapted from BMad Method, MIT License, Copyright (c) 2025 BMad Code, LLC. The license is kept verbatim at `third_party/bmad-method/LICENSE` (repository root) and the notice is in THIRD_PARTY_NOTICES.md (repository root). stable-build is a community project, not affiliated with or endorsed by BMad Code, LLC; the BMad names are used here only to identify the source.

| Upstream | Tag | Commit |
| --- | --- | --- |
| https://github.com/bmad-code-org/BMAD-METHOD | v6.12.1 | 790dae9c8e2a1d73575cb2d40b14dd4963391f29 |
| same (technical-writer persona, retired upstream in v6.11.0) | v6.10.0 | 081e64ee5aab2316b912883f7bee528ee143ce36 |

Every adapted file below starts (right after its frontmatter, if any) with an HTML comment naming its upstream path, version and commit. Paths in the "Ours" column are relative to `plugins/stable-build/skills/`.

## File map

| Upstream path (v6.12.1 unless noted) | Ours | Modifications |
| --- | --- | --- |
| `src/bmm-skills/agents/bmad-agent-analyst/{SKILL.md,customize.toml}` | `analyst/SKILL.md` | Role name only; persona fields inlined; menu: IF → find-idea, BP → local brainstorm prompt, RS → inline quick research (replaces the deep-research skill), CB → product-brief, H → guide; grounded in Arc's Request for Builders. |
| `src/core-skills/bmad-brainstorming/{SKILL.md,references/mode-facilitator.md,references/mode-partner.md,references/mode-autonomous.md,references/in-chat-techniques.md,references/converge.md,references/finalize.md,references/resume.md}` | `analyst/references/brainstorm.md` | Condensed into one prompt; HTML composer page and technique helper script removed; log is a plain markdown file at docs/plan/brainstorm-{slug}.md; headless mode removed; hands off to find-idea / product-brief. |
| `src/core-skills/bmad-brainstorming/assets/brain-methods.csv` | `analyst/references/techniques.md` | Trimmed from 108 to 30 techniques, reworded, as a markdown table; added "Arc lenses" prompts. |
| `src/bmm-skills/agents/bmad-agent-pm/{SKILL.md,customize.toml}` | `pm/SKILL.md` | Role name only; menu: PRD → local prompt, CB → product-brief, CE → stories, IR → inline readiness check (replaces sprint planning), IF → find-idea, GL → go-live, H → guide; correct-course dropped. |
| `src/bmm-skills/plan/bmad-prd/{SKILL.md,customize.toml,assets/prd-validation-checklist.md}` | `pm/references/prd.md` | Output to docs/plan/prd.md + prd-addendum.md; shared decisions log replaces the memlog script; rubric condensed inline; HTML validation report, headless mode, external handoffs and doc-standards hooks removed; testnet proof required per onchain FR; added Onchain reviewer lens. |
| `src/bmm-skills/plan/bmad-prd/assets/prd-template.md` | `pm/assets/prd-template.md` | Condensed; new example journey; "Testnet proof" field on FRs; new **Onchain (apps built on Arc)** Adapt-In cluster (network plan, assets and decimals, EOA vs smart account, blocklist, fees in USDC, finality states, public data, evidence). |
| `src/bmm-skills/agents/bmad-agent-ux-designer/{SKILL.md,customize.toml}` | `ux-designer/SKILL.md` | Role name only; menu: CU → local prompt, OS → onchain-states review, PRD → pm, H → guide. |
| `src/bmm-skills/plan/bmad-ux/{SKILL.md,customize.toml,references/design-md-spec.md,references/creative-tools.md,references/validate.md,assets/key-screens.md}` | `ux-designer/references/ux-spec.md` | Output to docs/plan/DESIGN.md, docs/plan/EXPERIENCE.md, docs/plan/ux/; creative tools condensed; example files, Excalidraw and Stitch handoff, HTML report, headless mode removed; onchain states mandatory in State Patterns; added onchain-states reviewer lens. |
| `src/bmm-skills/agents/bmad-agent-architect/{SKILL.md,customize.toml}` | `architect/SKILL.md` | Role name only; menu: CA → architecture, IR → inline readiness check, GT → gotchas, NEW → new-app, H → guide; principle added: Arc protocol rules are adopted, not debated. |
| `src/bmm-skills/plan/bmad-architecture/{SKILL.md,customize.toml}` | `architecture/SKILL.md` | Output to docs/plan/architecture.md; decisions log replaces the memlog script; spec-package routing removed; spine seeded with Arc invariants as AD-1..n [ADOPTED: Arc protocol]; stable-build starters recommended first. |
| `src/bmm-skills/plan/bmad-architecture/assets/spine-template.md` | `architecture/assets/spine-template.md` | Wrapped in a fenced block; network frontmatter; Arc invariant AD block with source; Arc rows in Stack; amount-units and tx-state conventions. |
| `src/bmm-skills/plan/bmad-architecture/references/reviewer-gate.md` (+ `finalize_reviewers` in `customize.toml`) | `architecture/references/reviewer-gate.md` | Spine lint script replaced by a manual mechanical pass; Arc invariants in the checklist; adversary lens gets Arc divergence examples; sequential fallback. |
| `src/bmm-skills/plan/bmad-create-epics-and-stories/{SKILL.md,steps/step-01..04}` | `stories/SKILL.md` | Four step files condensed into one file with five phases; added phase 5 (story files in docs/stories/); Arc acceptance criteria and testnet-evidence criterion for onchain stories; outputs to docs/plan/epics.md. |
| `src/bmm-skills/plan/bmad-create-epics-and-stories/templates/epics-template.md` | `stories/assets/epics-template.md` | phasesDone frontmatter; architecture-requirements section; testnet-evidence line per story. |
| `src/bmm-skills/v6-shims/bmad-create-story/template.md` | `stories/assets/story-template.md` | Status in file (no sprint-status file); Testnet Evidence table; Dev Notes cite spine ADs and docs.arc.io sources. |
| `src/bmm-skills/agents/bmad-agent-dev/{SKILL.md,customize.toml}` | `dev/SKILL.md` | Role name only; Arc principles (Arc Foundry tests, fee floor, done = tests + testnet tx hash, no keys, no mainnet); menu: DS → local prompt, CR → layered-review, GT → gotchas, NEW → new-app, SP → stories, GL → go-live, H → guide. |
| `src/bmm-skills/v6-shims/bmad-dev-story/{SKILL.md,checklist.md}` | `dev/references/dev-story.md` | XML workflow rewritten as ten plain steps; sprint-status file removed (status lives in the story); red/green on FOUNDRY_PROFILE=arc arc-forge test / arc-anvil --network arc; Arc scan in validation; testnet-evidence step verified read-only; definition of done condensed. |
| v6.10.0 `src/bmm-skills/1-analysis/bmad-agent-tech-writer/{SKILL.md,customize.toml}` | `tech-writer/SKILL.md` | Role name only; brand rule, no-yield-language rule, public-data rule, explainer format; document-project item dropped. |
| v6.10.0 `src/bmm-skills/1-analysis/bmad-agent-tech-writer/write-document.md` | `tech-writer/references/write-document.md` | Frontmatter removed; Arc fact checks via arc-docs MCP. |
| v6.10.0 `src/bmm-skills/1-analysis/bmad-agent-tech-writer/mermaid-gen.md` | `tech-writer/references/mermaid-gen.md` | Frontmatter removed; Arc lifecycle accuracy note. |
| v6.10.0 `src/bmm-skills/1-analysis/bmad-agent-tech-writer/validate-doc.md` | `tech-writer/references/validate-doc.md` | Frontmatter removed; Arc writing-rule checks. |
| v6.10.0 `src/bmm-skills/1-analysis/bmad-agent-tech-writer/explain-concept.md` | `tech-writer/references/explain-concept.md` | Frontmatter removed; "What's happening / Under the hood" format. |
| `src/bmm-skills/plan/bmad-product-brief/{SKILL.md,customize.toml}` | `product-brief/SKILL.md` | Output to docs/plan/brief.md + brief-addendum.md; decisions log replaces the memlog script; headless JSON mode and external handoffs removed; routes to find-idea when there is no idea; wording rules. |
| `src/bmm-skills/plan/bmad-product-brief/assets/brief-template.md` | `product-brief/assets/brief-template.md` | Frontmatter added; new "Onchain angle" and "Open questions" sections. |
| `src/bmm-skills/ship/bmad-code-review/{SKILL.md,customize.toml,steps/step-01-gather-context.md,steps/step-02-review.md}` | `layered-review/SKILL.md` | Renamed so it cannot be confused with the built-in /code-review and /review commands; step files condensed; sprint-status discovery replaced by docs/stories/ status; added the gotcha-hunter layer; sequential in-session fallback plus export option when subagents are unavailable. |
| `src/bmm-skills/ship/bmad-code-review/{steps/step-03-triage.md,steps/step-04-present.md}` | `layered-review/references/triage.md` | Condensed; story done additionally requires verified testnet evidence; deferred work to docs/stories/deferred-work.md. |
| `src/bmm-skills/ship/bmad-code-review/customize.toml` (layer `blind-hunter`) | `layered-review/review-prompts/blind-hunter.md` | Inline layer instruction moved to its own file. |
| `src/bmm-skills/ship/bmad-code-review/customize.toml` (layer `acceptance-auditor`) | `layered-review/review-prompts/acceptance-auditor.md` | Own file; checks Arc criteria and the Testnet Evidence table. |
| `src/bmm-skills/ship/bmad-code-review/{review-prompts/edge-case-hunter.md,references/deletion-check.md,references/claims-check.md}` | `layered-review/review-prompts/edge-case-hunter.md` | Three files merged; Arc boundaries and unit mismatches added to the path walk. |
| `src/bmm-skills/ship/bmad-code-review/review-prompts/verification-gap.md` | `layered-review/review-prompts/verification-gap.md` | Condensed; tests run under upstream Foundry count as broken verification for Arc behavior. |

## Removed everywhere

- The upstream Python runtime: the customization resolver, the config resolver and the memlog script, and every command that invoked them through uv. Persona and workflow settings are plain text in each SKILL.md; team overrides are an optional `.stable-build/<skill>.md` file read as standing rules; the memlog is replaced by an append-only `docs/plan/decisions.md`.
- `customize.toml` files and their structural merge rules.
- Upstream output folders; outputs go to `docs/plan/` and `docs/stories/` in the user's project.
- Persona names and the real-person "identity" lines; role names only.
- Upstream skill names and the upstream help router; menus route to stable-build skills (guide, find-idea, new-app, gotchas, go-live, and the ten methodology skills).
- Party mode, advanced elicitation, deep research, PRFAQ, sprint planning, correct course, retrospective, build and QA skills (not shipped in v1).

## stable-build original files (not adapted, no upstream header)

- `architecture/references/arc-invariants.md` (original)
- `ux-designer/assets/onchain-states.md` (original)
- `stories/references/arc-acceptance-criteria.md` (original)
- `layered-review/review-prompts/gotcha-hunter.md` (original)

## Re-syncing

Before each stable-build release: `npm view bmad-method version`, then diff the upstream paths above between the pinned tag and the new release, and port only fixes that fit. Upstream main (6.13.0-next at the time of writing) has a different layout and drops the epics-and-stories skill; keep pinning to a release tag.

---
name: stories
description: Break the PRD, UX and architecture of an app built on Arc into user-value epics and dev-ready story files (docs/plan/epics.md, docs/stories/), with Arc acceptance criteria and a testnet-evidence criterion for onchain stories. Use in a project built on Arc when the user asks for stable-build epics and stories for the Arc app, or to prepare its next story.
---
<!-- Adapted from BMad Method v6.12.1 src/bmm-skills/plan/bmad-create-epics-and-stories/{SKILL.md,steps/step-01-validate-prerequisites.md,steps/step-02-design-epics.md,steps/step-03-create-stories.md,steps/step-04-final-validation.md} (https://github.com/bmad-code-org/BMAD-METHOD, commit 790dae9c). Copyright (c) 2025 BMad Code, LLC. MIT; see THIRD_PARTY_NOTICES.md. Modified by stable-build contributors. -->

# Epics and stories

**Goal:** turn PRD requirements, UX requirements and architecture decisions into stories organized by user value, each with acceptance criteria a developer (human or agent) can implement and test without guessing.

**Your role:** product strategist and specification writer working with the product owner as an equal. You bring decomposition and acceptance-criteria craft; they bring the vision and the users.

Paths: `docs/` is in the user's project; `assets/` and `references/` are in this skill's folder.

## How to run

Five phases, in order. Finish each phase, show the result, and **wait for the user to say continue** before the next. Record progress in `docs/plan/epics.md` frontmatter (`phasesDone: [1, 2, …]`), so a later run can resume. Never skip a phase.

**Arc check.** This skill is for apps built on Arc. If the project shows no Arc marker (`.stable-build/project.json`, chain id 5042 or 5042002, an `rpc.*.arc.io` URL, `arc`/`arcTestnet` from `viem/chains`, USDC `0x3600…0000`) and the user did not name stable-build or Arc, say so in one line and offer to hand off to their general tools; continue only if they confirm.

If `.stable-build/stories.md` exists, read it first as standing team rules. If `epics.md` already exists, offer to resume at the next phase, or "prepare the next story" (phase 5 only).

### Phase 1: Requirements

1. Find the inputs: `docs/plan/prd.md` (required), `docs/plan/architecture.md` (strongly recommended), `docs/plan/EXPERIENCE.md` and `docs/plan/DESIGN.md` (when there is a UI). Confirm the list with the user; missing PRD → hand off to `pm`.
2. Extract, completely:
   - **FRs** as written in the PRD (keep its ids), each clear and testable.
   - **NFRs**: performance, security, reliability, compliance.
   - **Architecture requirements**: the starter (if the spine names one, it becomes Epic 1 Story 1), environments, integrations, monitoring, and every `AD-n` a story will have to honor.
   - **UX design requirements** as their own list (`UX-DR1…`), specific enough to test: components, states (including the onchain states), accessibility, responsive rules.
3. Copy `assets/epics-template.md` to `docs/plan/epics.md` and fill the Requirements Inventory. Show the lists and ask what is missing.

### Phase 2: Epics

Principles: each epic lets a user do something meaningful and stands alone; group FRs into cohesive outcomes; later epics may build on earlier ones but never the reverse; no technical-layer epics ("set up database", "build API", "CI pipeline" deliver no user value); consolidate epics that would all churn the same core files.

Assess how settled the design is. When direction is unlikely to change, prefer fewer, larger epics; split where there is a real risk boundary or where early feedback could change what follows. For each epic give the title, the user outcome, FRs covered and implementation notes. Build the FR coverage map. Iterate with the user until they approve the list.

### Phase 3: Stories

For each epic in order: show its goal, FRs, relevant NFRs, ADs and UX-DRs; agree the story breakdown; write each story; review it with the user ("does this capture the requirement?"); append it to `epics.md`.

- Each story fits one developer session, delivers user value, and depends only on earlier stories.
- Create data structures and contracts only when the story that needs them arrives.
- Format: "As a {user}, I want {capability}, so that {benefit}", then acceptance criteria in **Given / When / Then / And**. Each criterion is independently testable and covers errors and edge cases.
- **Arc criteria.** For any story that reads or writes chain state, pick the applicable criteria from `references/arc-acceptance-criteria.md` and adapt them to the story. Every such story ends with the **testnet evidence** criterion. A story with no onchain effect says so: `Testnet evidence: n/a (no onchain effect)`.

### Phase 4: Validation

Check, and list each failure with what is missing:

- Every FR appears in at least one story and the criteria fully cover it.
- If the spine names a starter, Epic 1 Story 1 sets the project up from it (for a stable-build starter, via the `new-app` skill).
- Every onchain story has Arc criteria and a testnet-evidence criterion; every Arc invariant AD in the spine is honored by the stories it binds.
- Stories have clear criteria, cite their FRs, and have no forward dependencies (N.2 needs only N.1; no "wait for story 1.4").
- Epics deliver user value; no big upfront technical work; file churn across epics was either avoided or deliberately accepted.

If anything fails, keep `status: draft`, say "epics.md saved as draft, N checks open", and offer to fix and re-run. When all pass, ask to complete; on yes set `status: final`.

### Phase 5: Story files

Write one file per story the user wants to start (default: all of Epic 1) to `docs/stories/{epic}.{story}-{slug}.md` from `assets/story-template.md`, with `Status: ready-for-dev`. Fill Dev Notes from the spine: cite each AD the story must honor by id, list files and modules likely touched, name the test commands, and link the docs.arc.io pages behind its Arc criteria. Never put secrets or private keys in a story.

Close by sharing the paths. Next: the `dev` skill ("dev the next story").

## Language

Before your first reply in a session, read the saved language once: `cat "${STABLE_BUILD_HOME:-$HOME/.stable-build}/config.json" 2>/dev/null`. If it sets `"language"`, write everything the user reads in that language (`pt-BR` is Brazilian Portuguese, `en` is English): replies, questions, menus, tables and the documents you generate, such as reports, briefs, PRDs, stories and idea lists. With no saved language, use the user's language. Wherever this skill says "the user's language", it means this choice. Keep code, identifiers, file names, paths, frontmatter keys and status values, rule ids, commands, CLI flags, commit messages and verbatim docs quotes in English.

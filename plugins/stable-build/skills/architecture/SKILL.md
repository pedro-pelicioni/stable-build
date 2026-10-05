---
name: architecture
description: Create, update or validate the architecture spine of an app built on Arc in docs/plan/architecture.md - the few decisions that keep separately built parts consistent, starting from Arc's protocol invariants (decimals, fee floor, finality, EOA-only Memo). Use in a project built on Arc when the user asks to create, update or validate the Arc app's architecture spine, technical design or solution design.
---
<!-- Adapted from BMad Method v6.12.1 src/bmm-skills/plan/bmad-architecture/{SKILL.md,customize.toml} (https://github.com/bmad-code-org/BMAD-METHOD, commit 790dae9c). Copyright (c) 2025 BMad Code, LLC. MIT; see THIRD_PARTY_NOTICES.md. Modified by stable-build contributors. -->

# Architecture spine

You produce an **architecture spine**: a consistency contract that fixes only the **invariants** that keep independently built units from diverging. That means the design paradigm, boundary and dependency rules, how state is mutated, and who owns shared data. Everything structural (stack, tree, full data shape) is **seed**: true at cold start, owned by the code once it exists.

One test decides what belongs:

> If two units one level down built this independently, could they choose incompatibly? Fix it here only when the answer is yes, **and** the call is non-obvious, **and** it is a real trade-off. Otherwise list it under Deferred.

On Arc, part of the answer is already decided by the chain. Those decisions go in first (see **Arc invariants**).

Paths: `docs/` and `.stable-build/` are in the user's project. `assets/` and `references/` are in this skill's folder.

**Arc check.** This skill is for apps built on Arc. If the project shows no Arc marker (`.stable-build/project.json`, chain id 5042 or 5042002, an `rpc.*.arc.io` URL, `arc`/`arcTestnet` from `viem/chains`, USDC `0x3600…0000`) and the user did not name stable-build or Arc, say so in one line and offer to hand off to their general tools; continue only if they confirm.

## How you work

- **Coaching path is the default.** Offer it before any drafting: **Coaching** (open questions; you pull the decisions out of the user and push back where one is thin) or **Fast** (you draft the whole spine with `[ASSUMPTION]` tags the user corrects). Unless the user clearly wants speed, coach.
- Load-bearing calls (paradigm, stack or starter, major boundaries) are **shown, not silently made**: lay out the realistic options, say which way you lean and why, and let the user choose.
- Elicit, don't quiz. Open questions beat multiple choice; keep either/or for real binary forks.
- **Greenfield:** recommend a starter. Check the stable-build starters first (`new-app` skill, for example the payouts starter), then a well-known current starter verified on the web.
- **Brownfield:** read enough of the real code to ratify the conventions already there. Don't re-tell the user what the scan shows.
- Verify every named technology's current version before binding it. For Arc: Arc Foundry release, `viem` version that exports `arc`/`arcTestnet` from `viem/chains`. The arc-docs MCP needs no ask. `npm view` and release-page or GitHub API fetches send requests: ask once before running them, as the guide skill does. Without them, bind the starter's pinned versions and mark each one UNVERIFIED in the spine and in `docs/plan/decisions.md`.
- Record decisions, not rationale. Rationale goes to the decisions log. Carry shape in mermaid diagrams, not prose.

## Inputs

Read what exists: `docs/plan/prd.md`, `docs/plan/DESIGN.md`, `docs/plan/EXPERIENCE.md`, `docs/plan/brief.md`, the codebase, and `docs/plan/decisions.md`. Extract, don't ingest: send big documents to subagents and keep only what binds the architecture. Inherit what is already settled silently; mark real gaps as open questions instead of inventing answers. If the input is too thin to build on, suggest the `pm` skill (PRD) first.

**Altitude.** A spine for a small app may be the paradigm, the Arc invariants, three app decisions and the conventions table. A platform earns more. A spine for one epic inherits the parent spine's AD ids read-only and only decides what the parent left open.

## Decisions log

`docs/plan/decisions.md` is the shared, append-only memory for all planning skills. Append one line per decision, constraint, version, assumption or open question as it happens:

`- YYYY-MM-DD [arch] decision: <what it binds> / <divergence it prevents>`

Never edit or reorder earlier lines. A resumed run reloads this file first. The spine is distilled from it at the end.

## Arc invariants

Read `references/arc-invariants.md`. For each entry, ask whether the app touches it (moves USDC, sends transactions, indexes logs, uses Memo or Multicall3From, ships contracts). Confirm each one you keep through the arc-docs MCP and keep its source URL. They go first in **Invariants & Rules** as `AD-1`, `AD-2`, … tagged `[ADOPTED: Arc protocol]`. App decisions continue the numbering.

Roadmap features (anything docs.arc.io does not document as live) go under **Deferred**, never into a binding rule.

## On activation

1. If `.stable-build/architecture.md` exists, read it as standing team rules.
2. Greet in the user's language. Detect the intent: **create** (default), **update** an existing spine, or **validate** one. If the real ask is requirements, UX or stories, hand off to `pm`, `ux-designer` or `stories`.
3. If `docs/plan/architecture.md` exists with `status: draft`, offer to resume from the decisions log rather than restart.
4. Create: offer Coaching or Fast.
5. Before drafting, in both paths: ask whether the spine is the only deliverable. If not, draw out the purpose and audience (a one-page explainer, a deck for a team, a board-level picture). Purpose right-sizes everything.

For a new spine, copy the template in `assets/spine-template.md` to `docs/plan/architecture.md`, set `status: draft`, tell the user the path, and log the start.

## Reviewer gate

Run it at Finalize and as the whole of Validate. Mechanics are in `references/reviewer-gate.md`. At Finalize you apply the clear fixes; under Validate you only report.

## Finalize

1. **Distill.** Write the spine from the decisions log (plus the code, for brownfield). Invariants first, seed minimal, every AD with Binds / Prevents / Rule, Deferred naming what it won't decide. Strip every template comment. Every dimension the altitude owns is decided, deferred or an open question; a silent dimension is the failure. Watch especially deployment and environments (testnet and mainnet, RPC providers, key custody) and operations (monitoring, blocklist screening).
2. **Reconcile inputs.** One subagent per load-bearing input checks it against the spine and returns what did not land, especially quiet requirements (a tone, a constraint).
3. **Reviewer pass.** Run the gate. Resolve before polish.
4. **Triage.** Open questions and `[ASSUMPTION]` tags: blockers resolved one at a time; the rest deferred with a revisit condition in the log.
5. **Renderings.** If the user wants a human-facing artifact (an HTML walkthrough, a C4 set, a work split by team), build only what they pick. Never pad the spine itself.
6. **Close.** Set `status: final` and `updated` in the spine's frontmatter; log `event: spine finalized`. Share the path. Next: the `stories` skill, then `dev`.

## Update

Resume from the decisions log, not the rendered spine. Keep AD ids stable: amend a Rule in place, add the next AD for a new decision, never renumber or reuse an id. Re-distill, run the gate, close. If the change overrides a source document (PRD, UX), offer to update that document too.

## Validate

Critique without changing: run the gate against the spine, write the report to `docs/plan/reviews/architecture-review.md`, and offer to roll findings into an Update.

## Language

Before your first reply in a session, read the saved language once: `cat "${STABLE_BUILD_HOME:-$HOME/.stable-build}/config.json" 2>/dev/null`. If it sets `"language"`, write everything the user reads in that language (`pt-BR` is Brazilian Portuguese, `en` is English): replies, questions, menus, tables and the documents you generate, such as reports, briefs, PRDs, stories and idea lists. With no saved language, use the user's language. Wherever this skill says "the user's language", it means this choice. Keep code, identifiers, file names, paths, frontmatter keys and status values, rule ids, commands, CLI flags, commit messages and verbatim docs quotes in English.

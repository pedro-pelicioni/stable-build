<!-- Adapted from BMad Method v6.12.1 src/bmm-skills/plan/bmad-architecture/assets/spine-template.md (https://github.com/bmad-code-org/BMAD-METHOD, commit 790dae9c). Copyright (c) 2025 BMad Code, LLC. MIT; see THIRD_PARTY_NOTICES.md. Modified by stable-build contributors. -->

# Spine template

Copy the block below to `docs/plan/architecture.md`. The `<!-- -->` notes inside it are guidance: act on them, then delete them. The finished spine carries no template comments and no empty sections.

````markdown
---
name: '{app name}'
type: architecture-spine
purpose: build-substrate    # build-substrate (default) · discussion · report · deck
altitude: feature           # initiative · feature · epic
paradigm: '{named pattern, e.g. hexagonal, layered, pipes-and-filters}'
scope: '{what this spine governs}'
network: testnet            # testnet (5042002) until go-live; then mainnet (5042)
status: draft               # draft · final
created: '{YYYY-MM-DD}'
updated: '{YYYY-MM-DD}'
sources: []                 # e.g. docs/plan/prd.md, docs/plan/EXPERIENCE.md
---

# Architecture spine: {app name}

<!-- Keep only the sections this spine needs. Decisions, not rationale (rationale lives in docs/plan/decisions.md). Shape goes in mermaid diagrams. -->

## Design paradigm

<!-- Name the pattern and map its layers to directories. Say where onchain code (contracts, chain clients) sits relative to app logic. -->

## Inherited invariants

<!-- Only for an epic spine under a parent spine: parent AD ids, read-only, never renumbered. Cut otherwise. -->

| Inherited | From parent | Binds here |
| --- | --- | --- |

## Invariants & rules

<!-- Arc protocol invariants first (from the architecture skill's references/arc-invariants.md), tagged [ADOPTED: Arc protocol], each with its docs.arc.io source. Then app decisions. Stable ascending ids, never reused. Include one dependency-direction diagram as valid mermaid. -->

### AD-1: {decision} [ADOPTED: Arc protocol]

- **Binds:** {areas, FR ids, or all}
- **Prevents:** {the divergence this stops}
- **Rule:** {the enforceable constraint}
- **Source:** {docs.arc.io URL}

### AD-{n}: {app decision}

- **Binds:**
- **Prevents:**
- **Rule:**

## Consistency conventions

| Concern | Convention |
| --- | --- |
| Amount units (contracts, API, ledger, UI) | |
| Naming (entities, files, events) | |
| Data formats (ids, dates, error shapes) | |
| Chain access (one client module, RPC config, retries, polling interval) | |
| Errors and tx states (rejected, pending, final, reverted, dropped) | |

## Stack

<!-- SEED: name + pinned version, verified at authoring. -->

| Name | Version |
| --- | --- |
| Arc network | testnet `5042002` / mainnet `5042` |
| Arc Foundry (`arc-forge`, `arc-cast`, `arc-anvil`) | {release} |
| {language / framework / chain client, e.g. viem} | {version} |

## Structural seed

<!-- Only what is non-obvious at cold start, as valid mermaid or a minimal tree: system view, deployment and environments (testnet, mainnet, RPC providers, who holds which key), core entities. -->

```text
{root}/
  {dir}/   # {what lives here}
```

## Capability → architecture map

<!-- Present when a PRD drove the run. Cut otherwise. -->

| Capability / FR | Lives in | Governed by |
| --- | --- | --- |

## Deferred

<!-- Decisions pushed down, each with why it can wait. Arc roadmap features that docs.arc.io does not list as live go here. -->
````

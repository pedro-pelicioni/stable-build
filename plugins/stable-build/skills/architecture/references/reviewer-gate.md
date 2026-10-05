<!-- Adapted from BMad Method v6.12.1 src/bmm-skills/plan/bmad-architecture/references/reviewer-gate.md and the finalize_reviewers in customize.toml (https://github.com/bmad-code-org/BMAD-METHOD, commit 790dae9c). Copyright (c) 2025 BMad Code, LLC. MIT; see THIRD_PARTY_NOTICES.md. Modified by stable-build contributors. -->

# Reviewer gate

The spine's pre-handoff review. It runs at Finalize (after distill and reconcile) and it *is* the Validate intent. At Finalize you apply the clear fixes; under Validate you report and change nothing.

## 1. Mechanical pass (do it yourself first)

- No `{placeholders}` and no template comments left.
- No duplicate AD ids; every AD has Binds, Prevents and Rule.
- Every Arc-protocol AD has a docs.arc.io source URL.
- Every Stack row has a pinned version.

## 2. Lenses

Scale to the stakes: a throwaway prototype may run the gate quietly or skip it; a spine that will move real USDC on mainnet runs every lens. The three lenses below always run once the gate runs; add ad-hoc lenses when warranted (security for custody-heavy designs, a data-integrity lens for a ledger).

1. **Rubric walker.** Judge the spine against the good-spine checklist below.
2. **Reality check.** Was every committed decision verified rather than asserted from memory: current library versions, that each named technology still exists and fits, the live defaults of any starter, and each Arc fact against docs.arc.io (arc-docs MCP)? Flag anything that could be stale.
3. **Adversary.** Build two units one level down that each obey every AD to the letter yet still build incompatibly: clashing amount units, two owners of one entity, two paths that submit transactions with different fee rules, two indexers counting different emitters. Each pair found is a hole to close with a new or tighter AD.

Dispatch each lens as a parallel subagent against `docs/plan/architecture.md`. Each writes its full review to `docs/plan/reviews/architecture-{lens}.md` and returns only a verdict, its top 2-5 findings and the file path. An inline self-check does not count: the fresh context is the point. **If subagents are unavailable,** run the lenses one at a time yourself; write each review file before starting the next and do not reread earlier reviews until all are written.

## Good-spine checklist

- Fixes the real divergence points for the level below and misses none.
- Every AD's Rule is enforceable and actually prevents its stated divergence.
- Nothing under Deferred could let two units diverge.
- Arc invariants the app touches are all present: decimals, fee floor, finality, reverting transfers, EOA-only Memo/Multicall3From (if used), emitter and log paging (if indexing), Arc Foundry tests (if contracts).
- Named technology is verified current.
- Brownfield: it ratifies the codebase rather than contradicting it.
- PRD-driven: it covers the PRD's capabilities.
- Inherited parent spine: no new AD weakens or contradicts an inherited one.
- Every dimension the altitude owns is decided, deferred or an open question, including deployment and environments (testnet and mainnet), key custody, RPC providers and operations.

## 3. Report

Lead with a one-sentence verdict, then critical and high findings; roll medium and low into one tail line ("plus N more in {file}"). Per finding: autofix, discuss, defer, or ignore. At Finalize, apply the clear fixes yourself and surface only what needs the user.

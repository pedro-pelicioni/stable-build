<!-- Adapted from BMad Method v6.12.1 src/bmm-skills/plan/bmad-prd/{SKILL.md,customize.toml,assets/prd-validation-checklist.md} (https://github.com/bmad-code-org/BMAD-METHOD, commit 790dae9c). Copyright (c) 2025 BMad Code, LLC. MIT; see THIRD_PARTY_NOTICES.md. Modified by stable-build contributors. -->

# PRD workflow

You facilitate and coach the user to create, update or validate a PRD scoped to the rigor they need. Fight the urge to do the thinking for them unless they choose the Fast path.

Outputs live in the user's project: `docs/plan/prd.md`, `docs/plan/prd-addendum.md` (depth that belongs downstream: rejected options, technical how, sizing data), and one-line entries in `docs/plan/decisions.md`. The template is `assets/prd-template.md` in the pm skill folder.

## Intent

- **Create** (no PRD yet). If `docs/plan/prd.md` exists with `status: draft`, offer to resume. Otherwise write `prd.md` with frontmatter (`title`, `status: draft`, `created`, `updated`), tell the user the path, then run Discovery and Finalize.
- **Update** (a change signal against an existing PRD). Read the PRD, addendum, decisions log and original inputs first. Surface conflicts with earlier decisions before applying. Then Finalize.
- **Validate** (critique only). Run the reviewer gate below and change nothing.

Misroutes: a one-pager → `product-brief`; no idea yet → `find-idea`; architecture → `architect`.

## Decisions log

Append one line per decision, change, assumption or open question as the conversation goes: `- YYYY-MM-DD [prd] decision: <gist and reason>`. Never edit earlier lines. Whatever isn't logged is lost on resume. Capture downstream depth into the addendum during the conversation, not at the end.

## Discovery

Order: brain dump → stakes → working mode → work. Reach working mode in two or three turns.

- **Brain dump.** Always first. Ask for their verbal picture and any inputs to read (brief, research, transcripts, prior drafts). A plain "anything else?" surfaces what they almost forgot. Big documents go to subagents; you keep the extracts.
- **Research.** Spawn web-research subagents for the landscape and comparables; for Arc capabilities use the arc-docs MCP. Only build on what docs.arc.io documents as live.
- **Elicit, don't direct.** Pull their vision out. When you notice yourself naming wedges, MVP cuts or phases, hand the pen back. "I'm assuming X works like Y, right?" is fine; a quiz of options is not.
- **Stakes.** One probe: hobby, hackathon or grant, internal, or public launch with real funds. It sets rigor and length.
- **Working mode.** Fast path: batch remaining gaps into one or two questions, then draft with `[ASSUMPTION]` tags. Coaching path: walk the sections together; the user picks **Vision + Features** or **Journey-led** as the entry point.
- **Concern scan.** Name the concerns this product carries (compliance, custody, integrations, monetization, data governance…). They decide which Adapt-In clusters to pull in. Any product that moves value onchain pulls in the **Onchain** cluster.
- **Form factor.** Web, mobile, CLI, API, agent: probe if not stated.
- **User journeys are captured, not authored.** When journeys matter, ask the user to narrate a real session with a named person, then structure it into UJ-n and confirm.

## PRD discipline

- Features grouped; FRs nested with global stable ids (FR-1…). Cross-cutting NFRs in their own section. Capabilities, not implementation: technical choices go to the addendum.
- The template's Essential Spine is the default; drop a section only for a reason a reviewer would accept. Pull in Adapt-In clusters the concerns need; invent a section when a concern has none.
- Every onchain FR states its testnet proof: which transaction or log on Arc Testnet (chain 5042002) shows it works.
- Length scales with stakes: about two pages for a hobby or hackathon PRD; longer only when FRs require it. Overflow goes to the addendum, never padding.

## Reviewer gate

Used by Validate and at Finalize. Stakes-calibrated: a hobby PRD may run it quietly; a launch PRD runs every lens. Lenses, each as a parallel subagent against `prd.md` (and the addendum) that writes `docs/plan/reviews/prd-{lens}.md` and returns only a verdict, top findings and the path:

1. **Rubric.** Seven dimensions, each rated strong, adequate, thin or broken: decision-readiness (could UX, architecture and stories start without guessing?), substance over theater, strategic coherence, done-ness clarity (FRs testable with consequences), scope honesty, downstream usability (glossary terms used exactly, stable ids, journeys and metrics cross-referenced), and shape fit. Mechanical notes go last.
2. **Onchain.** Network plan, assets and decimals, wallet model and what it rules out, blocklist behavior, fee payer and fee display, public-data warning, testnet proof per onchain FR. Every Arc claim has a docs.arc.io URL.
3. Ad-hoc lenses the content warrants (security for custody, accessibility for consumer flows).

If subagents are unavailable, run the lenses one at a time; write each file before starting the next. Lead with a one-sentence verdict, then critical and high findings; roll the rest into one tail line. Per finding: fix, discuss, defer, or ignore.

## Finalize

1. **Log audit.** Walk the decisions log with the user: each entry is in the PRD, in the addendum, or set aside.
2. **Input reconciliation.** One subagent per user input checks it against the PRD and returns gaps, especially qualitative ones (tone, feel) that FRs silently drop.
3. **Reviewer pass.** Run the gate; resolve before polish.
4. **Open items.** Open questions, `[ASSUMPTION]` tags and notes: blockers resolved one at a time; the rest deferred with an owner and revisit condition in the log.
5. **Polish.** Structure first, then prose. Plain words, no hype, no yield or returns language.
6. **Close.** Set `status: final` and `updated`; log `event: PRD finalized`; share paths. Common next: `ux-designer`, `architect`, then `stories`.

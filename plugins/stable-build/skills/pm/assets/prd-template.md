<!-- Adapted from BMad Method v6.12.1 src/bmm-skills/plan/bmad-prd/assets/prd-template.md (https://github.com/bmad-code-org/BMAD-METHOD, commit 790dae9c). Copyright (c) 2025 BMad Code, LLC. MIT; see THIRD_PARTY_NOTICES.md. Modified by stable-build contributors. -->

# PRD template

Expert prior knowledge, not a checklist. The Essential Spine is the default; the Adapt-In Menu is pulled in by the product's concerns.

## Essential Spine

````markdown
---
title: {Product name}
status: draft
created: {YYYY-MM-DD}
updated: {YYYY-MM-DD}
---

# PRD: {Product name}

## 0. Document purpose
[One paragraph: who reads this, how it is structured (glossary-anchored terms, features with nested FRs, assumptions tagged inline), and which inputs it builds on (brief, research, UX) and where they live.]

## 1. Vision
[2-3 paragraphs: what this is, what it does for the user, why it matters.]

## 2. Target user
### 2.1 Jobs to be done
[Bulleted: functional, emotional, social, contextual, whichever apply.]
### 2.2 Non-users (v1) *(when the boundary is not obvious)*
### 2.3 Key user journeys
*Numbered UJ-1…UJ-n. FRs cite them ("realizes UJ-2").*
- **UJ-1. {Named person doing the thing.}** Persona and context in one line; entry state; 3-5 concrete beats; the climax (the moment value lands and how they know); resolution; optional edge case.

  > **UJ-1. Ana pays her 12 contractors before Friday's cutoff.** Ana runs a small design studio with contractors in four countries. She uploads Friday's CSV, sees 12 rows and the USDC total, and confirms in her browser wallet. Seconds later the table shows every row final with a link to the explorer. **Edge case:** one recipient is blocklisted; the review screen marks that row rejected before anything is sent, and she pays the rest.

  Lighter for hobby or CLI work (one sentence); heavier (numbered flow, edge-case list, FR mapping) when auth, money movement or multiple surfaces are involved.

## 3. Glossary
*Every domain noun, defined once. FRs, UJs and SMs use these terms exactly; no synonyms.*
- **Term**: definition, relationships, cardinality.

## 4. Features
### 4.1 {Feature}
**Description:** [Behavior first: how it works, who uses it, edge cases. Realizes UJ-x. Inline `[ASSUMPTION: …]` where inferred.]

#### FR-1: {Short capability name}
[Actor] can [capability] [under conditions]. Realizes UJ-x.

**Consequences (testable):**
- {Specific, testable condition.}

**Testnet proof** *(onchain FRs only)*: {the transaction or log on Arc Testnet (5042002) that shows this works.}

**Out of scope** *(optional)*: {bound}

**Feature NFRs / notes** *(optional)*

## 5. Non-goals
[What this product is not and will not do in v1.]

## 6. MVP scope
### 6.1 In scope
### 6.2 Out of scope for MVP
[Each with a one-line reason when it matters; mark v2+ items.]

## 7. Success metrics
- **SM-1** (primary): definition, target. Validates FR-x.
- **SM-C1** (counter-metric, do not optimize): why. Counterbalances SM-1.
[A hackathon PRD may need one sentence. A launch needs measurement methods.]

## 8. Open questions
[Numbered; each with an owner.]

## 9. Assumptions index
[Every `[ASSUMPTION]` in the document, for explicit confirmation.]
````

## Adapt-In Menu

### Onchain (apps built on Arc) *(any product that moves or reads value onchain)*

Each item cites its docs.arc.io source; confirm through the arc-docs MCP before finalizing.

- **Network plan.** Arc Testnet (`5042002`) first; what must be true before mainnet (`5042`); who holds the mainnet key (a human, never CI). https://docs.arc.io/arc/references/rpc-endpoints
- **Assets and units.** USDC is the gas token and has one balance with two views: 18 decimals native, 6 decimals ERC-20. State which unit the product stores and shows (one balance row). Other assets (for example EURC) listed with their decimals. https://docs.arc.io/arc/references/evm-differences
- **Wallet model.** EOA or smart account (ERC-4337, Safe, SCA-configured wallets), and what that rules out: `Memo` and `Multicall3From` need a direct EOA caller. https://docs.arc.io/arc/concepts/transaction-memos · https://docs.arc.io/arc/concepts/batched-transactions
- **Compliance.** The USDC blocklist is enforced at runtime; a blocked transfer reverts and still costs gas. Product behavior when a sender or recipient is blocked; offchain screening must include the Memo and Multicall3From addresses. https://docs.arc.io/arc/references/evm-differences · https://docs.arc.io/arc/references/contract-addresses
- **Fees.** Paid in USDC; who pays (user, app, relayer); shown as a USDC amount, never gwei; `maxFeePerGas` at least 20 gwei or the transaction is dropped silently. https://docs.arc.io/integrate/wallets/fee-display
- **Finality and states.** One confirmation is final; product states for pending, final, reverted, dropped and rejected. https://docs.arc.io/integrate/wallets/transaction-lifecycle
- **Public data.** Amounts, addresses and memo bytes are public forever. No names, emails or notes onchain.
- **Evidence.** Each onchain FR names its testnet proof; the go-live checklist (`go-live` skill) gates mainnet.

### Cross-cutting quality *(most non-trivial PRDs)*
- **Cross-cutting NFRs**: performance, security, reliability, observability.
- **Constraints and guardrails**: safety, privacy, cost.
- **Why now**: when timing is load-bearing.

### Consumer products
- **Aesthetic and tone**, **Information architecture**, **Monetization** (fees and pricing, described plainly), **Platform**.

### Business and enterprise
- **Stakeholders and approvals**, **Risks and mitigations**, **Operational requirements** (SLAs, support, on-call), **Integrations** (SSO, ERPs, banking or ramp partners), **Rollout**, **Data governance**, **Audit trail**.

### Regulated domains
- **Compliance and regulatory**: whichever regimes apply. Flag anything needing legal review as an open question; do not assert compliance.

### Developer products (libraries, APIs, CLIs, SDKs)
- **API contracts**, **Versioning and deprecation**, **Performance budgets**, **Runtime targets and dependency policy**.

### Small scope, all-inclusive *(one or two stories' worth)*
- **Stories** inline at the end: "As a [persona], I can [action] [under conditions]. Acceptance: [testable criteria]." Pair with very lean sections 1-6.

<!-- Adapted from BMad Method v6.12.1 src/bmm-skills/v6-shims/bmad-create-story/template.md (https://github.com/bmad-code-org/BMAD-METHOD, commit 790dae9c). Copyright (c) 2025 BMad Code, LLC. MIT; see THIRD_PARTY_NOTICES.md. Modified by stable-build contributors. -->

# Story file template

Copy the block below to `docs/stories/{epic}.{story}-{slug}.md`. The `dev` skill may edit only: frontmatter `baseline_commit`, task checkboxes, Dev Record, Testnet Evidence, File List, Change Log and Status.

```markdown
---
baseline_commit: ''
---

# Story {epic}.{story}: {title}

Status: ready-for-dev

## Story

As a {user},
I want {capability},
so that {benefit}.

## Acceptance criteria

1. **Given** … **When** … **Then** …
2. …
N. **Testnet evidence:** {criterion, or "n/a (no onchain effect)"}

## Tasks

- [ ] Task 1 (AC: 1)
  - [ ] Subtask 1.1
- [ ] Task 2 (AC: 2)

## Dev notes

- Spine decisions to honor: {AD-n, AD-m}
- Files and modules likely touched: {paths}
- Tests: {e.g. `FOUNDRY_PROFILE=arc arc-forge test`, `npm test`}
- Sources: {docs.arc.io URLs behind the Arc criteria; docs/plan sections}

## Dev record

### Implementation plan
### Debug log
### Completion notes

## Testnet evidence

| AC | Network | Tx hash | Block | Receipt status | What it proves |
| --- | --- | --- | --- | --- | --- |

## File list

## Change log
```

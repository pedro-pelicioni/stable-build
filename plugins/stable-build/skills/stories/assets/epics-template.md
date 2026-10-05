<!-- Adapted from BMad Method v6.12.1 src/bmm-skills/plan/bmad-create-epics-and-stories/templates/epics-template.md (https://github.com/bmad-code-org/BMAD-METHOD, commit 790dae9c). Copyright (c) 2025 BMad Code, LLC. MIT; see THIRD_PARTY_NOTICES.md. Modified by stable-build contributors. -->

# Epics template

Copy the block below to `docs/plan/epics.md`.

```markdown
---
status: draft
phasesDone: []
inputDocuments: []
---

# {project name}: epic breakdown

## Overview

Epics and stories for {project name}, decomposed from the PRD, the UX documents (if any) and the architecture spine.

## Requirements inventory

### Functional requirements
{FR list, PRD ids kept}

### Non-functional requirements
{NFR list}

### Architecture requirements
{starter, environments, integrations, monitoring; ADs stories must honor}

### UX design requirements
{UX-DR1…}

### FR coverage map
{FR-n: Epic m - short description}

## Epic list
{Epic n: title, user outcome, FRs covered}

<!-- Repeat per epic -->
## Epic {N}: {title}

{epic goal}

<!-- Repeat per story -->
### Story {N}.{M}: {title}

As a {user},
I want {capability},
so that {benefit}.

**Acceptance criteria:**

**Given** {precondition}
**When** {action}
**Then** {expected outcome}
**And** {additional criteria}

**Testnet evidence:** {criterion from the Arc library, or "n/a (no onchain effect)"}
```

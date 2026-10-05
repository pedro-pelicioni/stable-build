<!-- Adapted from BMad Method v6.10.0 src/bmm-skills/1-analysis/bmad-agent-tech-writer/write-document.md (https://github.com/bmad-code-org/BMAD-METHOD, commit 081e64ee). Copyright (c) 2025 BMad Code, LLC. MIT; see THIRD_PARTY_NOTICES.md. Modified by stable-build contributors. -->

# Write a document

Hold a multi-turn conversation until you fully understand the ask. Use subagents, when available, for web research or document review, returning only the relevant extracts.

1. **Intent.** Ask until scope, audience, purpose and location are clear (default: under `docs/`).
2. **Research.** Review the references the user gives; confirm every Arc fact through the arc-docs MCP and note its docs.arc.io URL.
3. **Draft.** Clear structure, task-oriented, diagrams where they help, the Arc writing rules from SKILL.md applied.
4. **Review.** A subagent (or a separate pass) checks content quality and the rules in `references/validate-doc.md`; fix what it finds.

**Output:** a complete document, ready to use, with its sources listed.

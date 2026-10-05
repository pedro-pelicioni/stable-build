<!-- Adapted from BMad Method v6.10.0 src/bmm-skills/1-analysis/bmad-agent-tech-writer/validate-doc.md (https://github.com/bmad-code-org/BMAD-METHOD, commit 081e64ee). Copyright (c) 2025 BMad Code, LLC. MIT; see THIRD_PARTY_NOTICES.md. Modified by stable-build contributors. -->

# Validate a document

Review the named document against documentation practice and anything the user asked you to focus on.

1. **Load** the whole document.
2. **Analyze** clarity, structure, audience fit, task orientation, and the Arc writing rules:
   - Arc named only descriptively; no "official", "partner" or endorsement claims; no Arc in proposed names.
   - No yield, APR, APY, ROI or returns language.
   - Every Arc fact has a docs.arc.io link; volatile numbers (fee floor, limits, addresses) have an "as of" date. Spot-check them through the arc-docs MCP.
   - Decimals stated correctly (native USDC 18, ERC-20 USDC 6) and no "confirmations" language for Arc.
   - Public-data warning where memos or payouts are described.
3. **Report** specific, actionable suggestions ordered by priority, each with the line it concerns.

**Output:** a prioritized list of fixes. Change nothing unless asked.

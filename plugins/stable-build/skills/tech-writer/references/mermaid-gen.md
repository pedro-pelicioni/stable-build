<!-- Adapted from BMad Method v6.10.0 src/bmm-skills/1-analysis/bmad-agent-tech-writer/mermaid-gen.md (https://github.com/bmad-code-org/BMAD-METHOD, commit 081e64ee). Copyright (c) 2025 BMad Code, LLC. MIT; see THIRD_PARTY_NOTICES.md. Modified by stable-build contributors. -->

# Mermaid diagram

Create a Mermaid diagram through conversation until the details are understood.

1. **Understand** what must be visualized and for whom.
2. **Suggest a type** if none is given: flowchart, sequence, class, state, ER, and so on.
3. **Generate** strictly valid Mermaid syntax in a CommonMark fenced block.
4. **Iterate** on feedback.

Arc accuracy: a transaction lifecycle has pending and final states (plus rejected, dropped and reverted outcomes), never a chain of confirmations (https://docs.arc.io/integrate/wallets/transaction-lifecycle). Memo and Multicall3From calls start from an EOA (https://docs.arc.io/arc/concepts/transaction-memos).

**Output:** a Mermaid diagram in a fenced code block, ready to render.

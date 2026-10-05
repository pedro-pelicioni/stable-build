---
name: layered-review
description: Adversarial code review of an app built on Arc in independent layers - blind, edge-case, verification-gap, acceptance, and an Arc gotcha hunter that runs the stable-build scan - followed by verified triage written to the story file. Use in a project built on Arc (.stable-build/project.json or Arc chain ids, RPCs or addresses in the code) when the user asks for a stable-build or Arc review, says "run a layered review", or a stable-build story is ready for review.
---
<!-- Adapted from BMad Method v6.12.1 src/bmm-skills/ship/bmad-code-review/{SKILL.md,customize.toml,steps/step-01-gather-context.md,steps/step-02-review.md} (https://github.com/bmad-code-org/BMAD-METHOD, commit 790dae9c). Copyright (c) 2025 BMad Code, LLC. MIT; see THIRD_PARTY_NOTICES.md. Modified by stable-build contributors. -->

# Layered review

**Goal:** review code changes adversarially. No noise, no filler.

- **Skill folder:** `${CLAUDE_SKILL_DIR}`. **Plugin root:** `${CLAUDE_PLUGIN_ROOT}`. If either still reads as a literal variable (hosts other than Claude Code), the skill folder is the folder holding this file and the plugin root is two levels above it. Resolve both to absolute paths before launching any layer.
- `docs/` paths are in the user's project. `review-prompts/` and `references/` are in this skill's folder.
- Subagents are central here. If the host needs explicit permission to run them, ask once for the whole review.
- **Arc check.** This skill is for apps built on Arc. If the project shows no Arc marker (`.stable-build/project.json`, chain id 5042 or 5042002, an `rpc.*.arc.io` URL, `arc`/`arcTestnet` from `viem/chains`, USDC `0x3600…0000`) and the user did not name stable-build or Arc, say so in one line and offer to hand off to their general tools; continue only if they confirm.

## Step 1: Gather context

The prompt that triggered this review is the intent. Writing the diff file and the claims file is the only change this step makes.

1. **Find the target**, stopping at the first that applies:
   1. **Explicit argument:** a PR (resolve with `gh pr view`), commit, branch, story file, or a diff mode ("staged", "uncommitted", "vs main", "last N commits", "this diff"). A story file sets `spec_file`; its frontmatter `baseline_commit` is the diff base when present.
   2. **Recent conversation:** a story path, commit, branch or PR just discussed.
   3. **Stories in review:** files in `docs/stories/` with `Status: review`. One: offer it or another target. Several: list them and ask.
   4. **Git state:** on a branch other than the default, offer "review this branch against main?".
   5. **Ask:** uncommitted changes, staged only, branch diff (which base?), commit range, or a provided diff or file list.
2. **Write the diff** to a uniquely named file in the system temp directory (`git diff --cached`, `git diff HEAD`, `git diff <base>...HEAD`, `git diff <range>`, or the validated pasted diff; for a file list add untracked files with `git diff --no-index /dev/null <path>`). Empty diff: say there is nothing to review and stop. Never paste diff text into a layer's prompt; layers read the file.
3. **Stage the claims file:** the change's own narrative (commit messages for a branch or range, or the description the user gave), verbatim, in another temp file. None: leave it empty.
4. **Spec context:** the user said "no spec": `review_mode = no-spec`. A story or spec path is known: `review_mode = full`. Otherwise ask for a story path or continue without one.
5. Over about 3,000 diff lines: offer to split by file group.

**Checkpoint:** show files changed, lines added and removed, review mode and the story file. Wait for the go-ahead.

## Step 2: Review layers

| Layer | Runs when | Instructions |
| --- | --- | --- |
| Blind hunter | always | `review-prompts/blind-hunter.md` |
| Edge-case hunter | always | `review-prompts/edge-case-hunter.md` (gets the claims file) |
| Verification-gap reviewer | always | `review-prompts/verification-gap.md` |
| Acceptance auditor | `review_mode = full` (otherwise say it was skipped: no story given) | `review-prompts/acceptance-auditor.md` (gets the story file) |
| Gotcha hunter | always in an Arc project; outside one, only when the user confirmed the review after the Arc check | `review-prompts/gotcha-hunter.md` (gets the plugin root and the project root) |

**Parallel (default).** Launch every active layer at once as a context-free subagent at the same model capability as this session, awaiting all of them in this turn. Each launch prompt: "Read `<skill folder>/review-prompts/<layer>.md` completely and follow it. Review content: the unified diff at `<absolute diff path>`." plus the layer's extra inputs, and "Do not invoke skills or spawn subagents. Return your findings as text in your final message." Do not read the layer instruction files yourself.

**Sequential fallback (no subagents).** Run the layers one at a time yourself, gotcha hunter first because it is mechanical. Before each layer, set aside what earlier layers found; write each layer's findings to `docs/stories/reviews/{date}-{layer}.md` before starting the next, and do not reread them until triage. The blind hunter must look only at the diff. Tell the user the review ran without independent contexts, which makes it weaker; offer the export option for the most important layers.

**Export option.** Write each layer's prompt, with the diff text inlined so it is self-contained, to `docs/stories/reviews/`, and ask the user to run them in separate sessions (ideally a different model) and paste the findings back.

A layer that fails, times out or returns nothing goes on the `failed_layers` list; continue with the rest. Keep each finding's source layer.

## Steps 3 and 4: Triage, present and act

Read `references/triage.md` and follow it.

## Language

Before your first reply in a session, read the saved language once: `cat "${STABLE_BUILD_HOME:-$HOME/.stable-build}/config.json" 2>/dev/null`. If it sets `"language"`, write everything the user reads in that language (`pt-BR` is Brazilian Portuguese, `en` is English): replies, questions, menus, tables and the documents you generate, such as reports, briefs, PRDs, stories and idea lists. With no saved language, use the user's language. Wherever this skill says "the user's language", it means this choice. Keep code, identifiers, file names, paths, frontmatter keys and status values, rule ids, commands, CLI flags, commit messages and verbatim docs quotes in English.

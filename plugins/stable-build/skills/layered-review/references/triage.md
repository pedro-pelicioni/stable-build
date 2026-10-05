<!-- Adapted from BMad Method v6.12.1 src/bmm-skills/ship/bmad-code-review/{steps/step-03-triage.md,steps/step-04-present.md} (https://github.com/bmad-code-org/BMAD-METHOD, commit 790dae9c). Copyright (c) 2025 BMad Code, LLC. MIT; see THIRD_PARTY_NOTICES.md. Modified by stable-build contributors. -->

# Triage, present and act

## Step 3: Triage

1. **Normalize** every finding: `id`, `source` (layer), `title`, `detail`, `location` (file:line when known).
2. **Verdict per finding**, only after all layers have reported, before any grouping. Ignore severities the layers assigned.
   - Verification-gap findings arrive pre-verified: render the verdict from their filed evidence. Their "Other findings" are verified like the rest.
   - Gotcha-hunter findings that come from the scan are pre-verified as to the pattern; still check the cited line really is in an Arc value path (a test fixture or a comment is `false`).
   - Everything else: **verify the claim** at the cited place. Follow callers and upstream guards until you can say whether the bad outcome happens. Code that loudly fails on a situation the program cannot reach is correct, not a defect.
   - Exactly one verdict: `high` (intolerable), `medium` (tolerable), `low` (cosmetic): the harm is real; grade by how much it hurts users or developers, and name the harm. Money moved wrongly, funds stuck, or a silently dropped transaction is `high`. `false`: you checked and it does not happen; write what disproves it. `maybe-false`: you could not tell; write what would settle it.
   - Reject `false` findings. Reject `low` findings users or developers would rarely meet when the fix adds complexity. Reject findings whose fix is to edit the story under review.
3. **Group** survivors only when one defect produced them. The group takes the highest verdict and joins the sources with `+`.
4. **Route** each entry to one bucket:
   - **decision_needed**: the right fix depends on the user's intent (only with a story; in no-spec mode route to patch or defer).
   - **patch**: the fix is unambiguous and adds no public surface.
   - **defer**: pre-existing and not caused by this change; or all `maybe-false` with a would-be `medium`/`high` (record it as unverified with what would settle it); or the fix edits agent-context files (AGENTS.md, CLAUDE.md, other stories).
5. If `failed_layers` is not empty, say which layers failed before the results. Zero findings with failed layers: warn the review may be incomplete. Zero findings and no failures: "Clean review: all layers passed."

## Step 4: Present and act

1. **Write to the story** (when there is one): append `### Review Findings` under Tasks:
   - `- [ ] [Review][Decision] <title>: <detail>`
   - `- [ ] [Review][Patch] <title> [<file>:<line>]`
   - `- [x] [Review][Defer] <title> [<file>:<line>]: deferred, <reason>`
   Append each defer to `docs/stories/deferred-work.md` under `## Deferred from: review of {story} ({date})`. End with a **Rejected** appendix, one line each with the refutation.
2. **Summary:** "Review complete: D decision-needed, P patch, W defer, R rejected." Say where findings were written, or that nothing was persisted without a story.
3. **Decisions first.** Present each decision-needed finding with its options; the user decides; each becomes patch, defer or rejected. Wait for each answer.
4. **Patches.** Ask: (1) apply every patch now, (2) leave them as action items in the story (only with a story), or (3) walk through each. Wait for the choice. After applying, summarize the changes and check the items off in the story.
5. **Story status** (with a story): set `Status: done` only when no decision-needed or patch item is open, no unresolved `high`/`medium` remains, the tests pass, and the Testnet Evidence table has a verified tx hash for every onchain criterion (or `n/a` with a reason the reviewer accepts). Otherwise set `in-progress` and say what blocks done.
6. **Next:** start the next story (`dev` skill), re-run this review after fixes, or stop. When every story is done: the `go-live` skill.

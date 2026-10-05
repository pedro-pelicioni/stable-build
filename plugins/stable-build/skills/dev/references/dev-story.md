<!-- Adapted from BMad Method v6.12.1 src/bmm-skills/v6-shims/bmad-dev-story/{SKILL.md,checklist.md} (https://github.com/bmad-code-org/BMAD-METHOD, commit 790dae9c). Copyright (c) 2025 BMad Code, LLC. MIT; see THIRD_PARTY_NOTICES.md. Modified by stable-build contributors. -->

# Dev story

Implement one story file from `docs/stories/` until every task is checked and every acceptance criterion is met.

- Edit the story file only in: frontmatter `baseline_commit`, task checkboxes, Dev Record, Testnet Evidence, File List, Change Log, Status.
- Do the steps in order. Do not stop for "milestones" or "session boundaries"; continue until the story is complete or a HALT condition applies.

## 1. Find the story

- A path was given: use it.
- Otherwise read `docs/stories/*.md` and take the first story, by epic then story number, whose `Status:` is `in-progress`, else the first `ready-for-dev`.
- None: say so and offer the `stories` skill (phase 5, "prepare the next story"). HALT.
- Ambiguous tasks or missing story file: ask, or HALT.

## 2. Load context

Read the whole story: criteria, tasks, Dev Notes (spine ADs, files, test commands, sources). Read the cited ADs in `docs/plan/architecture.md` and the project's `AGENTS.md`.

## 3. Review continuation

If the story has a `### Review Findings` section with unchecked items, do those first (they come from `layered-review`). Check each off when fixed and note it in Completion Notes.

## 4. Start

If `baseline_commit` is empty, set it to `git rev-parse HEAD` (or `NO_VCS`). Set `Status: in-progress`.

## 5. Red, green, refactor (per task, in order)

1. **Red.** Write the failing test for the task first and run it; confirm it fails for the expected reason.
   - Contracts: `FOUNDRY_PROFILE=arc arc-forge test` with `[profile.arc] network = "arc"` in `foundry.toml`. Local chain: `arc-anvil --network arc`. Against live testnet state: `--fork-url https://rpc.testnet.arc.io`. Source: https://github.com/circlefin/arc-foundry
   - App code: the project's own runner (for example `npm test`). For chain reads, test against recorded receipts and logs as fixtures.
   - `arc-forge` missing: stop and point to https://docs.arc.io/arc/tutorials/install-arc-foundry. Never fall back to upstream `forge`/`anvil`: they run Ethereum rules and report passing (https://docs.arc.io/arc/references/evm-differences).
2. **Green.** Write the minimal code that passes. Handle the errors and edge cases the task names.
3. **Refactor** with tests green, following the spine and Dev Notes.
4. Note the approach in Dev Record → Implementation plan.

Never implement anything not mapped to a task. Never start the next task until this one's tests pass.

**HALT** when: a new dependency is needed beyond the story (ask first); three implementation attempts in a row fail; required config is missing; a step would need a private key, a funded account, or mainnet.

## 6. Tests

Unit tests for new logic; integration tests where the story's criteria involve components talking to each other; end-to-end tests when the criteria demand them. Cover the Arc criteria in the story (decimals, fee floor, reverted and dropped states, log paging, emitter dedupe).

## 7. Validate

Run the full test suite (no regressions), the project's linters, and the Arc scan from the project root: `node "<plugin root>/scripts/guard.mjs" --scan .`, with the plugin root given in the dev skill's SKILL.md. The scan must report no errors in files this story touched. Stop and fix on any failure.

## 8. Mark the task

Check a task only when its tests exist and pass, the code does exactly what the task says (nothing extra), and its criteria are met. Update File List (every new, changed or deleted file, repo-relative) and Completion Notes. Then the next task (step 5), or step 9 when none remain.

## 9. Testnet evidence

For each criterion that needs testnet evidence:

1. Give the user the exact command or UI steps that exercise it on Arc Testnet (chain id 5042002) with **their own** testnet key or browser wallet (testnet USDC: https://faucet.circle.com). Do not run anything that signs; do not ask for the key.
2. When the user pastes the tx hash, verify read-only: `eth_chainId` on https://rpc.testnet.arc.io returns `0x4cef52`, and `eth_getTransactionReceipt` returns `status` `0x1`. Where the criterion names events (Memo, Transfer), check them in the receipt logs.
3. Record a row in Testnet Evidence: criterion, network, hash, block, status, explorer link `https://explorer.testnet.arc.io/tx/{hash}`, what it proves.

A story with no onchain effect records `n/a (no onchain effect)` and why. Sources: https://docs.arc.io/arc/references/rpc-endpoints

## 10. Complete

Definition of done, all required:

- Every task and subtask checked; every criterion met.
- Unit, integration and end-to-end tests as the criteria require; full suite and linters pass; Arc scan shows no errors in touched files.
- Testnet Evidence filled for every onchain criterion (or n/a with a reason).
- File List complete; Dev Record and Change Log updated; only permitted story sections edited.

If any item fails, HALT and fix it. Otherwise set `Status: review` and tell the user: story id and title, key changes, tests added, files changed, evidence recorded, and the story path. Offer explanations of what was built. Next: the `layered-review` skill (ideally with a different model than the one that wrote the code); when every story is done, the `go-live` skill.

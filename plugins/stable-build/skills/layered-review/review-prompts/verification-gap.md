<!-- Adapted from BMad Method v6.12.1 src/bmm-skills/ship/bmad-code-review/review-prompts/verification-gap.md (https://github.com/bmad-code-org/BMAD-METHOD, commit 790dae9c). Copyright (c) 2025 BMad Code, LLC. MIT; see THIRD_PARTY_NOTICES.md. Modified by stable-build contributors. -->

# Verification-gap review

**Goal:** find changed behavior that could break without verification catching it. One question: "if the behavior this change is supposed to produce broke where it is actually used, would a test fail?" Do not hunt for correctness bugs, but report real problems you notice on the way.

Gap shapes:

1. **Regression gap:** the changed code regresses where it is used, and no test covering that use would fail.
2. **Missing-adoption gap:** a place that should now use the new behavior handles the same case its own way, or not at all, and no test would flag it.
3. **Broken-verification gap:** a test seems to cover the behavior but would not protect it: skipped, flaky, not run in the normal path, or too weak to observe the regression.

**Arc-specific broken verification:** contract tests that run under upstream `forge`/`anvil` or the `foundry-rs/foundry-toolchain` CI action run Ethereum rules and report passing, so they do not verify Arc behavior (fee floor, native-value reverts, EIP-7708 logs, blocklist). Only `FOUNDRY_PROFILE=arc arc-forge test`, `arc-anvil --network arc`, or a fork of a real Arc network counts. Sources: https://docs.arc.io/arc/references/evm-differences, https://github.com/circlefin/arc-foundry

## Evidence rules

- Read a test before claiming what it covers, runs, asserts or misses.
- Before claiming no test exists, search the whole repo by the symbol under test and by import references.
- Never assert what you did not verify; drop a finding you cannot ground. Say what you checked and how far you looked.
- No severity, confidence, priority or ranking.

## Sequence

1. **Screen** each part of the change. Skip parts that change no return value, thrown error, caller-visible side effect or observable state (formatting, comments, pure renames, type-only changes), and static text or LLM output.
2. **Name the behavior that changed:** output, side effect, branch, error path, event or schema shape, config default, validation rule, external contract. Dependency, toolchain, build, CI and data-file changes count as behavioral.
3. **Trace where it is used:** callers, entry points (routes, commands, scripts), contract consumers (schemas, events, indexers). Follow a path only while the behavior is reachable and unverified; stop at a boundary where a test would fail, where the consumer does not observe it, or where the next hop is guesswork. Usually one to three hops.
4. **Qualify the consumer, then read its test.** Name the smallest realistic regression the consumer would observe (invert the branch, drop the default, use 6 decimals where 18 are expected, omit the fee floor, skip the receipt status check). That is the Demonstration; if none exists, drop the path. A missing-adoption gap needs a supersession signal (the change clearly replaces the local behavior) and a shared observable contract. A test counts only if it runs normally and an assertion observes the changed result; source-text assertions, no-throw or snapshot-only checks, mock-only checks, and tests that mock away the integration do not count.
5. **Confirm** each finding: reopen the tests or searches it relies on; drop what you cannot ground. Explain why the test misses the bug from what it sets up and checks.

Do not report: compiler-enforced cases; behavior already verified by an integration or end-to-end test; low coverage by itself; untouched legacy code.

## Output

One block per gap:

```markdown
### <one-line title naming the gap>

- **Changed surface:** the behavior or contract that changed, `file:line`.
- **Impacted consumer:** named concretely, `file:line`.
- **Existing test evidence:** what the relevant test asserts (`file:line`), or the searches run and their result.
- **Missing verification:** the precise assertion or check that is absent.
- **Demonstration:** the regression that would ship undetected, and why the tests you read would not fail.
- **Consequence:** what ships wrong.
- **Disposition:** `patch` (name the test to add, in the repo's own style) or `defer` (one sentence why).
```

Then, if any, `## Other findings` with plain descriptions of real non-gap problems you met while tracing.

With no gaps and no other findings, output exactly: `No verification gaps found.`

Do not invoke skills or spawn subagents. Return your output as text in your final message.

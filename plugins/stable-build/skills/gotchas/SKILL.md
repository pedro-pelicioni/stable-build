---
name: gotchas
description: "Arc pitfalls checker for apps built on Arc: explains guard findings, scans a repo, enables or disables the edit-time guard. Use when a stable-build guard message appears or the user asks about Arc gotchas."
---

# Arc gotchas and the edit-time guard

stable-build ships a small local checker for mistakes that are specific to apps built on Arc: USDC is the native gas token with two decimal views of one balance, there is a fee floor, public RPCs cap log ranges, and the Memo and Multicall3From system contracts accept only EOA callers. Each rule has a stable id, a fix, and a docs quote with the date it was checked.

Files, relative to this skill's folder:

- Guard script: `../../scripts/guard.mjs`
- Rule catalog: `../../data/gotchas.json`

Commands run from the user's project, so first resolve the script to an absolute path and use it below as `$GUARD`. In Claude Code that path is `${CLAUDE_SKILL_DIR}/../../scripts/guard.mjs`; in Codex, take the folder that holds this SKILL.md and append `../../scripts/guard.mjs`. Quote the path, since it can contain spaces.

## What the guard does

- After each Write/Edit (Claude Code) or apply_patch (Codex) inside an Arc project, it checks only the lines just added.
- It is advisory. The edit is already applied; the guard never blocks, undoes or rewrites it, and never reports as a hook error (it always exits 0). Every finding, error or warn, arrives the same way: a one-line notice for the user ("stable-build guard: 1 Arc gotcha in src/history.ts (transfer-filter-no-emitter) — advisory, edit kept"; with `pt-BR` saved: "stable-build guard: 1 pegadinha da Arc em src/history.ts (transfer-filter-no-emitter) — aviso, edição mantida") and the details for you as added context (`[error]` or `[warn]`, rule id, file:line, fix, docs URL and the dated docs quote behind the rule), at most 5 findings per edit. The quote is verbatim from that page, so you can weigh the fix without fetching it.
- It is local and read-only: no network calls, no file writes, no telemetry.
- It runs only after the user turned it on (`"guard": true` in `${STABLE_BUILD_HOME:-~/.stable-build}/config.json`). In Codex the user must also trust the stable-build hooks in `/hooks`.
- An Arc project has `.stable-build/project.json`, or a marker such as chain id 5042002, `arcTestnet` from `viem/chains`, an Arc RPC URL (`rpc.testnet.arc.io`, or viem's default `rpc.testnet.arc.network`), an explorer URL (`explorer.testnet.arc.io`, `testnet.arcscan.app`), or the USDC address `0x3600000000000000000000000000000000000000`.

## Rules

| id | severity | flags |
|---|---|---|
| `usdc-native-value-6dp` | error | Native tx `value` / `msg.value` built with 6 decimals (native USDC uses 18) |
| `usdc-erc20-amount-18dp` | error | USDC `transfer` / `approve` / `transferFrom` with 18-decimal amounts (ERC-20 uses 6) |
| `usdc-balance-summed` | error | `getBalance` added to `balanceOf`, or two USDC balance rows (one balance, two views) |
| `fee-below-floor` | error | `maxFeePerGas` / `gasPrice` under 20 gwei (no receipt: dropped, or rejected as `transaction underpriced`) |
| `getlogs-unpaged` | error | Log queries from a fixed block to latest, or ranges over 10,000 blocks (RPC error -32012) |
| `transfer-filter-no-emitter` | error / warn | Transfer filters without an address or on both emitters, also through a loop over both (double count); on `0x3600…` only (misses native sends); or both emitters in separate queries of one file (warn) |
| `cctp-stellar-no-forwarder` | error | CCTP burn to domain 27 (Stellar) whose mintRecipient or destinationCaller is not CctpForwarder, or is zero (funds stuck) |
| `upstream-foundry` | warn (error in CI) | `foundryup`, `forge`, `anvil`, `cast send`, foundry-toolchain; or `arc-forge test` / `arc-anvil` without `--network arc` or an Arc profile (`FOUNDRY_PROFILE=arc` + `[profile.arc] network = "arc"`) |
| `extension-from-smart-account` | error | Memo or Multicall3From used from a smart account, Safe, bundler or another contract (EOA only) |
| `multicall3from-value` | error | `aggregate3Value` or a value on `aggregate3` through Multicall3From (no value forwarding) |

## Explain a finding

1. Take the rule id from the guard context (`[error] <id> at <file>:<line>`) or from the parentheses in the user's notice.
2. Run `node "$GUARD" --explain <id>`, or read that entry in `../../data/gotchas.json`.
3. Tell the user, in plain words: what is wrong, the fix applied to their code (show it as a diff), and the docs URL with the quote. Ask before editing.
4. Arc facts change. For anything beyond the catalog, confirm with the arc-docs MCP (`search_arc_docs`) and cite the page. Never call its `submit_feedback` tool unless the user asks.
5. If the finding looks like a false positive, say so and offer the narrowest silence (an inline ignore on that line).

## Scan a repo

- Run `node "$GUARD" --scan .` (or `node "$GUARD" --scan <path> --json` for machine output).
- Scan mode runs every rule on every supported file, without the Arc-project check. It skips `node_modules`, build output, Foundry `lib/` and `.env` files, and honors `.stable-build/guard.json` and inline ignores.
- Exit codes: 0 no errors (warnings allowed), 1 at least one error, 2 usage error.
- Report findings grouped by rule id with file:line and the fix. Do not edit files until the user agrees.

## Turn the guard on or off (ask first)

- Check the current state: `node "$GUARD" --status` (read-only).
- Before enabling, tell the user what the guard does (see above), that it writes `config.json` in `${STABLE_BUILD_HOME:-~/.stable-build}`, and how to turn it off. Enable only after a clear yes: `node "$GUARD" --enable`.
- Disable after the user confirms: `node "$GUARD" --disable`.
- The change applies from the next edit. In Codex, the hooks also need trust in `/hooks`.
- Never edit Claude `settings.json`, `.claude.json`, Codex `config.toml` or any `hooks.json` to do this.

## Silence a rule

- One line: a comment containing `stable-build-ignore <id>` on that line or the line above (several ids: comma-separated).
- One project, after the user confirms: `.stable-build/guard.json` with `{"disable": ["<id>"]}`. `"*"` turns every rule off for that project; `"ignorePaths": ["test/fixtures/**"]` skips paths.
- When silencing an error, tell the user which risk remains.

## Limits

- Regex and token checks, not a compiler: they can miss real bugs and flag correct code. Treat the guard as a safety net, not an audit.
- The hook checks only the text just added (for Transfer filters, the whole call around it); use `--scan` for existing code.
- `error` and `warn` describe the risk in the code, not the hook: both arrive as advisory output, and the edit was applied either way. Say so if the user asks. Fix `error` findings before shipping.
- Items marked UNVERIFIED in the catalog `notes` (for example Memo through EIP-7702-delegated EOAs or `wallet_sendCalls`) are not documented on docs.arc.io; say so when they come up.
- Community project, not affiliated with Circle.

## Language

Before your first reply in a session, read the saved language once: `cat "${STABLE_BUILD_HOME:-$HOME/.stable-build}/config.json" 2>/dev/null`. If it sets `"language"`, write everything the user reads in that language (`pt-BR` is Brazilian Portuguese, `en` is English): replies, questions, menus, tables and the documents you generate, such as reports, briefs, PRDs, stories and idea lists. With no saved language, use the user's language. Wherever this skill says "the user's language", it means this choice. Keep code, identifiers, file names, paths, frontmatter keys and status values, rule ids, commands, CLI flags, commit messages and verbatim docs quotes in English.

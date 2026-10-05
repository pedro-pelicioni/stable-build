# Agent instructions for {{APP_NAME}}

This repo is a payouts app built on Arc: a Vite + React + viem static site and a
Node CLI. It was created from the stable-build `payouts` starter. Read
`README.md` first; this file lists the rules that keep payments correct.

## Before you finish any change

- Run `npm test` and `npm run build`. Both must pass.
- Add or update a test in `test/` for every change under `src/core/`.
- Never run `npm run e2e:testnet` or `npm run payout` without `--dry-run` unless
  the user asks. Both move funds.

## Keys and networks

- Never write, print, log or commit a private key. The CLI reads
  `PAYOUT_PRIVATE_KEY` from the shell environment only. The e2e script reads
  `STABLE_BUILD_E2E_KEY`.
- Never put a secret in a `VITE_*` variable: Vite copies it into the public bundle.
- Testnet (chain 5042002) is the default. Keep the mainnet gate: the typed
  `SEND REAL USDC` confirmation and the per-batch cap, in both `src/core/run.ts`
  and the UI. Do not add a way around them.
- `.github/workflows/pages.yml` must stay secret-free. Sending from CI is
  disabled on purpose.

## Arc rules this code depends on

Each rule has a docs page. Confirm current behaviour there, or through the
arc-docs MCP server if you have it.

| Rule | Where it lives | Source |
|---|---|---|
| USDC has one balance with two views: native 18 decimals and ERC-20 6 decimals. Use `parseUnits(x, 6)` only for `transfer` amounts. Record amounts at 18 decimals. Never add `getBalance` and `balanceOf` together. | `plan.ts`, `ledger.ts` | https://docs.arc.io/arc/references/evm-differences, https://docs.arc.io/integrate/wallets |
| `maxFeePerGas` must be at least 20 gwei. Lower values are dropped with no receipt. | `plan.ts` `feesFor` | https://docs.arc.io/arc/references/gas-and-fees |
| `eth_getLogs` accepts at most 10,000 blocks per call. Page in windows of at most 9,999 blocks. Handle `-32012` (range too large) and `-32014` (block not yet imported). | `logs.ts` | https://docs.arc.io/arc/references/rpc-endpoints |
| An ERC-20 `transfer` emits two `Transfer` logs: 6 decimals from `0x3600…` and 18 decimals from `0xffff…fFfE`. Filter by emitter and never double count. | `reconcile.ts` | https://docs.arc.io/arc/references/usdc-system-events |
| Memo and Multicall3From accept only a direct EOA caller. Smart accounts and multisig contract wallets revert. Multicall3From forwards no native value, so only use `aggregate3`. | `eoa-guard.ts`, `plan.ts` | https://docs.arc.io/arc/concepts/transaction-memos, https://docs.arc.io/arc/concepts/batched-transactions |
| The blocklist is enforced at runtime, and a reverted transfer still costs gas. Simulate before sending. | `plan.ts` `sizeChunks` | https://docs.arc.io/arc/references/evm-differences |
| Finality takes one confirmation. Do not add "N confirmations" waits. | `run.ts` | https://docs.arc.io/integrate/wallets |
| Local EVM simulators do not reproduce Arc behaviour. Test against Arc Testnet. | tests use recorded testnet receipts | https://docs.arc.io/integrate/wallets |

The nesting Multicall3From → Memo → USDC is not described in the docs. The
evidence and the open questions are in `docs/batch-memo-evidence.md`. Keep the
per-row fallback (`--mode per-row`) working.

## Memo privacy

Memo bytes, recipients and amounts are public forever.

- Do not add memo fields for names, emails, notes or salaries.
- Do not relax the `reference` character rules in `src/core/csv.ts`.
- Any memo format change needs a new schema version (`v: 2`), a new JSON Schema
  in `docs/`, and decoder tests. The v1 decoder must keep refusing other versions.

## stable-build tooling

If the stable-build plugin is installed:

- `gotchas` explains edit-time guard findings and scans this repo.
- `go-live` runs the testnet-to-mainnet checklist.

`.stable-build/project.json` marks this repo as a stable-build project.
`.stable-build/guard.json` lists the guard rules disabled here.

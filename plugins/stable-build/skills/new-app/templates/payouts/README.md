# {{APP_NAME}}

[Leia em português](README.pt-BR.md)

This app pays a CSV of recipients in USDC on Arc. Every row carries an onchain memo,
rows are grouped into a few transactions, and each row is checked against its receipt.
It is a static web app (browser wallet) plus a Node CLI (local key), with no
backend and no API keys.

Created from the stable-build `payouts` starter. stable-build is a community
project and is not affiliated with Circle.

> **Memos and amounts are public forever.** Recipients, amounts and memo
> references are readable onchain by anyone, permanently. Use opaque references
> such as `INV-0042`. Never put names, emails or notes in the CSV `reference`
> column. The parser refuses spaces and `@` in references for this reason.

## Quickstart (testnet)

You need Node 22.12 or newer and an EOA browser wallet (MetaMask, Rabby, Coinbase
Wallet, or similar).

```bash
npm install
npm test          # unit tests, including recorded Arc Testnet receipts
npm run dev       # http://localhost:5173
```

1. Get testnet USDC from https://faucet.circle.com (Arc Testnet). USDC also pays
   for gas.
2. Connect your wallet. The app adds Arc Testnet (chain 5042002) if the wallet
   does not have it yet.
3. Click **Load sample** or upload a CSV, then **Simulate and plan**.
4. Click **Send pending rows**, confirm in your wallet, and watch each row
   reconcile.
5. Export the ledger (CSV or JSON). Import the JSON later to resume a batch.

Paying a file twice is guarded in two ways. The browser keeps one ledger per
file, account and network, so uploading the same file again resumes its batch.
If there is no saved ledger (another browser, cleared storage), planning first
reads your account's Memo history for the file's references (the last 300,000
blocks, about 40 hours at the ~0.48 s testnet block time, 31 `eth_getLogs`
calls): a file paid before resumes its batch and skips the paid rows, and a
file whose references were paid in another way is refused. Payments older than
that window are not seen, so keep the exported ledger JSON. For a new pay run,
use new references.

CSV format (`sample/payroll.csv`):

```csv
recipient,amount,reference
0x0Bcf6849b35cEA52FDfcCFD41166CE5dc4c51cE1,0.01,PAY-2026-10-001
```

- `recipient`: a 0x address. Mixed-case addresses must pass the EIP-55 checksum.
  The zero address and the USDC, Memo and Multicall3From contracts are refused.
- `amount`: USDC, greater than 0, at most 6 decimals (the ERC-20 interface).
- `reference`: unique, 1 to 64 characters from `A-Z a-z 0-9 . _ : / # -`.

## CLI

```bash
npm run payout -- sample/payroll.csv --dry-run                  # plan only; no key
npm run payout -- sample/payroll.csv --dry-run --from 0xYourEOA # with eth_call simulation
export PAYOUT_PRIVATE_KEY=0x…                                   # testnet key, set in your shell only
npm run payout -- sample/payroll.csv                            # asks before sending
npm run payout -- sample/payroll.csv                            # rerun = resume; paid rows are skipped
```

- The ledger is written to `ledgers/<file>.<network>.json` after every step,
  including right after each broadcast. If a run stops, run the same command
  again to resume. With no ledger file, a new batch first checks Memo history
  for the file's references, like the web app (`--history-blocks <n>` changes
  the window; `0` skips it).
- `--mode per-row` sends one `Memo.memo` transaction per row instead of batches.
- `--sync` updates the ledger from chain history and exits. It needs no key: the
  account comes from the ledger, `--from <address>` or the key. With no ledger
  file it rebuilds one from Memo history by reference, or writes nothing.
- `--retry-rejected` puts rows rejected in simulation back in the queue; they
  are simulated again before sending.
- `--requeue-unknown` is the explicit way out when a sent transaction is unknown
  to the RPC, Memo history does not show its rows as paid, and its nonce was
  never recorded. Check the explorer first.
- The CLI refuses to send when `CI` is set (`--dry-run` and `--sync` still
  work). It refuses to run at all when a `VITE_*` variable in the shell or in a
  `.env*` file holds something shaped like a private key; `vite dev` and
  `vite build` stop on the same check.

## Mainnet

Testnet is the default everywhere.

- **Web app:** build with `VITE_NETWORK=mainnet`. The app then shows a permanent
  mainnet banner. Every send needs you to type `SEND REAL USDC` and set a
  per-batch cap in USDC that covers the batch. Both fields are cleared after
  each send and whenever another batch is planned or imported.
- **CLI:** `--network mainnet --cap <usdc>`, plus `--confirm "SEND REAL USDC"`
  or typing it at the prompt.
- Before going live, run the stable-build `go-live` checklist and
  `npm run e2e:testnet` (see below).

## How it works

- **One call per row.** Each row is
  `Memo.memo(USDC, transfer(recipient, amount), memoId, memoBytes)`. A chunk of
  rows is sent as `Multicall3From.aggregate3(calls)` with `allowFailure: false`,
  in one EOA transaction. Both contracts keep your wallet as `msg.sender`.
  Arc docs:
  [memos](https://docs.arc.io/arc/concepts/transaction-memos),
  [batches](https://docs.arc.io/arc/concepts/batched-transactions).
  The docs do not cover nesting the two. It was checked against live testnet
  receipts and `eth_call` (`docs/batch-memo-evidence.md`).
- **EOA only.** Memo and Multicall3From revert for smart accounts and for
  multisig contract wallets. The app checks `eth_getCode(account)` and refuses
  any code, including EIP-7702 delegations (`0xef0100…`), whose behaviour here
  is unverified. It sends with `eth_sendTransaction`, never `wallet_sendCalls`.
  After sending, it checks that `receipt.from` is your account.
- **Memo schema v1.**
  `memoId = keccak256(abi.encodePacked(bytes16 batchId, uint32 row))`, and the
  memo is short JSON (`docs/memo-schema.md`).
- **Chunks.** Chunks start at 50 rows and are simulated with `eth_call` first.
  A chunk that reverts is simulated row by row, and rows that revert on their
  own (bad recipient, blocklisted address) are marked `rejected` and not sent;
  **Re-queue rejected rows** (CLI: `--retry-rejected`) tries them again. A
  blocklist revert still costs gas onchain, so the app avoids sending it
  ([EVM differences](https://docs.arc.io/arc/references/evm-differences)). An
  RPC failure (HTTP 5xx, timeout, rate limit after retries) or a balance revert
  never rejects a row: the run stops and can be resumed.
  A chunk is halved if its gas estimate fails or uses more than half the block
  gas limit.
- **Fees.** `maxFeePerGas = max(20 gwei, 2 × baseFee)`. Arc drops transactions
  below 20 gwei without a receipt
  ([gas and fees](https://docs.arc.io/arc/references/gas-and-fees)). Fees are
  shown in USDC.
- **Balance.** The preflight uses `eth_getBalance` only (18 decimals). USDC's
  ERC-20 `balanceOf` is the same money in another view and is never added on top
  ([wallets](https://docs.arc.io/integrate/wallets)).
- **Reconciliation.** Logs between `BeforeMemo(k)` and `Memo(k)` belong to row k.
  Each row must have a 6-decimal `Transfer` from `0x3600…` and an 18-decimal
  `Transfer` from `0xffff…fFfE`, both from your account, paired by
  (from, to, value) ([USDC system events](https://docs.arc.io/arc/references/usdc-system-events)).
- **History.** Memo events from your account are read with `eth_getLogs` in
  windows of at most 9,999 blocks. A `-32012` error halves the window; `-32014`
  and HTTP 429 back off and retry
  ([RPC endpoints](https://docs.arc.io/arc/references/rpc-endpoints)).
- **Resume.** Rows already paid (found by `memoId`) are never sent again.
- **Wallet cancel or speed-up.** If the wallet replaces a transaction, the app
  reads the replacement's receipt: rows it paid are reconciled under the new
  hash; rows it did not pay go back to the queue and the run stops.
- **Nonces.** The CLI signs with the pending nonce it read and records it before
  broadcasting, so a dropped transaction can be told apart from a pending one.
  Browser wallets choose their own nonce; the app asks the RPC for it after the
  broadcast. A transaction the RPC does not know is first looked up in Memo
  history; if it is not there and its nonce is unknown, the app stops and asks
  you to check the explorer (**Re-queue unknown sends** / `--requeue-unknown`).
- **Ledger.** Amounts are stored as 18-decimal integer strings (`amount18`). Each
  row records status, tx hash, block, log index, memo index and an explorer link.
- **Polling.** The app polls every 250 ms. Arc makes about 2 blocks per second
  and finality is a single confirmation.

## Deploy to GitHub Pages

`.github/workflows/pages.yml` builds the static site and publishes it on every
push to `main`. To enable it, open **Settings → Pages → Source** in your repo and
choose "GitHub Actions". The workflow uses no secrets, because the visitor's
wallet signs. Never put a key in a `VITE_*` variable: those values ship in the
public bundle.

## End-to-end check (manual, testnet only)

```bash
STABLE_BUILD_E2E_KEY=0x…  npm run e2e:testnet
```

The script aborts unless the RPC reports chain id 5042002, and it refuses to run
in CI. It sends 3 rows of 0.01 USDC to fresh addresses, then checks:

- 3 Memo events and 3 pairs of Transfer logs from your account;
- that the ledger rebuilt from paged history matches;
- that a rerun sends nothing.

Use a throwaway testnet key funded from the faucet.

## Layout

```
src/config/   networks (chain ids, RPC, explorer, addresses), ABIs
src/core/     csv, memo-schema, plan, eoa-guard, logs, reconcile, ledger, run, chain
src/ui/       React UI, injected wallet, local storage
scripts/      payout.ts (CLI), e2e-testnet.ts (manual)
test/         vitest + recorded testnet fixtures
docs/         memo schema, composition evidence
```

## Known limits (UNVERIFIED)

- The best chunk size and the public RPC rate limits are not documented. The
  public testnet RPC answered bursts of `eth_getLogs` with HTTP 429 / `-32005`
  (seen 2026-10-04); history reads are spaced 250 ms apart and retried. Use a
  provider URL (`VITE_RPC_URL`, `--rpc`) for heavy use.
- EIP-7702 delegated accounts are refused until their behaviour with Memo is
  confirmed.
- The batch + memo nesting was checked on testnet, and on mainnet with `eth_call`
  only.

## Docs

- Send USDC with a transaction memo: https://docs.arc.io/arc/tutorials/send-usdc-with-transaction-memo
- Send batch USDC transfers: https://docs.arc.io/arc/tutorials/batch-usdc-transfers
- Contract addresses: https://docs.arc.io/arc/references/contract-addresses
- Connect to Arc: https://docs.arc.io/arc/references/connect-to-arc

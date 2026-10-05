# Fixtures

Every `receipt-*.json` and `memo-logs-*.json` file holds raw JSON-RPC output from
Arc Testnet (chain 5042002, `https://rpc.testnet.arc.io`), recorded on 2026-10-04
with read-only calls (`eth_getTransactionByHash`, `eth_getTransactionReceipt`,
`eth_getCode`, `eth_getLogs`). Each file's `source` block gives the method, the
time it was fetched and the explorer link. None of these files is synthetic.

These transactions were sent by other builders. They are public chain data and
are used here only to pin the receipt layout of
`Multicall3From.aggregate3 -> Memo.memo -> USDC.transfer`. See
`docs/batch-memo-evidence.md` for how they were found and checked.

`eth-call-results.json` holds `eth_call` and `eth_estimateGas` results for the
same composition on testnet and mainnet. It covers the revert data for
`MemoFailed(Error(...))` and for a call through an intermediary contract
("sender spoofing requires tx.origin as sender").

Some variants are derived inside the tests from these files and are labelled
"synthetic" there: reverted receipts, swapped log order, a tampered 18-decimal
value, a receipt from another account. Receipts for this app's own memo format
come from `synthReceipt` in `test/helpers.ts`, because no such memo exists
onchain yet. `test/synthetic.test.ts` checks that their layout matches the
recorded receipts.

To re-record, use the same read-only calls on the hashes listed in
`docs/batch-memo-evidence.md`. Never record anything that needs a key.

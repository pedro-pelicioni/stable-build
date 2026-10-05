# Memo schema v1 (`sb-payouts`)

Each payout row is wrapped as `Memo.memo(target, data, memoId, memoData)`. The Memo
contract emits `Memo(sender, target, callDataHash, memoId, memo, memoIndex)`, with
`sender`, `target` and `memoId` indexed.
Source: https://docs.arc.io/arc/concepts/transaction-memos

## memoId

```
memoId = keccak256(abi.encodePacked(bytes16 batchId, uint32 rowIndex))
```

- `batchId` is 16 random bytes, created once per batch and stored in the ledger.
- `rowIndex` is the row's position among the valid CSV rows, starting at 0.

`memoId` is deterministic and indexed. That is what makes resume idempotent:
before sending anything, the app looks up Memo events from the paying account and
skips every row whose `memoId` is already onchain.

## memoData

UTF-8 JSON of at most 256 bytes, with keys in this order:

```json
{"v":1,"app":"sb-payouts","b":"<batchId: 32 lowercase hex chars, no 0x>","i":<rowIndex>,"ref":"<reference>"}
```

The JSON Schema is in `memo-schema.v1.json`. Its rules:

- `ref` is the CSV `reference`: 1 to 64 characters from `A-Z a-z 0-9 . _ : / # -`.
  Spaces and `@` are refused, so names and email addresses cannot slip in.
- The decoder (`src/core/memo-schema.ts`) refuses anything other than `v: 1` and
  `app: "sb-payouts"`. It also refuses JSON that is malformed or longer than 256
  bytes. It keeps the raw bytes in every case.
- Memos written by other apps (including other versioned JSON memos seen on
  testnet) are reported as "another app" and never trusted.

## Privacy

Memo bytes, recipients and amounts are public and permanent. Treat every field
as published:

- Put only opaque references in `ref`, such as an invoice or payslip id that
  means something only in your own records.
- Never put names, emails, notes, salaries or national ids in a memo.
- Keep the mapping from reference to person offchain, in your own system.

## Reconciliation

For each receipt, logs between `BeforeMemo(k)` and `Memo(..., k)` belong to row k.
A row is **paid** when all of these hold:

1. `Memo.sender` is the paying EOA and `receipt.from` is the same account.
2. `Memo.target` is USDC (`0x3600…0000`).
3. The frame holds a 6-decimal `Transfer` from `0x3600…0000` and an 18-decimal
   `Transfer` from `0xffff…fFfE`. Both have the same `from` (the payer) and `to`,
   and `value18 = value6 × 10^12`. The two logs are paired by (from, to, value),
   never by their order. Sources:
   https://docs.arc.io/arc/references/usdc-system-events and
   https://docs.arc.io/arc/concepts/batched-transactions
4. `callDataHash` equals `keccak256(transfer(recipient, amount))`.
5. The memo decodes as v1, and its batch id and row index hash to the `memoId`.
6. Recipient, amount and calldata match the planned row.

The ledger records amounts in 18-decimal integer strings (`amount18`).
Source: https://docs.arc.io/integrate/exchanges/deposits

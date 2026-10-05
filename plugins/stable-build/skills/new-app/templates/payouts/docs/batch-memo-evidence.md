# Batch + memo composition: evidence

This app sends each chunk as `Multicall3From.aggregate3(calls)`, where every call is
`Memo.memo(USDC, transfer(recipient, amount), memoId, memoBytes)`.

The docs describe each contract on its own:

- Memo: https://docs.arc.io/arc/concepts/transaction-memos
- Multicall3From: https://docs.arc.io/arc/concepts/batched-transactions

They do not describe nesting one inside the other. The check below was done
without a private key, using only read-only RPC calls against
`https://rpc.testnet.arc.io` and `https://rpc.mainnet.arc.io` on 2026-10-04.

**Result: the composition works on Arc Testnet as long as the transaction comes
from a plain EOA.** The batch mode is the default. The per-row fallback (one
`Memo.memo` transaction per row, `--mode per-row`) stays available.

## 1. Existing testnet transactions

The Memo contract's logs were read with `eth_getLogs` in 40 windows of 9,999 blocks
(testnet blocks 65,129,604 to 65,529,563). The scan found:

- 1,566 transactions that emit at least one Memo event;
- 72 transactions with two or more Memo events. All 72 are calls to
  `Multicall3From.aggregate3` (selector `0x82ad56cb`) from 25 different EOAs.

Each of the 72 transactions was decoded (calldata and receipt) and checked:

| Check | Result |
|---|---|
| `Memo.sender` equals the transaction's EOA | 329 of 329 memo rows |
| Inside each `BeforeMemo(k)`…`Memo(k)` frame, both USDC Transfer logs (6 dp from `0x3600…`, 18 dp from `0xffff…fFfE`) have `from` = EOA and `value18 = value6 × 10^12` | 327 of 327 USDC rows |
| `Memo.callDataHash` = `keccak256(transfer calldata)` | 327 of 327 USDC rows |
| Sender had no code (`eth_getCode` = `0x`) | 25 of 25 EOAs |
| Gas per row (all-memo batches) | min 32,189, median 58,376, max 66,721 |

The other 2 memo rows wrap EURC transfers rather than USDC. Five transactions
also mix in plain subcalls to another contract. Both kinds are recorded as fixtures.

The recorded fixtures are in `test/fixtures/`:

| Fixture | Transaction |
|---|---|
| `receipt-batch-2rows.json` | [0xda546e55…ebf2](https://explorer.testnet.arc.io/tx/0xda546e55a0731e8d21d57f8c467e19d73968082ea3496a8a3031e5a0d435ebf2): 2 rows, 108,453 gas |
| `receipt-batch-2rows-b.json` | [0xbcfce32e…3911](https://explorer.testnet.arc.io/tx/0xbcfce32e3bdd3d054589046c11441e4fd4b570318ea90b5cd0eedeedbf753911) |
| `receipt-batch-13rows.json` | [0x83b492de…4d94](https://explorer.testnet.arc.io/tx/0x83b492de8925f024fdb24245a1f2146c823b7521fcb4a0d948e750d1377d4d94): 13 rows, 418,492 gas |
| `receipt-batch-2rows-other-eoa.json` | [0x3a876140…279f](https://explorer.testnet.arc.io/tx/0x3a8761401abf4b1f055facd8c309caa55f481dca4429cf38309f69dfb192279f): a different sender |
| `receipt-batch-eurc-mixed.json` | [0x404e2146…5862](https://explorer.testnet.arc.io/tx/0x404e21468ccb7bfffc7517c8dd436bcb438e2f58765715a68c23a0390ba05862): EURC and USDC rows |
| `receipt-batch-non-memo-calls.json` | [0x5745f982…0918](https://explorer.testnet.arc.io/tx/0x5745f9820a4382587b522000e2ca4ba1f34d9842319592335049cdb9f7910918): memo rows mixed with plain subcalls |
| `memo-logs-sender-427c.json` | `eth_getLogs` output: 17 Memo events from one sender over blocks 65,396,900 to 65,397,100 |

These transactions belong to other builders. Their memos use a different JSON format,
which this app's decoder correctly reports as "another app".

## 2. eth_call simulation

The composition was simulated with `eth_call` (`test/fixtures/eth-call-results.json`):

| Case | Network | Result |
|---|---|---|
| 2 rows × 0.01 USDC from a funded EOA | testnet | success, `[(true, 0x), (true, 0x)]` |
| 2 rows × 0 USDC from an empty EOA | testnet | success |
| 2 rows × 0 USDC from an empty EOA | mainnet (5042) | success |
| 2 rows × 0.01 USDC from an empty EOA | testnet | revert `MemoFailed(Error("ERC20: transfer amount exceeds balance"))`, selector `0xed1966a2` |
| Intermediary contract (standard Multicall3 → Multicall3From → Memo) | testnet | revert `"sender spoofing requires tx.origin as sender"` |
| Intermediary contract (standard Multicall3 → Memo) | testnet | revert, same reason |

The intermediary cases show why smart accounts cannot use this flow: the
contract calling Memo or Multicall3From must be the transaction's origin.

`eth_estimateGas` from a funded EOA, paying 1 base unit to fresh recipients,
gave 103,395 gas for 1 row, 792,539 for 13, 2,918,685 for 50 and 5,800,697 for
100. The block gas limit was 30,000,000. A 50-row chunk therefore uses about 10%
of a block, which is why chunks start at 50 rows.

## 3. Still UNVERIFIED

- **EIP-7702 delegated EOAs.** No delegated sender was tested, so this app refuses
  code that starts with `0xef0100`.
- **Mainnet.** Mainnet was only checked with `eth_call` at 0 value. No mainnet
  transaction with this composition was found.
- **Chunk size.** The production chunk size and the public RPC rate limits are
  not documented.
- **Blocklist reverts.** The exact revert text for a blocklisted recipient is
  unknown. The template treats any simulation revert as a rejected row.
- **Future changes.** Arc may change these contracts. Run `npm run e2e:testnet`
  with your own funded testnet key before going live.

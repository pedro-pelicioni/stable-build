# Onchain states for apps built on Arc

stable-build original content (not adapted from upstream). Checked against docs.arc.io on 2026-10-04; confirm through the arc-docs MCP before finalizing. Copy the rows that apply into EXPERIENCE.md under **State Patterns**, and the copy rules into **Voice and Tone**.

## Balance

| Rule | Why | Source |
| --- | --- | --- |
| Show **one** USDC balance row. Never list native USDC and ERC-20 USDC as two balances, and never add them. | They are one balance with two views. | https://docs.arc.io/integrate/wallets |
| Compute the shown amount from the native value (`eth_getBalance`, 18 decimals) divided by 10^12 to get 6-decimal USDC; round for display only. | The 6-decimal `balanceOf` view truncates dust; a zero `balanceOf` does not mean zero USDC. | https://docs.arc.io/arc/references/evm-differences |
| Amount inputs accept at most 6 decimals for ERC-20 transfers. | The ERC-20 interface has 6 decimals. | https://docs.arc.io/arc/references/evm-differences |

## Fees

| Rule | Why | Source |
| --- | --- | --- |
| Show fees as a USDC amount (`$0.01`, `~$0.01`), never gwei or ETH. | Gas is paid in USDC. | https://docs.arc.io/integrate/wallets/fee-display |
| When the user sees a total, say whether the fee is inside it. | The same USDC balance pays the amount and the fee. | stable-build convention; fee model: https://docs.arc.io/integrate/wallets/fee-display |

## Transaction states

Arc has two lifecycle states, pending and final, plus three failure outcomes. Never show "X of N confirmations" or a "confirming" spinner.

| State | Detect | Show | Source |
| --- | --- | --- | --- |
| **Rejected** | `eth_sendRawTransaction` (or the wallet) returns an error; no hash | Plain error, nothing was sent, what to change | https://docs.arc.io/integrate/wallets/transaction-lifecycle |
| **Pending** | Hash, no receipt yet | "Pending" with the hash; usually under a second | https://docs.arc.io/integrate/wallets/transaction-lifecycle |
| **Final, success** | Receipt with `status = 1` | "Complete" immediately, explorer link; no further waiting | https://docs.arc.io/integrate/wallets/transaction-lifecycle |
| **Final, reverted** | Receipt with `status = 0` | "Failed: no funds moved; the network fee was charged". For a blocklist revert: "the recipient or sender may be restricted". Retry needs a new transaction. | https://docs.arc.io/integrate/wallets/transaction-lifecycle · https://docs.arc.io/arc/references/evm-differences |
| **Dropped** | No receipt after your timeout; the hash is unknown to the node | "Not processed: nothing moved." Offer resubmit. A fee below 20 gwei never gets a receipt: some RPCs drop it silently, others reject it as `transaction underpriced`. | https://docs.arc.io/integrate/wallets/transaction-lifecycle · https://docs.arc.io/arc/references/evm-differences · https://docs.arc.io/arc/references/gas-and-fees |

Batches: show per-row state. A row that simulation rejects before sending (for example a blocklisted recipient) is shown as **not sent**, distinct from a reverted send.

## Network

| Rule | Why | Source |
| --- | --- | --- |
| Testnet builds show a persistent "Testnet: no real funds" banner. | Testnet (5042002) is the default until go-live. | https://docs.arc.io/arc/references/rpc-endpoints |
| Mainnet builds that move real funds show a persistent mainnet marker and ask for an explicit confirmation before the first send. | Prevent test habits on real money. | stable-build convention |
| Wrong chain in the wallet: one clear prompt to switch to chain 5042002 (testnet) or 5042 (mainnet). | Chain ids differ per network. | https://docs.arc.io/arc/references/rpc-endpoints |

## Memos, references and privacy

| Rule | Why | Source |
| --- | --- | --- |
| Before attaching a memo or reference, tell the user it is public forever. Never put names, emails or notes in it. | Memo bytes are emitted in events. | https://docs.arc.io/arc/concepts/transaction-memos |
| If the user's wallet is a smart account, hide or explain features that need an EOA (memo, batched send). | Memo and Multicall3From reject smart-account callers. | https://docs.arc.io/arc/concepts/transaction-memos · https://docs.arc.io/arc/concepts/batched-transactions |

## Allowances

| Rule | Why | Source |
| --- | --- | --- |
| Never present an ERC-20 allowance as a spending cap. | Allowances gate only `transferFrom`; native transfers bypass them. | https://docs.arc.io/integrate/wallets |

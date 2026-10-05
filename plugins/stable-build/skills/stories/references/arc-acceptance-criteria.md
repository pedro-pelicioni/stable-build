# Arc acceptance criteria library

stable-build original content (not adapted from upstream). Checked against docs.arc.io on 2026-10-04; confirm through the arc-docs MCP when you use one. Pick the criteria a story needs and rewrite them in the story's own terms. Each one is testable.

## Amounts and balances
- **Given** an amount of X USDC, **when** it is sent through the ERC-20 interface (`transfer`, `approve`, `transferFrom` on `0x3600…0000`), **then** the raw value is X × 10^6. https://docs.arc.io/arc/references/evm-differences
- **Given** an amount of X USDC, **when** it is sent as native value (`value`, `msg.value`), **then** the raw value is X × 10^18. https://docs.arc.io/arc/references/evm-differences
- **Given** a wallet with USDC, **when** the balance is shown, **then** exactly one USDC balance appears, derived from `eth_getBalance` ÷ 10^12, and no code path adds `balanceOf` to it. https://docs.arc.io/integrate/wallets
- **Given** a ledger entry, **when** it is stored, **then** the amount is an 18-decimal integer string and matches the system-emitter `Transfer` value. https://docs.arc.io/arc/references/usdc-system-events

## Fees
- **Given** any transaction this story submits, **when** fees are set, **then** `maxFeePerGas` is at least 20 gwei. https://docs.arc.io/arc/references/evm-differences
- **Given** a fee is shown to the user, **then** it is a USDC amount, never gwei or ETH. https://docs.arc.io/integrate/wallets/fee-display

## Transaction states
- **Given** a submitted transaction, **when** its receipt arrives with `status = 1`, **then** the UI shows it as final immediately, with no confirmation counter. https://docs.arc.io/integrate/wallets/transaction-lifecycle
- **Given** a receipt with `status = 0`, **then** the UI shows "failed, network fee charged, nothing moved", and a retry creates a new transaction. https://docs.arc.io/integrate/wallets/transaction-lifecycle
- **Given** no receipt after the timeout, **then** the transaction is shown as not processed and the user can resubmit. https://docs.arc.io/integrate/wallets/transaction-lifecycle
- **Given** a recipient that would revert (zero address, blocklisted), **when** the batch is simulated with `eth_call` before sending, **then** that recipient is marked not sent and the others proceed. https://docs.arc.io/arc/references/evm-differences

## Memo and batching (only when the story uses them)
- **Given** the connected account has contract code (`eth_getCode` is not `0x`), **when** the user starts a memo or batched send, **then** the app refuses before signing and explains why. Smart accounts are documented as unsupported callers; how an EIP-7702 delegated EOA behaves is UNVERIFIED, so refuse it too until tested. https://docs.arc.io/arc/concepts/transaction-memos · https://docs.arc.io/arc/concepts/batched-transactions
- **Given** a memo send, **then** the `Memo` event's `sender` equals the user's EOA and its `callDataHash` equals `keccak256` of the forwarded calldata. https://docs.arc.io/arc/concepts/transaction-memos
- **Given** a `Multicall3From` batch, **then** every USDC `Transfer` has `from` equal to the user's EOA, and no call forwards value. https://docs.arc.io/arc/concepts/batched-transactions
- **Given** a memo payload, **then** it contains no personal data (it is public forever). https://docs.arc.io/arc/concepts/transaction-memos

## Logs and history
- **Given** a history query over N blocks, **when** it runs, **then** it pages in ranges of at most 9,999 blocks, halves the range on `-32012`, and retries `-32014` after a backoff. https://docs.arc.io/arc/references/rpc-endpoints
- **Given** an ERC-20 USDC transfer, **when** history is built, **then** it is counted once (from one emitter), never from both `0x3600…0000` and `0xffff…fFfE`. https://docs.arc.io/arc/references/usdc-system-events
- **Given** events from the same block, **then** they are ordered by `(blockNumber, logIndex)`, not by timestamp. https://docs.arc.io/arc/references/evm-differences

## Contracts
- **Given** the contract tests, **when** `FOUNDRY_PROFILE=arc arc-forge test` runs (with `[profile.arc] network = "arc"`), **then** they pass; CI does not use `foundry-rs/foundry-toolchain`. https://docs.arc.io/arc/tutorials/install-arc-foundry · https://github.com/circlefin/arc-foundry
- **Given** logic that needs randomness, **then** it does not read `PREVRANDAO` (always 0 on Arc). https://docs.arc.io/arc/references/evm-differences
- **Given** a contract that holds USDC, **then** it has no reachable `SELFDESTRUCT`. https://docs.arc.io/arc/references/evm-differences

## Network
- **Given** a default build, **then** it targets Arc Testnet (chain id 5042002) and shows the testnet banner; mainnet (5042) needs an explicit switch. https://docs.arc.io/arc/references/rpc-endpoints

## Testnet evidence (every onchain story)
- **Given** the story is implemented and its tests pass, **when** the user runs the story's flow on Arc Testnet with their own testnet key, **then** the story file's Testnet Evidence table records the tx hash, block and receipt `status = 1` (checked read-only with `eth_getTransactionReceipt` against https://rpc.testnet.arc.io and `eth_chainId` = `0x4cef52`), plus the explorer link `https://explorer.testnet.arc.io/tx/{hash}` and which criterion it proves. https://docs.arc.io/arc/references/rpc-endpoints

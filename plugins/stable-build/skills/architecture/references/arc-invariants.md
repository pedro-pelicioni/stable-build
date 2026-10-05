# Arc invariants: seed decisions for the spine

stable-build original content (not adapted from upstream). Checked against docs.arc.io on 2026-10-04. Re-confirm each entry through the arc-docs MCP before adopting it; if a page changed, the page wins and the spine records the new rule.

Keep only the entries the app touches. Adopted entries go first in **Invariants & Rules** as `AD-1`, `AD-2`, … with the tag `[ADOPTED: Arc protocol]` and the source URL under the Rule.

---

### One USDC, two decimal views
- **Binds:** every amount in contracts, backend, ledger and UI.
- **Prevents:** values off by 10^12, the same balance counted twice, ledgers that record less than was sent.
- **Rule:** native USDC (`msg.value`, `eth_getBalance`, transaction `value`) has 18 decimals; the ERC-20 interface at `0x3600000000000000000000000000000000000000` (`balanceOf`, `transfer`) has 6. They are one balance. Pick one internal unit (18-decimal integer strings for ledgers), convert only at the edges, never mix `msg.value` with `balanceOf` in one formula, and show one balance row. A zero `balanceOf` does not mean a zero native balance (dust).
- **Source:** https://docs.arc.io/arc/references/evm-differences · https://docs.arc.io/integrate/wallets

### Allowances do not cap native spending
- **Binds:** any design that treats an ERC-20 allowance as a spending limit.
- **Prevents:** a "capped" spender moving more USDC through the native path.
- **Rule:** `approve`/`allowance` gate only `transferFrom`. Limits that matter are enforced in your own contract or service, not by an allowance.
- **Source:** https://docs.arc.io/integrate/wallets

### Fee floor and USDC fees
- **Binds:** every submit path (browser wallet, scripts, relayers, CI jobs).
- **Prevents:** transactions that never get a receipt (silently dropped, or rejected as `transaction underpriced`, depending on the RPC).
- **Rule:** `maxFeePerGas` is at least 20 gwei on every path; lower values never reach a block. Fees are shown in USDC, never in gwei or ETH. The 20 gwei minimum base fee is documented for testnet, and the gas-and-fees page says these values may change before mainnet: keep 20 gwei as the floor everywhere, and re-confirm the mainnet value through the arc-docs MCP before go-live.
- **Source:** https://docs.arc.io/arc/references/evm-differences · https://docs.arc.io/arc/references/gas-and-fees · https://docs.arc.io/integrate/wallets/fee-display

### One confirmation is final; order by block
- **Binds:** UI states, backend crediting, indexers.
- **Prevents:** confirmation counters, double handling, wrong event order.
- **Rule:** a transaction is pending (no receipt) or final (receipt in a block). Act after one confirmation. Order events by `(blockNumber, logIndex)`; block timestamps are non-decreasing and can repeat.
- **Source:** https://docs.arc.io/integrate/wallets/transaction-lifecycle · https://docs.arc.io/arc/references/evm-differences

### Value transfers can revert
- **Binds:** payout loops, refunds, contract-to-user sends.
- **Prevents:** one bad recipient blocking a whole batch; gas lost without notice.
- **Rule:** native value to `0x0`, to a self-destructed account, or to/from a blocklisted address reverts, and an included blocklist revert still consumes gas. Prefer pull over push payments; isolate recipients; simulate with `eth_call` before sending; handle `receipt.status == 0`.
- **Source:** https://docs.arc.io/arc/references/evm-differences · https://docs.arc.io/integrate/wallets/transaction-lifecycle

### Memo and Multicall3From: EOA caller, no value
- **Binds:** wallet model, batching, reconciliation.
- **Prevents:** reverts from smart accounts; value silently not forwarded.
- **Rule:** `Memo` (`0x5294E9927c3306DcBaDb03fe70b92e01cCede505`) and `Multicall3From` (`0x522fAf9A91c41c443c66765030741e4AaCe147D0`) must be called directly by an EOA. ERC-4337 accounts, Safe, and SCA-configured wallets are not supported as the direct caller. `Multicall3From` has no `aggregate3Value`. If the wallet model is a smart account, choose another path (metadata in the app layer, or a separate EOA-signed memo transaction). Offchain blocklist screening must include both addresses.
- **Source:** https://docs.arc.io/arc/concepts/transaction-memos · https://docs.arc.io/arc/concepts/batched-transactions · https://docs.arc.io/arc/references/contract-addresses

### Indexing: one emitter, paged logs
- **Binds:** history, reconciliation, analytics.
- **Prevents:** transfers counted twice; history queries that fail on long ranges.
- **Rule:** an ERC-20 `transfer()` emits two `Transfer` logs: 6 decimals from `0x3600…0000` and 18 decimals from the system emitter `0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE`. Count from one emitter (the system emitter also covers plain native sends) and never mix the values. Page `eth_getLogs` in ranges of at most 9,999 blocks (error `-32012` above 10,000); retry `-32014` after a short backoff.
- **Source:** https://docs.arc.io/arc/references/usdc-system-events · https://docs.arc.io/arc/references/rpc-endpoints

### No onchain randomness, blobs or beacon roots
- **Binds:** games, lotteries, sampling, anything that reads chain entropy.
- **Prevents:** predictable "random" values.
- **Rule:** `PREVRANDAO` always returns 0: use an oracle or VRF. Type-3 (blob) transactions are rejected. The EIP-4788 beacon-roots contract is absent; reads return empty.
- **Source:** https://docs.arc.io/arc/references/evm-differences

### SELFDESTRUCT moves USDC
- **Binds:** any contract that holds USDC.
- **Prevents:** funds moved or calls reverting after a self-destruct.
- **Rule:** self-destructing a contract sends its native USDC to the beneficiary; a later non-zero-value call to that account in the same transaction reverts. Keep `SELFDESTRUCT` out of contracts that hold funds.
- **Source:** https://docs.arc.io/arc/references/evm-differences

### Tests run on Arc semantics
- **Binds:** local chain, unit tests, CI.
- **Prevents:** green tests that ran under Ethereum rules.
- **Rule:** local chain `arc-anvil --network arc`; tests `FOUNDRY_PROFILE=arc arc-forge test` with `[profile.arc] network = "arc"` in `foundry.toml`; CI installs Arc Foundry from its release archives and never uses `foundry-rs/foundry-toolchain`.
- **Source:** https://docs.arc.io/arc/references/evm-differences (Note) · https://docs.arc.io/arc/tutorials/install-arc-foundry · https://github.com/circlefin/arc-foundry (README, CI/CD note)

### One network config, testnet by default
- **Binds:** frontend, scripts, backend, CI.
- **Prevents:** a build that silently talks to mainnet; addresses drifting between modules.
- **Rule:** chain id (`5042002` testnet, `5042` mainnet), RPC URL, explorer and contract addresses come from one config module. Testnet is the default; mainnet needs an explicit switch and a human-held key.
- **Source:** https://docs.arc.io/arc/references/rpc-endpoints · https://docs.arc.io/arc/references/contract-addresses

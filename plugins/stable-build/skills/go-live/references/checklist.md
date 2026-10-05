# go-live gates G1-G14

`scripts/evidence.mjs` runs the static part of every gate. This file is the reference behind it: what each gate checks, why, how to collect the evidence by hand, when it passes, and the docs to cite. Every command here is read-only.

Statuses: **pass** (evidence shows it is done), **fail** (evidence shows a problem), **unknown** (could not be observed; say what is needed), **n/a** (the project does not use the feature, with the reason). Never mark pass without evidence.

Search helper for the manual commands (bash and zsh):

```sh
g() { grep -rnIE --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=build \
  --exclude-dir=out --exclude-dir=.next --exclude-dir=lib --exclude-dir=cache "$@" . ; }
```

Read-only RPC helper (public endpoints, no key; https://docs.arc.io/arc/references/rpc-endpoints):

```sh
rpc() { curl -s -X POST -H 'content-type: application/json' \
  --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}" "${3:-https://rpc.mainnet.arc.io}"; }
# rpc eth_chainId '[]'                       -> "0x13b2" (5042) on mainnet
# rpc eth_getCode '["0xYourContract","latest"]'
```

---

## G1. Tests run on Arc semantics

- **Check:** contract tests run with Arc Foundry (`arc-forge test --network arc`, or `FOUNDRY_PROFILE=arc arc-forge test` with `[profile.arc] network = "arc"`; local node `arc-anvil --network arc`). No upstream `foundryup`, `foundry-rs/foundry-toolchain`, bare `forge`/`anvil`/`cast send` in scripts, CI, Makefile or README.
- **Why:** local EVM simulators such as upstream `anvil` run a standard EVM and cannot reproduce Arc behavior. The upstream toolchain gives a green build that proves nothing about Arc.
- **Evidence:**
  ```sh
  g '\bfoundryup\b|foundry\.paradigm\.xyz|foundry-rs/foundry-toolchain'
  g '(^|[^[:alnum:]_-])(forge (test|build|create|script)|anvil|cast send)\b'
  g 'arc-forge test|FOUNDRY_PROFILE=arc|\[profile\.arc\]|arc-anvil'
  ```
- **Pass when:** no upstream hits, and contract tests run Arc Foundry **in Arc mode**: `--network arc`, a `FOUNDRY_PROFILE` whose `foundry.toml` profile sets `network = "arc"` (or the default profile sets it), or a fork of an Arc RPC (`--fork-url`). A bare `arc-forge test` or `arc-anvil` runs Ethereum rules ("arc-forge test  # Ethereum" in the arc-foundry README): **fail**, or **unknown** when there is no `foundry.toml` to read. No contracts: n/a. Hardhat-only test suites are **unknown** until they run against `arc-anvil --network arc` or Arc Testnet.
- **Docs:** https://docs.arc.io/arc/references/evm-differences (Note on anvil), https://docs.arc.io/arc/tutorials/install-arc-foundry, https://github.com/circlefin/arc-foundry

## G2. Guard scan reports 0 errors

- **Check:** the stable-build guard's repo scan finds no error-level Arc pitfalls.
- **Evidence:** `node <plugin root>/scripts/guard.mjs --scan .`. The plugin root is three levels up from `scripts/evidence.mjs`; in Claude Code it is `${CLAUDE_PLUGIN_ROOT}`.
- **Pass when:** exit code 0. A non-zero exit with findings is **fail**; quote rule ids and files. A crash or a missing guard script is **unknown**.
- **Docs:** each finding carries its own docs.arc.io link (see the `gotchas` skill).

## G3. Mainnet configuration

- **Check:** chain id 5042, a mainnet RPC (`https://rpc.mainnet.arc.io` or a listed provider), the explorer `https://explorer.arc.io`. In viem, `arc` from `viem/chains`. USDC (`0x3600…0000`), Memo (`0x5294…e505`) and Multicall3From (`0x522f…47D0`) have the same address on both networks. EURC, USYC (and its Entitlements and Teller), CCTP (TokenMessengerV2, TokenMessengerWithFees, MessageTransmitterV2, TokenMinterV2, MessageV2), CrossChainTokenService, Gateway, StableFX (FxEscrow), cirBTC, WETH and the ERC-8004 registries do **not**.
- **Evidence:**
  ```sh
  g '\b5042\b|0x13b2|rpc\.mainnet\.arc\.io|mainnet\.arc\.io|explorer\.arc\.io'
  g 'from ["'"'"']viem/chains["'"'"']'
  g '\b5042002\b|rpc\.testnet\.arc\.io|explorer\.testnet\.arc\.io|arcTestnet'
  rpc eth_chainId '[]'      # expect "0x13b2"
  ```
- **Pass when:** a mainnet config exists and is selected by an explicit setting, and every network-specific address comes from the mainnet table. Testnet-only addresses next to the mainnet config are **unknown** until checked.
- **Docs:** https://docs.arc.io/arc/references/rpc-endpoints, https://docs.arc.io/arc/references/contract-addresses

## G4. Deploy path: Arc Studio is testnet only

- **Check:** nothing expects Arc Studio to deploy to mainnet. Mainnet contracts are deployed with `arc-forge`, by a human holding the key. Every address that Arc Studio reported (`deployments[]`) or that is recorded in the project is re-checked onchain.
- **Evidence:**
  ```sh
  g 'arc-studio'                                   # any mainnet expectation is a fail
  ls broadcast/*/5042/run-latest.json 2>/dev/null  # Foundry broadcast records for mainnet
  rpc eth_getCode '["0xAddress","latest"]'         # "0x" means no contract at that address
  ```
  `scripts/evidence.mjs --online` runs `eth_getCode` for the addresses in `.stable-build/project.json` `deployments[]`, Foundry broadcasts and `--address`.
- **Pass when:** every mainnet address has code, and the deploy path is `arc-forge` (or there are no contracts: n/a). Treat Studio output as untrusted until checked.
- **Docs:** https://docs.arc.io/ai/arc-studio-cli ("Arc Studio deploys to Arc testnet only")

## G5. Contract source verified on the explorer

- **Check:** each mainnet contract shows verified source on the explorer.
- **Evidence:** `g 'verify-contract|--verifier blockscout'`. Then open `https://explorer.arc.io/address/<address>` and look for the Contract tab with source.
- **Pass when:** the user confirms, or the explorer shows verified source. The only documented `--verifier-url` is the testnet explorer API (deploy-on-arc step 5.2); the mainnet verifier URL is UNVERIFIED, so confirm it in the explorer UI or through the arc-docs MCP.
- **Docs:** https://docs.arc.io/arc/tutorials/deploy-on-arc (step 5.2)

## G6. Fee floor and fees shown in USDC

- **Check:** no `maxFeePerGas` or `gasPrice` below 20 gwei. The UI shows fees in USDC, never ETH or Gwei.
- **Why:** transactions with `maxFeePerGas` under 20 gwei are dropped by the mempool with no receipt.
- **Evidence:**
  ```sh
  g 'maxFeePerGas|gasPrice|--gas-price|maxPriorityFeePerGas'
  g '\b(ETH|Gwei|gwei)\b' --include='*.tsx' --include='*.jsx' --include='*.vue' --include='*.svelte' --include='*.html'
  ```
- **Pass when:** every explicit fee is at least 20 gwei (for example `max(20 gwei, 2 × baseFee)`), and no fee label says ETH or Gwei. The 20 gwei minimum base fee is documented for testnet ("may change before mainnet launch", gas-and-fees); confirm the mainnet value through the arc-docs MCP and record it in the report.
- **Docs:** https://docs.arc.io/arc/references/evm-differences (Fee market), https://docs.arc.io/arc/references/gas-and-fees, https://docs.arc.io/integrate/wallets/fee-display

## G7. One USDC balance; ledger at 18 decimals

- **Check:** native (`getBalance`, 18 dp) and ERC-20 (`balanceOf`, 6 dp) are never added together or shown as two rows. Amounts credited from native Transfer logs are stored at 18 dp.
- **Evidence:** `g 'getBalance|balanceOf'`, then read every line that touches both. `g '1e12|10n *\*\* *12n|1_000_000_000_000'` shows the conversions.
- **Pass when:** one balance is shown, and the ledger stores 18-dp values (or converts exactly).
- **Docs:** https://docs.arc.io/arc/references/connect-to-arc (single balance warning), https://docs.arc.io/integrate/wallets, https://docs.arc.io/integrate/exchanges/deposits

## G8. Log reads: paging, emitter, retries

- **Check:** `eth_getLogs` spans of at most 9,999 blocks, with paging; error -32012 is handled by shrinking the range; error -32014 near the head is retried after a backoff. USDC Transfer history filters the system emitter `0xffff…fffE` (18 dp), and never counts both emitters.
- **Evidence:**
  ```sh
  g 'getLogs|getContractEvents|queryFilter|eth_getLogs'
  g '9_?999|-32012|-32014|0xfffffffffffffffffffffffffffffffffffffffe'
  ```
- **Pass when:** every log reader pages in steps of at most 9,999 blocks and handles -32014. There are no log reads: n/a.
- **Docs:** https://docs.arc.io/arc/references/rpc-endpoints, https://docs.arc.io/arc/references/usdc-system-events

## G9. Memo and Multicall3From are called by an EOA only

- **Check:** Memo (`0x5294E9927c3306DcBaDb03fe70b92e01cCede505`) and Multicall3From (`0x522fAf9A91c41c443c66765030741e4AaCe147D0`) are called directly by an EOA, never through ERC-4337, Safe, a modular wallet or `wallet_sendCalls`. No `aggregate3Value` and no `value` on these calls.
- **Evidence:**
  ```sh
  g '0x5294E9927c3306DcBaDb03fe70b92e01cCede505|0x522fAf9A91c41c443c66765030741e4AaCe147D0|Multicall3From'
  g 'sendUserOperation|toCircleSmartAccount|toSafeSmartAccount|bundlerClient|wallet_sendCalls|aggregate3Value'
  g 'getCode|getBytecode|0xef0100'
  ```
- **Pass when:** the extensions are only reachable from an EOA path (for example a `getCode(account) == "0x"` guard), or they are unused: n/a.
- **Docs:** https://docs.arc.io/arc/concepts/transaction-memos (Wallet types), https://docs.arc.io/arc/concepts/batched-transactions (guardrails)

## G10. EVM differences reviewed

- **Check:**
  - `PREVRANDAO` always returns 0, so there is no onchain randomness;
  - blob (type-3) transactions are rejected;
  - `SELFDESTRUCT` follows extra value rules;
  - value transfers to `address(0)` revert;
  - a transfer to or from a blocklisted address reverts and still costs gas.
- **Evidence:**
  ```sh
  g 'prevrandao|block\.difficulty|selfdestruct|blobhash|eip4844|blobs:' --include='*.sol' --include='*.ts' --include='*.js'
  g 'address\(0\)\)?\.(transfer|send|call)'
  ```
- **Pass when:** no randomness from `PREVRANDAO`, no blobs, every `SELFDESTRUCT` reviewed against the rules, and sends are simulated before they are submitted, so blocklisted counterparties are caught first.
- **Docs:** https://docs.arc.io/arc/references/evm-differences

## G11. One-confirmation finality in the UX

- **Check:** no "N of M confirmations" counters, no waits for more than one confirmation, and no long "Confirming" states. The transaction is pending, then final.
- **Evidence:** `g 'confirmations *: *[2-9]|\.wait\( *[2-9]|of [0-9]+ confirmations|Confirming'`
- **Pass when:** there are no hits (or no UI: n/a).
- **Docs:** https://docs.arc.io/integrate/wallets/transaction-lifecycle, https://docs.arc.io/integrate/wallets

## G12. USDC to Stellar goes through CctpForwarder

- **Check:** any CCTP burn to domain 27 (Stellar) sets both `mintRecipient` and `destinationCaller` to CctpForwarder. Mainnet: `CBZL2IH7F6BIDAA3WBNXYKIXSATJGMSW7K5P5MJ6STX5RXN47TZJDF5T`; testnet: `CA66Q2WFBND6V4UEB7RD4SAXSVIWMD6RA4X3U32ELVFGXV5PJK4T4VSZ`. Otherwise the funds are stuck and cannot be recovered.
- **Evidence:** `g 'destinationDomain *[:=] *27\b|[Ss]tellar|CctpForwarder|CBZL2IH7|CA66Q2WF'`
- **Pass when:** every domain-27 burn (object form, ethers `depositForBurn(amount, 27, …)` or viem `write.depositForBurn([amount, 27, …])`) is shown to use the mainnet forwarder for both fields; there are no Stellar sends: n/a. The mainnet strkey appearing somewhere is not enough: when a burn's fields cannot be traced to it, the gate is **unknown** with the burn sites listed. A burn whose `mintRecipient` or `destinationCaller` is a user address, the testnet forwarder or zero is **fail**.
- **Docs:** https://developers.circle.com/cctp/references/stellar, https://developers.circle.com/cctp/references/stellar-contracts

## G13. Operations: keys, monitoring, screening

- **Check:**
  - no key material in the repo or CI;
  - mainnet keys held by a human or in a KMS or hardware wallet;
  - someone is alerted on failures;
  - if you screen addresses offchain, Memo and Multicall3From are included as attributable contracts.
- **Evidence:**
  - `git ls-files | grep -E '(^|/)\.env($|\.)' | grep -vE 'example|sample|template'`
  - `g '(PRIVATE_KEY|MNEMONIC|SECRET)[A-Z_]* *[=:]'`: report only the file and line, never the value.
  - Ask the user about custody, monitoring and screening; these cannot be observed.
- **Pass when:**
  - no committed secrets;
  - the user confirms custody and monitoring;
  - screening includes both extension contracts (or there is no screening: say so).
- **Docs:** https://docs.arc.io/arc/references/contract-addresses (Offchain blocklist operators warning), https://docs.arc.io/integrate/infrastructure/compliance

## G14. Brand claims and program eligibility

- **Check:**
  - the app does not claim to be official, partnered with, endorsed by or backed by Arc or Circle;
  - Arc marks are used only per the Arc Brand Kit;
  - no yield, APR, ROI or "guaranteed" wording;
  - for each open program in `../../data/programs.json`, the stated requirements are met (Microgrants: deployed and working on Arc mainnet, public repo, before the deadline).
- **Evidence:**
  ```sh
  g -i 'official (arc|circle)|partner(ed)? with (arc|circle)|endorsed by|(arc|circle)[- ]backed|backed by (arc|circle)'
  g -i '\b(apy|apr|yield|roi|guaranteed|risk[- ]free|passive income)\b'
  git remote get-url origin; gh repo view --json visibility   # the second needs gh and network
  ```
- **Pass when:**
  - there are no claim or wording hits;
  - the product name does not misuse Arc marks;
  - program requirements are met, or the report says which ones are not.
- **Docs:**
  - https://docs.arc.io/terms (section 12, Arc marks)
  - each program's `source_url` in `programs.json`, re-checked on its page before applying

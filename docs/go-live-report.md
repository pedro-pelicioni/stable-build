# Go-live report: GoLive Registry

Generated 2026-10-20 by stable-build go-live, commit 7442392. Read-only review: nothing was deployed or signed.
Network target: Arc mainnet (chain 5042). Online checks: yes (read-only RPC and `gh repo view` only).

Project in scope: `GoLiveRegistry` and `DemoProject` in `contracts/go-live-registry`, the reference client in `apps/onboarding`, and `tools/go-live-sign.mjs`. The evidence collector scanned the git root (337 files). Hits that only name a pitfall inside the guard, the checklist, or the collector itself are corrected below and are not findings in this project. The payouts starter is a different template and is not this badge.

| Gate | Status | Evidence | Fix / next step | Docs |
|---|---|---|---|---|
| G1 Tests run on Arc semantics | pass | `contracts/go-live-registry/foundry.toml` sets `network = "arc"` on the default profile and on `[profile.arc]`. 2026-10-20: `arc-forge test --network arc` passed 19 unit tests and skipped the fork (no `ARC_MAINNET_RPC`). `ARC_MAINNET_RPC=https://rpc.mainnet.arc.io arc-forge test --network arc --match-contract ArcForkTest` passed 3 tests, including `FeeMismatch`. Arc Foundry v0.8.0-2, `forge 1.7.1-dev`, commit `d497beea`. Collector "upstream Foundry" hits are the guard rule text and the installer renaming the release binaries `forge`, `cast`, and `anvil` to `arc-forge`, `arc-cast`, and `arc-anvil`. | none | https://docs.arc.io/arc/references/evm-differences |
| G2 Guard scan reports 0 errors | pass | `node plugins/stable-build/scripts/guard.mjs --scan contracts/go-live-registry` exit 0 (0 error, 0 warn). Same for `apps/onboarding` and `tools`. The git-root scan exits 1 because `rules.mjs`, `evidence.mjs`, and `evidence.test.mjs` contain the patterns they detect. | none for this project | https://docs.arc.io/arc/references/evm-differences |
| G3 Mainnet configuration | pass | `apps/onboarding/src/config/networks.ts` selects chain 5042, `https://rpc.mainnet.arc.io`, `https://explorer.arc.io`, and viem `arc` when `VITE_NETWORK=mainnet`. USDC is `0x3600…0000` on both networks. 2026-10-20 `eth_chainId` on `https://rpc.mainnet.arc.io` returned `0x13b2` (5042). Testnet-only addresses in the collector output are the denylist in `evidence.mjs`, not addresses this app selects. | none | https://docs.arc.io/arc/references/rpc-endpoints |
| G4 Deploy path (Arc Studio is testnet only) and onchain re-check | unknown | `script/deploy.sh` simulates unless `--broadcast` is passed. https://docs.arc.io/ai/arc-studio-cli says "Arc Studio deploys to Arc testnet only" (page fetched 2026-10-20). No `broadcast/` record and no `.stable-build/project.json` `deployments[]`. The collector's fail is the sentence in `evidence.mjs` that describes an `arc-studio run` targeting mainnet; this repo does not do that. | After a human deploys, re-check `eth_getCode` on the registry and on `DemoProject`. | https://docs.arc.io/ai/arc-studio-cli |
| G5 Contract source verified on the explorer | unknown | No mainnet address exists to open. The deploy tutorial step 5.2 documents `--verifier-url https://explorer.testnet.arc.io/api/` only (fetched 2026-10-20). A mainnet verifier URL is not on that page. | After mainnet deploy, confirm verified source on https://explorer.arc.io. Mark the verifier URL UNVERIFIED until the explorer shows the match. | https://docs.arc.io/arc/tutorials/deploy-on-arc |
| G6 Fee floor (20 gwei) and fees shown in USDC | pass | `apps/onboarding/src/core/guard.ts` sets `maxFeePerGas` to the larger of 20 gwei and 2× base fee. Fee lines in `guide.ts` are USDC, 6 decimals. Gas ceiling uses 18-decimal native units and is not labeled ETH. https://docs.arc.io/arc/references/gas-and-fees still titles the 20 Gwei minimum as testnet and says values may change before mainnet launch (fetched 2026-10-20). The same docs' agent note says the mempool enforces a 20 Gwei floor. Live `eth_gasPrice` on mainnet was `0x5b80be9e8` (24.54185316 gwei). | none in code. Re-read the gas page before mainnet broadcast if the floor moves. | https://docs.arc.io/arc/references/gas-and-fees |
| G7 One USDC balance; ledger at 18 decimals | pass | The app reads ERC-20 `balanceOf` only (`apps/onboarding/src/chain/reader.ts`, `App.tsx`). It does not call `getBalance` and does not add the 18-decimal native view to the 6-decimal balance. There is no transfer ledger. Collector files that mention both views are `rules.mjs` and `evidence.mjs`. | none | https://docs.arc.io/arc/references/connect-to-arc |
| G8 Log reads: paging, emitter, retries | n/a | `GoLiveRegistry`, `DemoProject`, and the onboarding client do not call `eth_getLogs`. Docs fetched 2026-10-20: public `eth_getLogs` limit is 10,000 blocks, error `-32012` over that, page in steps of at most 9,999, and retry `-32014` near the head. | none unless a log reader is added | https://docs.arc.io/arc/references/rpc-endpoints |
| G9 Memo and Multicall3From are called by an EOA only | n/a | This project does not call Memo (`0x5294…e505`) or Multicall3From (`0x522f…47D0`). The collector fail is those addresses and smart-account words together in the guard and in `evidence.mjs`. | none | https://docs.arc.io/arc/concepts/transaction-memos |
| G10 EVM differences reviewed | pass | No `PREVRANDAO`, blob, or `SELFDESTRUCT` use in the registry or the app. Native value is rejected (`NativeValueRejected`). `register` is simulated with `eth_call` and `estimateGas` before `approve` (`reader.ts`). A blocklist revert would fail that simulation. | none | https://docs.arc.io/arc/references/evm-differences |
| G11 One-confirmation finality in the UX | pass | `reader.ts` waits with `confirmations: 1`. No N-of-M counter. The collector hit is the word Confirming inside `evidence.mjs`'s own status sentence. | none | https://docs.arc.io/integrate/wallets/transaction-lifecycle |
| G12 USDC to Stellar goes through CctpForwarder | n/a | No CCTP burn to domain 27 in this project. | none | https://developers.circle.com/cctp/references/stellar |
| G13 Operations: keys, monitoring, screening | unknown | No committed `.env` and no committed key material in the collector scan. Deploy and verifier keys are not in the repo. Who holds them, and who is alerted on failure, cannot be observed. This project does not screen addresses offchain. | Pedro: say where the deployer and verifier keys live (hardware wallet or KMS preferred), and who is paged when a send fails. | https://docs.arc.io/arc/references/contract-addresses |
| G14 Brand claims and program eligibility | fail | Affiliation and yield hits are prohibitions in the kit ("never write official", "no yield"), not claims by this product. Package name is `stable-build`. `gh repo view` on 2026-10-20: visibility PUBLIC (`https://github.com/pedro-pelicioni/stable-build`). Arc Microgrants round 2 ("Built with Arc Studio", deadline 2026-11-02 00:59 America/New_York) is not met: contracts are not yet written in Arc Studio, nothing is deployed on mainnet, there is no public app link, no mainnet USDC transfer, no `studio.arc.io/app/<id>` URL, and no demo video. | Build and test in Arc Studio from the spec, deploy with `deploy.sh`, host the app, send one real `register`, and publish the Studio URL, addresses, tx, and video. | https://dorahacks.io/hackathon/arc-microgrants-2/detail |

## Blockers

- G14: Arc Microgrants round 2 requirements are not met. The reference code is in this repo, and the Studio session, mainnet deploy, public app, USDC transfer, and video are still to do. Fix: run the Studio session from the prompt pack, then the human deploy and one real `register`.
- A signature of this file is blocked until G4, G5, and G13 are no longer `unknown` and G14 is no longer `fail`, or the human passes `--allow-partial` and says so in the submission. `n/a` does not set a bit. Passing gates here are G1, G2, G3, G6, G7, G10, and G11 (bitmap bits 0, 1, 2, 5, 6, 9, and 10).

## Open questions

- G4: there is no mainnet address yet. After deploy, what are the `GoLiveRegistry` and `DemoProject` addresses, and does `eth_getCode` return code for both?
- G5: is each mainnet contract verified on https://explorer.arc.io? The mainnet `--verifier-url` is UNVERIFIED.
- G13: who holds the deployer key and the verifier key, and who is alerted if a transaction fails? No offchain screening is in this project.
- G6 docs hedge: the gas-and-fees page still says the 20 Gwei minimum is the testnet value and may change before mainnet launch. Live `eth_gasPrice` on 2026-10-20 was above 20 gwei. Re-check before broadcast.
- Studio export to GitHub, and whether the Studio terminal is `arc-forge` or upstream Foundry, were not observed. Both stay UNVERIFIED.

## Programs

- Arc Microgrants round 2 ("Built with Arc Studio"): contracts written and tested in Arc Studio, deployed on Arc mainnet, a Studio-built app at a public link, at least one mainnet USDC transfer through the contract and the app, public repo, Studio project link, contract address and tx hash on explorer.arc.io, and a demo video - not met (public repo is met; the rest is not); deadline 2026-11-02 00:59 America/New_York (`valid_until` in `programs.json`). https://dorahacks.io/hackathon/arc-microgrants-2/detail
- Arc Microgrants round 1: applications closed 2026-10-14; `valid_until` 2026-10-21 is the decision date, not an open application. Not this submission.
- Encode London 2026: in-person hackathon, mainnet not required - unknown (no Arc track confirmed in the snapshot); `valid_until` 2026-10-23, and the data notes say the end date is UNVERIFIED. https://community.arc.io/public/events/encode-london-hackathon-and-conference-znntsye2lf
- Circle Developer Grants: rolling, mainnet not a hard requirement in the snapshot - unknown for this project; re-verify by 2027-01-04. https://www.circle.com/grant
- Arc Builders Fund: deck submission, mainnet not required in the snapshot - not met (no deck from this review); re-verify by 2027-01-04. The page is not an offer. https://www.arc.io/builders-fund

## How this was checked

- `node plugins/stable-build/skills/go-live/scripts/evidence.mjs --dir=/workspace --format=json` (exit 1, because the collector marks some gates `fail` before review)
- `node plugins/stable-build/scripts/guard.mjs --scan contracts/go-live-registry` (exit 0)
- `node plugins/stable-build/scripts/guard.mjs --scan apps/onboarding` (exit 0)
- `node plugins/stable-build/scripts/guard.mjs --scan tools` (exit 0)
- `gh repo view pedro-pelicioni/stable-build --json visibility` (visibility PUBLIC)
- RPC calls: `eth_chainId` `[]`, `eth_gasPrice` `[]`, `eth_call` `decimals()` and `eth_getCode` on `0x3600000000000000000000000000000000000000`, all against `https://rpc.mainnet.arc.io`. `ArcForkTest` used `createSelectFork` on that URL. No transaction was broadcast.
- Docs MCP queries: 0. The arc-docs MCP was not connected. Four public pages were fetched from docs.arc.io on 2026-10-20: gas-and-fees, rpc-endpoints, arc-studio-cli, and deploy-on-arc.

No saved language in `$STABLE_BUILD_HOME/config.json`. This report is in English, which is the language of the request.

Not affiliated with Circle. Not legal, financial or security-audit advice.

## Mainnet deploy commands (for the human to run)

Do not run these from an agent session. Do not put a key in a file, a `VITE_*` variable, or the command line. `deploy.sh` reads `STABLE_BUILD_DEPLOYER_KEY` from the environment and does not broadcast unless `--broadcast` is passed. On chain 5042 it also requires `STABLE_BUILD_MAINNET_CONFIRM` to be exactly `SEND REAL USDC`.

```sh
cd contracts/go-live-registry
arc-forge test --network arc
ARC_MAINNET_RPC=https://rpc.mainnet.arc.io arc-forge test --network arc --match-contract ArcForkTest
export STABLE_BUILD_DEPLOYER_KEY
export STABLE_BUILD_VERIFIER
export STABLE_BUILD_TREASURY
export STABLE_BUILD_FEE=30000
export STABLE_BUILD_MAINNET_CONFIRM='SEND REAL USDC'
bash script/deploy.sh --network mainnet
bash script/deploy.sh --network mainnet --broadcast
unset STABLE_BUILD_DEPLOYER_KEY
arc-cast code <registry> --rpc-url https://rpc.mainnet.arc.io
arc-cast code <demo-project> --rpc-url https://rpc.mainnet.arc.io
```

Arc Studio cannot do the mainnet step. https://docs.arc.io/ai/arc-studio-cli says it deploys to Arc testnet only.

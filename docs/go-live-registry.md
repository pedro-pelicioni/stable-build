# Go-live registry

A project that passes stable-build's 14 go-live gates can record a badge on Arc. The badge is a row in `GoLiveRegistry`. Anyone can recompute the EIP-712 digest from the project address, the chain id, the report hash, the gate bitmap, the expiry, the nonce and the fee, and check that the configured verifier signed it.

This repository does not deploy the contract, does not sign with a real key, and does not send USDC. Those steps are for the owner, on a machine they control. The go-live skill still never signs or broadcasts.

USDC facts below were checked against the docs and, where noted, against `https://rpc.mainnet.arc.io` on 2026-10-18:

- https://docs.arc.io/arc/references/contract-addresses
- https://docs.arc.io/arc/references/evm-differences
- https://docs.arc.io/arc/references/connect-to-arc
- https://docs.arc.io/arc/tutorials/install-arc-foundry
- https://docs.arc.io/ai/arc-studio-cli
- https://github.com/circlefin/arc-foundry

## What you still do by hand

Arc Studio deploys to testnet only. Mainnet is `arc-forge` with a key you hold. The grant also wants the contract written and tested inside Arc Studio, an app built in Studio that calls it, and one real mainnet transaction that moves USDC through the contract. This pull request is the reference implementation and the spec. It is not that submission.

1. Recreate the contract and the tests in Arc Studio (steps below) and record that session.
2. Deploy to Arc testnet, then to Arc mainnet, with the scripts in `contracts/go-live-registry/script/`.
3. Build a Studio app from `apps/onboarding/studio-ui-prompt.md` that calls `approve` and `register` against the deployed address. The reference client in `apps/onboarding` is that flow for local and testnet use. Regenerate the UI in Studio; this folder is not the Studio submission.
4. Send one real mainnet `register` that pulls a few cents of USDC through the contract.
5. Publish the app, the Studio URL, the contract address, the transaction hash on https://explorer.arc.io, and the video yourself.

## Data model

`GoLiveRegistry` stores one `Badge` per project address:

| Field | Type | Meaning |
|---|---|---|
| `project` | `address` | The contract the badge is about. It must have code at registration. |
| `chainId` | `uint256` | Must equal `block.chainid`. Arc mainnet is 5042. Arc testnet is 5042002. |
| `reportHash` | `bytes32` | `keccak256` of the exact bytes that were signed, normally `docs/go-live-report.md`. |
| `gates` | `uint16` | Bits 0..13. Bit 0 is G1. At least one bit must be set. Bits above 13 are rejected. `GATE_MASK` is `0x3FFF`. |
| `expiry` | `uint64` | Unix time. The signature is rejected when `block.timestamp` is greater than this. Equal is accepted. |
| `registeredAt` | `uint64` | `block.timestamp` at the successful call. |
| `registrant` | `address` | `msg.sender` of that call. The signature does not bind the caller. |
| `nonce` | `uint256` | Part of the signed payload. It is not a global counter. The same nonce may be used for another project, or again for this project when another signed field changes. |
| `fee` | `uint256` | 6-decimal base units signed by the verifier. `register` pulls this amount only when it equals the stored fee. |

A second successful `register` for the same project overwrites the badge and keeps the listing index. `usedDigest` stays set, so that exact payload cannot be replayed. There is no global nonce set: nonce 1 on one project does not block nonce 1 on another.

Views: `badgeOf(project)`, `hasBadge(project)`, `projectCount()`, `projectAt(index)`, `list(offset, limit)`. `list` caps `limit` at 50.

## EIP-712

Domain separator and struct hash use `abi.encode`, so `uint16 gates` and `uint64 expiry` are padded to 32 bytes.

```text
EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)
name = "GoLiveRegistry"
version = "1"
chainId = block.chainid of the registry
verifyingContract = the registry address

Registration(address project,uint256 chainId,bytes32 reportHash,uint16 gates,uint64 expiry,uint256 nonce,uint256 fee)
```

```text
digest = keccak256(0x1901 || domainSeparator || structHash)
```

The signature is 65 bytes, `r || s || v`. `s` must be in the lower half of the secp256k1 order. `v` must be 27 or 28. Values 0 and 1 are accepted as the same recovery ids. The contract uses `ecrecover` (OpenZeppelin is not a dependency). A high `s`, a bad length, or a zero address from `ecrecover` reverts with `BadSignature`.

The signer skips a nonce when the curve point's x is greater than or equal to the curve order, so `v` is never 29 or 30.

`hashRegistration` and `recoverSigner` are public and pure so a test, or a reader, can rebuild the digest without storing it.

The shared vector is `contracts/go-live-registry/test/vectors/registration.json`. The Solidity test and `tools/go-live-sign.mjs` both check it. The signer is Anvil's published account 0. That key is a public test key, not a secret, and it is not in the JSON file.

## Fee

The fee is an ERC-20 amount on the USDC interface at `0x3600000000000000000000000000000000000000`. That address is the same on testnet and mainnet. `decimals()` is 6. Checked with `eth_call` of `decimals()` on mainnet on 2026-10-18: the result was 6.

| Fee | Base units | USDC |
|---|---|---|
| Default | `10000` | 0.01 |
| Demo suggestion | `30000` | 0.03 |
| Maximum the owner may set | `10000000` | 10 |
| Zero | `0` | no pull |

`register` calls `transferFrom(msg.sender, treasury, signedFee)` on that address. `signedFee` is a calldata argument and a field of the signed struct. The call reverts with `FeeMismatch` unless `signedFee` equals the stored `fee`, whether the owner raised that fee or lowered it. That is an exact match, not a cap: a cap would still charge a different amount from the one the verifier signed. A `setFee` after signing makes the outstanding signature revert and does not burn its digest. The signature works again if the stored fee returns to the signed value, or the verifier signs the new fee. A revert from the token (allowance, balance, blocklist) is rethrown. A `false` return without a revert is `FeeTransferFailed`. Fee `0` skips the pull.

Native value is refused. `receive` and `fallback` revert with `NativeValueRejected`. There is no path that reads `msg.value`. Arc's native USDC view is 18 decimals and is the same balance as the ERC-20 view. Do not add the two, and do not pass an 18-decimal amount to `approve` or `transferFrom`.

The contract does not hold USDC. The fee goes to `treasury` in the same call.

On 2026-10-18, `eth_chainId` on `https://rpc.mainnet.arc.io` returned `0x13b2` (5042) and `eth_gasPrice` returned `0x4a82bf604` (20.0013225 gwei). The floor is 20 gwei. Leave the price to the client. If a transaction is underpriced, set the fee at or above the current base fee and at least 20 gwei. Do not hardcode a price under that floor.

## Admin

The owner is set in the constructor and moves with two steps: `transferOwnership`, then `acceptOwnership` from the pending account. There is no renounce.

The owner can:

- `setVerifier(address)` — the next signature must come from this address. Signatures that were already valid stay valid until they expire or are used, as long as the stored fee is still the signed fee. Rotate the key and use a short expiry when you rotate.
- `setFee(uint256)` — 6-decimal base units, at most `MAX_FEE`. Outstanding signatures revert with `FeeMismatch` until they are signed again for the new fee.
- `setTreasury(address)` — later fees go here. Past fees are already in the previous treasury.

Events: `OwnershipTransferStarted`, `OwnershipTransferred`, `VerifierSet`, `FeeSet`, `TreasurySet`, `Registered`.

## Threat model

The chain checks the signature, the code size, the expiry, the nonce, the digest, the chain id and the fee. It does not re-run the 14 gates. A verifier who signs a bitmap that does not match the report will still produce a badge. Checkers who care recompute `keccak256` of the report bytes and compare `reportHash`, then read `gates`.

| Risk | What the contract does |
|---|---|
| Replay of the same signature | `usedDigest`. The nonce is inside that digest. It is not tracked on its own. |
| Replay on another chain or another registry | Domain chain id and verifying contract, plus `chainId == block.chainid` |
| Malleable `s` | Rejected before `ecrecover` |
| EOA or empty address as the project | `project.code.length == 0` reverts with `NoCode` |
| Expired signature | `block.timestamp > expiry` |
| Caller is not the sponsor | Allowed. `registrant` is whoever pays. The badge is about `project`. |
| Verifier key copied | Owner calls `setVerifier`. Old unused signatures still work until expiry or use. |
| Owner raises or lowers the fee after signing | `FeeMismatch`. The call does not pull the new fee and does not consume the digest. |
| Owner key copied | Owner can change the verifier, the fee (up to 10 USDC) and the treasury. Changing the fee invalidates outstanding signatures. The contract has no USDC balance to take. |
| Fee token swapped for a fake | The USDC address is a constant, not a parameter. |
| Reentrancy from the token | Digest, nonce and badge are written before `transferFrom`. |
| Native USDC mixed with the 6-decimal fee | No payable success path. |
| Front-run of a pending registration | The first successful caller consumes the digest and pays the signed fee. |

`n/a` does not set a bit. The signer refuses to sign when any gate is missing, `fail` or `unknown`, or when no gate passed, unless you pass `--allow-partial`. `--allow-partial` means you accept a badge whose bitmap is not a full pass. Say that in the submission if you use it.

## Signer

`tools/go-live-sign.mjs` reads the report, or the go-live evidence collector, and prints a JSON payload. It does not broadcast.

```sh
node tools/go-live-sign.mjs \
  --report docs/go-live-report.md \
  --project 0xProject \
  --registry 0xRegistry \
  --chain-id 5042 \
  --expiry 1893456000 \
  --nonce 1 \
  --fee 30000
```

Set `STABLE_BUILD_VERIFIER_KEY` in the environment of that command. It is 32 bytes of hex. It is never written into the repo and never printed. A `VITE_*` variable that looks like a 32-byte key makes the process exit 2.

`--unsigned` prints the digest and the bitmap and does not read the key. `--from-evidence` takes gate statuses from `plugins/stable-build/skills/go-live/scripts/evidence.mjs`. The report file is still the hashed bytes when it exists. `--fee` is 6-decimal base units. The payload's `value` fields are `"0"`.

Exit 0 is a signature. Exit 1 is a blocked bitmap (the JSON is still printed, without a signature). Exit 2 is usage.

`approve.data` is the USDC `approve` calldata for the registry and the fee. `register.data` is `GoLiveRegistry.register`. Send `approve` first, then `register`, from the account that will be `msg.sender`. Both transactions use the ERC-20 amount, not native value.

## Tests

From `contracts/go-live-registry`, with Arc Foundry on `PATH`:

```sh
arc-forge test --network arc
```

Install the pinned release if you do not have it yet:

```sh
bash script/install-arc-foundry.sh "$HOME/.local/bin"
```

The tag defaults to `v0.8.0-2` (`STABLE_BUILD_FOUNDRY_TAG` overrides it). The script checks the release `.sha256` before it copies `arc-forge`, `arc-cast` and `arc-anvil`.

Unit tests use a mock ERC-20 etched at the USDC address. They cover the happy path, a bad signer, expiry, replay of the same digest, the same nonce on another project, an in-place re-registration, the wrong chain id, an address with no code, allowance and balance failures, a `false` return, a stored fee that no longer equals the signed fee, fee and verifier and treasury changes, owner gates, a zero fee, an empty report, out-of-range bitmaps, a malleable signature, a short `v`, native value, two-step ownership, and the shared vector.

The fork tests run only when `ARC_MAINNET_RPC` is set. They are skipped in CI.

```sh
ARC_MAINNET_RPC=https://rpc.mainnet.arc.io arc-forge test --network arc --match-contract ArcForkTest
```

On 2026-10-18 that command, with Arc Foundry `forge 1.7.1-dev` commit `d497beea7096ff2a8e583c8b307941f24a61b06b` (the v0.8.0-2 build), forked Arc mainnet and passed. The fork reported chain id 5042, code at the USDC address, `decimals() == 6`, and a `register` whose treasury balance increased by exactly `10000` base units. The registrant was funded with the `deal` cheatcode. No transaction was broadcast and no real USDC moved.

`arc-anvil` versus a plain anvil process: this suite did not start either one. `arc-forge test --network arc` ran the tests in-process. The Arc Foundry docs say a bare test command runs Ethereum rules, and the Arc docs say a plain anvil cannot reproduce Arc. A side-by-side against upstream Foundry was not run. Treat that comparison as UNVERIFIED. Use `arc-forge test --network arc` for this project. For a local chain, the documented command is `arc-anvil --network arc`.

Node checks, including the shared vector and the deploy-script guards:

```sh
npm test
```

## Deploy

Dry-run is the default. It talks to the RPC and does not send a transaction. `--broadcast` sends one. The script refuses `--broadcast` when `CI` or `GITHUB_ACTIONS` is set.

```sh
export STABLE_BUILD_DEPLOYER_KEY
export STABLE_BUILD_VERIFIER
export STABLE_BUILD_TREASURY
export STABLE_BUILD_FEE=30000
bash script/deploy.sh --network testnet
bash script/deploy.sh --network testnet --broadcast
```

Mainnet uses the same confirmation phrase as the payouts starter. The script and `MainnetConfirm` both require the exact string `SEND REAL USDC` on chain id 5042. Testnet does not. Any other chain id is refused.

```sh
export STABLE_BUILD_MAINNET_CONFIRM='SEND REAL USDC'
bash script/deploy.sh --network mainnet
bash script/deploy.sh --network mainnet --broadcast
```

The script deploys `DemoProject` and then `GoLiveRegistry`. The deployer becomes the owner. `STABLE_BUILD_VERIFIER` and `STABLE_BUILD_TREASURY` are addresses, not keys. Put the verifier key only in `STABLE_BUILD_VERIFIER_KEY` when you sign.

Do not pass `--private-key` on the command line. The Foundry script reads `STABLE_BUILD_DEPLOYER_KEY` from the environment.

A dry-run still estimates gas. An account with no USDC for gas can fail that estimate. Nothing is sent until `--broadcast`.

On 2026-10-18 a dry-run (no `--broadcast`) against both RPCs compiled `Deploy.s.sol` and stopped at "SIMULATION COMPLETE". Testnet (chain id 5042002) estimated about 51.25 gwei. Mainnet (chain id 5042) estimated about 41.5 gwei. Both are above the 20 gwei floor. Mainnet without `SEND REAL USDC` reverted in the script with `MainnetConfirmationRequired` and sent nothing. The mainnet estimator labeled the gas total "ETH" and the testnet estimator labeled it "USDC". Gas on Arc is USDC. That label difference is a tooling quirk of this run, not a second asset in the contract.

## Recreate this in Arc Studio

Studio's sandbox is a Vite and Foundry app. Solidity goes under `contracts/`. Studio deploys to testnet only (https://docs.arc.io/ai/arc-studio-cli). This agent did not log in to Arc Studio. Whether the Studio image already contains `arc-forge` is UNVERIFIED. Whether a judge treats a paste of this source as "written in Arc Studio" is also UNVERIFIED. The safer recording is a Studio session that implements this spec, with you comparing the result to `contracts/go-live-registry/src/GoLiveRegistry.sol`.

1. Sign in with `arc-studio login` on your own machine. Do not do that inside an agent session.
2. Create an app. In the workbench, add the contract, the mock and the tests from `contracts/go-live-registry/`, or ask Studio to implement this document and then diff.
3. In the Studio terminal, run the test command from the Tests section if `arc-forge` is the binary Studio provides. If the terminal only has upstream Foundry, that run does not count as Arc semantics.
4. Ask Studio to deploy to Arc testnet and to build the page from `apps/onboarding/studio-ui-prompt.md` (the reference client in `apps/onboarding` is the same flow). The page shows `badgeOf` and sends `approve` then `register`. Keep amounts in 6-decimal base units. The page must not set a native `value` on those calls.
5. Export or push the Studio project to GitHub. The submission wants the `https://studio.arc.io/app/<id>` URL.
6. Deploy the same source to mainnet with the Deploy section. Point the Studio app at that address and host the app yourself. Studio does not host apps.
7. Sign with `tools/go-live-sign.mjs` using your verifier key. Approve `30000` (0.03 USDC) on `0x3600…0000` for the registry, then send `register`. The treasury should be a second address you control so the transfer is visible. Confirm the receipt on https://explorer.arc.io and that `balanceOf` of the treasury increased by `30000`, not by an 18-decimal figure.
8. Optional: verify the source on the explorer. The deploy tutorial shows a testnet verifier URL. The mainnet URL `https://explorer.arc.io/api/` is inferred from that pattern and was not called. You can also submit the source on the explorer's verification page. Mark it UNVERIFIED until the explorer shows the match.

## UNVERIFIED

- Upstream Foundry was not run beside `arc-forge` on this suite. Do not treat a passing upstream run as evidence. Not compared on 2026-10-18.
- A standing `arc-anvil --network arc` process was not required for these tests and was not started. In-process `arc-forge test --network arc` passed, including the mainnet fork.
- `https://explorer.arc.io/api/` as the mainnet verifier URL is inferred, not requested.
- Arc Studio was not opened. Its Foundry binary and the grant's reading of "written in Arc Studio" were not confirmed. The reference client in `apps/onboarding` was not run against a deployed registry, and Studio was not asked to generate the page from `apps/onboarding/studio-ui-prompt.md`.
- EIP-2612 `permit` is not implemented. The demo is `approve` plus `register`.
- No mainnet deploy and no real USDC transfer have been made from this repository. The mainnet and testnet runs above were simulations.
- Arc Foundry's mainnet dry-run labeled the gas estimate "ETH" while the testnet dry-run labeled it "USDC" (2026-10-18, v0.8.0-2). The contract does not send native value.

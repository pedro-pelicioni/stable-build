# stable-build onboarding

[Leia em português](README.pt-BR.md)

Reference client for `register()` on `GoLiveRegistry`. It is a React, Vite and viem app. stable-build is a community project and is not affiliated with Circle.

## Why this folder

`apps/onboarding` sits next to the contract and the signer. The `new-app` starter is `payouts`, and `scaffold.mjs` copies that starter into other projects. This client calls `GoLiveRegistry`, reads the JSON from `go-live-sign.mjs`, and follows `studio-ui-prompt.md`. It is not a second starter.

## What it does

The page is a dark chat. A scripted guide runs with no model and no key. You connect an injected EIP-1193 wallet, switch to the configured Arc chain, and read the USDC balance from the ERC-20 at `0x3600…0000` (6 decimals). The native view of that balance uses 18 decimals and is not added here.

`+` loads the signed payload. The app reads `fee()` on the registry and stops with `FeeMismatch` when the signed fee differs. It then runs `eth_call` and `estimateGas`. You sign `approve` for the exact fee, then `register`. Both transactions use value `0`. `maxFeePerGas` is at least 20 gwei. The event line links the transaction, and the app reads `badgeOf` back.

On chain id 5042 the app asks you to type `SEND REAL USDC` and to set a fee cap before any transaction. `VITE_NETWORK=mainnet` keeps that gate even when `VITE_RPC_URL` points at a local fork.

USDC address, decimals and chain ids: [contract addresses](https://docs.arc.io/arc/references/contract-addresses), [EVM differences](https://docs.arc.io/arc/references/evm-differences), [connect to Arc](https://docs.arc.io/arc/references/connect-to-arc). RPC and explorer hosts: [RPC endpoints](https://docs.arc.io/arc/references/rpc-endpoints).

## Run locally on testnet

Node 22.12 or newer. An injected wallet (MetaMask, Rabby, or another EIP-1193 wallet). From the repo root:

```sh
cd apps/onboarding && npm ci && npm test && npm run dev
```

The dev server listens on `http://localhost:5173`. Copy `.env.example` to `.env` and set `VITE_REGISTRY_ADDRESS` to the testnet registry. Leave `VITE_NETWORK` as `testnet` (chain 5042002, `https://rpc.testnet.arc.io`).

Sign a payload on your machine. The key stays in `STABLE_BUILD_VERIFIER_KEY` and never in a `VITE_*` name. From the repo root, with addresses you control:

```sh
node tools/go-live-sign.mjs \
  --report docs/go-live-report.md \
  --project 0xProject \
  --registry 0xRegistry \
  --chain-id 5042002 \
  --expiry 1893456000 \
  --nonce 1 \
  --fee 10000
```

Replace `0xProject` and `0xRegistry` before you run it. `10000` is 0.01 USDC in 6-decimal base units. Attach the printed JSON with `+`. Testnet USDC is at https://faucet.circle.com.

## Run locally on an `arc-anvil` fork of mainnet

This forks public mainnet state. It does not broadcast. Chain id stays 5042, so the typed phrase still applies.

```sh
arc-anvil --network arc --fork-url https://rpc.mainnet.arc.io --port 8545
```

In another shell, from `apps/onboarding`:

```sh
VITE_NETWORK=mainnet VITE_RPC_URL=http://127.0.0.1:8545 VITE_REGISTRY_ADDRESS=0xRegistry npm run dev
```

Sign the payload with `--chain-id 5042` and the same registry address. The phrase is `SEND REAL USDC`. The explorer host for that network is `https://explorer.arc.io` (testnet: `https://explorer.testnet.arc.io`).

## Environment

| Name | Where | Meaning |
|---|---|---|
| `VITE_NETWORK` | browser bundle | `testnet` (default) or `mainnet` |
| `VITE_RPC_URL` | browser bundle | optional RPC; empty uses the public endpoint |
| `VITE_REGISTRY_ADDRESS` | browser bundle | `GoLiveRegistry` for that network |
| `VITE_CHAT_ENABLED` | browser bundle | `true` calls `/api/chat`; anything else keeps the scripted guide |
| `LLM_PROVIDER` | server | `openai` or `anthropic` |
| `LLM_BASE_URL` | server | optional; default is the provider's public API |
| `LLM_API_KEY` | server | model key; never a `VITE_*` name |
| `LLM_MODEL` | server | required when chat is on; no model is hardcoded |
| `ARC_RPC_URL` | server | optional RPC for `/api/chat`; the client cannot set it |

`vite dev` and `vite build` exit when a `VITE_*` value looks like a 32-byte key.

## Optional chat API

`/api/chat` is a Node handler for Vercel (`api/chat.ts`). `vite dev` mounts the same path. Tools are `get_balance`, `explain_step`, `simulate_tx`, `build_approve_tx`, `build_register_tx` and `get_registry_badge`. They read or prepare. They do not sign, and they do not accept calldata from the model. The page shows Sign only when the proposal matches the transaction it built locally. Missing `LLM_API_KEY` or `LLM_MODEL` responds with 503 and `fallback: true`, and the page uses the scripted guide.

`LLM_PROVIDER=openai` uses chat completions. `LLM_PROVIDER=anthropic` uses the Messages API. Set `LLM_BASE_URL` for another host that speaks the chosen provider's API. The key stays in the server environment.

`vercel.json` in this folder builds the Vite app. Point the Vercel project at `apps/onboarding`. Do not change the repo-root `vercel.json`: that file serves `site/`. This repository does not deploy this app.

## Tests

```sh
cd apps/onboarding && npm test
```

Vitest covers fee mismatch, the wrong chain, 6 vs 18 decimals, payload checks (digest, signature, value `0`), and the mainnet phrase and fee cap. CI job `onboarding` runs `npm ci`, `npm test`, `npm run build`, and `guard.mjs --scan`.

## Arc Studio

The owner regenerates the UI in Arc Studio from [`studio-ui-prompt.md`](studio-ui-prompt.md). Studio deploys contracts to testnet only ([Arc Studio CLI](https://docs.arc.io/ai/arc-studio-cli)). This folder is the reference client for the same flow: wallet, `approve`, `register`, explorer link, `badgeOf`. Paste the prompt into Studio yourself. This agent did not open Arc Studio.

## What this app does not do

It does not hold a verifier key, sign a payload, or broadcast. It does not send native value. It does not read `getBalance`. It does not mix 6-decimal ERC-20 amounts with 18-decimal native amounts.

## UNVERIFIED

The page was opened in a browser on the default testnet build. A new session, a scripted reply, an invalid JSON file, a signed payload with no wallet, the missing-wallet message, and the new-message pill were checked. At 390px the sidebar stacks above the chat. With `VITE_NETWORK=mainnet` the badge is Mainnet with a red outline. Nothing in that pass signed or broadcast.

- No wallet extension was used, so connect, switch, approve and register were not clicked through on a live chain.
- No transaction was broadcast, on testnet or on mainnet.
- `/api/chat` was not called against a live model.
- `arc-anvil` was not started in this change.
- Arc Studio was not opened, and the prompt was not pasted there.

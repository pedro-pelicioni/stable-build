# Go-live registry

`GoLiveRegistry` records a badge for a project that passed stable-build's 14 go-live gates. The spec, the Studio steps and the mainnet demo are in [docs/go-live-registry.md](../../docs/go-live-registry.md).

```sh
arc-forge test --network arc
```

```sh
bash script/install-arc-foundry.sh "$HOME/.local/bin"
```

```sh
bash script/deploy.sh --network testnet
```

The deploy script simulates until you pass `--broadcast`. Mainnet broadcast also needs `STABLE_BUILD_MAINNET_CONFIRM='SEND REAL USDC'`.

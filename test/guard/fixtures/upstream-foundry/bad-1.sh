#!/bin/sh
set -eu
curl -L https://foundry.paradigm.xyz | bash
foundryup
forge test -vvv
anvil --fork-url https://rpc.testnet.arc.io &

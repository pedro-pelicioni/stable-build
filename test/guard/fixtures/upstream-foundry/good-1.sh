#!/bin/sh
set -eu
# Arc Foundry, not upstream: arc-forge / arc-anvil / arc-cast
arc-forge test --network arc
arc-anvil --network arc &
arc-cast send "$COUNTER" "increment()" --account dev --rpc-url https://rpc.testnet.arc.io

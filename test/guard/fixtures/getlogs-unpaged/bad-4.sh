#!/bin/sh
set -eu
arc-cast logs --from-block 0 --address "$ESCROW" "Settled(uint256)" --rpc-url https://rpc.testnet.arc.io

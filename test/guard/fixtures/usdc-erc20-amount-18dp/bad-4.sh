#!/bin/sh
set -eu
# send 1 USDC through the ERC-20 interface
arc-cast send 0x3600000000000000000000000000000000000000 "transfer(address,uint256)" "$TO" \
  "$(arc-cast to-wei 1)" --rpc-url "$RPC_URL" --account dev

#!/bin/sh
set -eu
arc-cast send "$COUNTER" "increment()" --gas-price 25gwei --priority-gas-price 1gwei --rpc-url "$RPC_URL" --account dev

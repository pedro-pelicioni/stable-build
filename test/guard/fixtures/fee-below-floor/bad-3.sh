#!/bin/sh
set -eu
arc-cast send "$COUNTER" "increment()" --gas-price 1gwei --rpc-url "$RPC_URL" --account dev

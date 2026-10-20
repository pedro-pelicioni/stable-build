#!/usr/bin/env bash
# Dry-run GoLiveRegistry and DemoProject on Arc testnet or Arc mainnet.
# Nothing is sent unless you pass --broadcast.
#
#   bash script/deploy.sh --network testnet
#   bash script/deploy.sh --network testnet --broadcast
#   STABLE_BUILD_MAINNET_CONFIRM='SEND REAL USDC' bash script/deploy.sh --network mainnet --broadcast
#
# Reads STABLE_BUILD_DEPLOYER_KEY, STABLE_BUILD_VERIFIER and STABLE_BUILD_TREASURY.
# Optional STABLE_BUILD_FEE is 6-decimal USDC base units (default 10000 = 0.01 USDC).
# Gas price is left to the client. Do not pass a fee under 20 gwei.
# Refuses to broadcast when CI or GITHUB_ACTIONS is set.
set -euo pipefail

cd "$(dirname "$0")/.."

network="testnet"
broadcast=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --network)
      if [ "$#" -lt 2 ]; then
        echo "missing value for --network" >&2
        exit 2
      fi
      network=$2
      shift 2
      ;;
    --network=*)
      network=${1#--network=}
      shift
      ;;
    --broadcast)
      broadcast=1
      shift
      ;;
    -h | --help)
      echo "usage: bash script/deploy.sh [--network testnet|mainnet] [--broadcast]"
      exit 0
      ;;
    *)
      echo "unknown option: $1" >&2
      exit 2
      ;;
  esac
done

case "$network" in
  testnet) rpc="https://rpc.testnet.arc.io" ;;
  mainnet) rpc="https://rpc.mainnet.arc.io" ;;
  *)
    echo "network must be testnet or mainnet" >&2
    exit 2
    ;;
esac

if [ "$broadcast" -eq 1 ]; then
  if [ -n "${CI:-}" ] || [ -n "${GITHUB_ACTIONS:-}" ]; then
    echo "refusing to broadcast in CI" >&2
    exit 1
  fi
  if [ "$network" = "mainnet" ] && [ "${STABLE_BUILD_MAINNET_CONFIRM:-}" != "SEND REAL USDC" ]; then
    echo "mainnet broadcast requires STABLE_BUILD_MAINNET_CONFIRM='SEND REAL USDC'" >&2
    exit 1
  fi
fi

node --input-type=module -e '
for (const entry of Object.entries(process.env)) {
  const k = entry[0];
  const v = entry[1];
  if (k.startsWith("VITE_") && /^(0x)?[0-9a-fA-F]{64}$/.test(String(v ?? "").trim())) {
    console.error("refusing to run: " + k + " looks like a private key");
    process.exit(2);
  }
}
'

missing=0
for name in STABLE_BUILD_DEPLOYER_KEY STABLE_BUILD_VERIFIER STABLE_BUILD_TREASURY; do
  if [ -z "${!name:-}" ]; then
    echo "missing ${name}" >&2
    missing=1
  fi
done
if [ "$missing" -ne 0 ]; then
  exit 1
fi

key_hex=${STABLE_BUILD_DEPLOYER_KEY#0x}
key_hex=${key_hex#0X}
case "$key_hex" in
  *[!0-9a-fA-F]*)
    echo "STABLE_BUILD_DEPLOYER_KEY must be 32 bytes of hex" >&2
    exit 1
    ;;
esac
if [ "${#key_hex}" -ne 64 ]; then
  echo "STABLE_BUILD_DEPLOYER_KEY must be 32 bytes of hex" >&2
  exit 1
fi

if ! command -v arc-forge >/dev/null 2>&1; then
  echo "arc-forge is not on PATH. Run script/install-arc-foundry.sh" >&2
  exit 1
fi

args=(script script/Deploy.s.sol:DeployGoLiveRegistry --rpc-url "$rpc" --network arc)
if [ "$broadcast" -eq 1 ]; then
  args+=(--broadcast)
fi

exec arc-forge "${args[@]}"

import { defineChain, parseGwei, type Address, type Chain } from "viem";
import { arc, arcTestnet } from "viem/chains";

// USDC ERC-20 interface, 6 decimals. Same address on testnet and mainnet.
// Source: https://docs.arc.io/arc/references/contract-addresses
export const USDC: Address = "0x3600000000000000000000000000000000000000";

/** ERC-20 view. The native view of the same balance uses 18 decimals and is not read here. */
export const USDC_DECIMALS = 6;

/** Largest fee the registry owner may set: 10 USDC, in 6-decimal base units. */
export const MAX_FEE = 10_000_000n;

/** Bits 0..13. Bit 0 is G1. */
export const GATE_MASK = 0x3fff;

export const REGISTRY_NAME = "GoLiveRegistry";
export const REGISTRY_VERSION = "1";

export type NetworkName = "testnet" | "mainnet";

export interface NetworkConfig {
  name: NetworkName;
  label: string;
  chainId: number;
  chain: Chain;
  rpcUrl: string;
  explorerUrl: string;
}

// viem's built-in chain objects supply ids and the native currency (18-decimal gas units).
// RPC and explorer URLs come from the docs table, because viem's defaults differ.
// Source: https://docs.arc.io/arc/references/rpc-endpoints
const TESTNET_RPC = "https://rpc.testnet.arc.io";
const MAINNET_RPC = "https://rpc.mainnet.arc.io";
const TESTNET_EXPLORER = "https://explorer.testnet.arc.io";
const MAINNET_EXPLORER = "https://explorer.arc.io";

function withUrls(base: Chain, rpcUrl: string, explorerUrl: string, label: string): Chain {
  return defineChain({
    ...base,
    rpcUrls: { default: { http: [rpcUrl] } },
    blockExplorers: { default: { name: label, url: explorerUrl } },
  });
}

export function getNetwork(name: NetworkName, rpcOverride?: string): NetworkConfig {
  if (name === "mainnet") {
    const rpcUrl = rpcOverride || MAINNET_RPC;
    return {
      name,
      label: "Arc mainnet",
      chainId: 5042,
      chain: withUrls(arc, rpcUrl, MAINNET_EXPLORER, "Arc Explorer"),
      rpcUrl,
      explorerUrl: MAINNET_EXPLORER,
    };
  }
  const rpcUrl = rpcOverride || TESTNET_RPC;
  return {
    name: "testnet",
    label: "Arc Testnet",
    chainId: 5042002,
    chain: withUrls(arcTestnet, rpcUrl, TESTNET_EXPLORER, "Arc Testnet Explorer"),
    rpcUrl,
    explorerUrl: TESTNET_EXPLORER,
  };
}

/** Testnet unless the value is exactly "mainnet". */
export function resolveNetworkName(value: string | undefined | null): NetworkName {
  return value === "mainnet" ? "mainnet" : "testnet";
}

export function publicRpc(name: NetworkName): string {
  return name === "mainnet" ? MAINNET_RPC : TESTNET_RPC;
}

export function explorerTxUrl(network: NetworkConfig, hash: string): string {
  return `${network.explorerUrl}/tx/${hash}`;
}

/** Faucet for testnet USDC. Source: https://docs.arc.io/arc/references/rpc-endpoints */
export const FAUCET_URL = "https://faucet.circle.com";

/** Head and receipt polling. Arc makes about 2 blocks per second (rpc-endpoints page). */
export const POLLING_INTERVAL_MS = 250;

/** Text the operator must type before any mainnet send. */
export const MAINNET_CONFIRMATION = "SEND REAL USDC";

/** Minimum maxFeePerGas. Lower values are dropped and never get a receipt.
 * Source: https://docs.arc.io/arc/references/evm-differences */
export const FEE_FLOOR = parseGwei("20");

/** Small tip. The gas-and-fees page says 0 is accepted. */
export const PRIORITY_FEE = parseGwei("1");

export { looksLikePrivateKey } from "./env-guard";

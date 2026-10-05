import { defineChain, type Address, type Chain } from "viem";
import { arc, arcTestnet } from "viem/chains";

// Addresses are identical on Arc mainnet and Arc Testnet.
// Source: https://docs.arc.io/arc/references/contract-addresses
export const ADDRESSES = {
  /** USDC ERC-20 interface, 6 decimals. */
  USDC: "0x3600000000000000000000000000000000000000",
  /** System emitter of native USDC Transfer logs (EIP-7708), 18 decimals.
   * Source: https://docs.arc.io/arc/references/usdc-system-events */
  NATIVE_USDC_EMITTER: "0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE",
  /** Memo transaction extension. Source: https://docs.arc.io/arc/concepts/transaction-memos */
  MEMO: "0x5294E9927c3306DcBaDb03fe70b92e01cCede505",
  /** Multicall3From transaction extension. Source: https://docs.arc.io/arc/concepts/batched-transactions */
  MULTICALL3FROM: "0x522fAf9A91c41c443c66765030741e4AaCe147D0",
} as const satisfies Record<string, Address>;

export type NetworkName = "testnet" | "mainnet";

export interface NetworkConfig {
  name: NetworkName;
  label: string;
  chainId: number;
  chain: Chain;
  rpcUrl: string;
  explorerUrl: string;
}

// viem's built-in chain objects are used for ids and currency, but RPC and
// explorer URLs come from the docs table, because viem's defaults differ.
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

export function explorerTxUrl(network: NetworkConfig, hash: string): string {
  return `${network.explorerUrl}/tx/${hash}`;
}

export function explorerAddressUrl(network: NetworkConfig, address: string): string {
  return `${network.explorerUrl}/address/${address}`;
}

/** Faucet for testnet USDC. Source: https://docs.arc.io/arc/references/rpc-endpoints */
export const FAUCET_URL = "https://faucet.circle.com";

/** Head and receipt polling. Arc makes about 2 blocks per second (rpc-endpoints page). */
export const POLLING_INTERVAL_MS = 250;

/** Text the operator must type before any mainnet send. */
export const MAINNET_CONFIRMATION = "SEND REAL USDC";

/** Private-key shape check for VITE_* variables (see env-guard.ts). */
export { looksLikePrivateKey } from "./env-guard";

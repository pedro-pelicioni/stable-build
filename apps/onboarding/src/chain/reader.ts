import { createPublicClient, getAddress, http, zeroAddress, type Address, type Hex } from "viem";
import { registryAbi, usdcAbi } from "../config/abis";
import { POLLING_INTERVAL_MS, USDC, type NetworkConfig } from "../config/networks";
import type { Call } from "../core/reader";
import { assertErc20Decimals } from "../core/units";

export interface BadgeView {
  project: Address;
  chainId: bigint;
  reportHash: Hex;
  gates: number;
  expiry: bigint;
  registeredAt: bigint;
  registrant: Address;
  nonce: bigint;
  listed: boolean;
}

export interface Reader {
  chainId(): Promise<number>;
  /** ERC-20 `decimals()`. Throws when it is not 6. */
  decimals(): Promise<number>;
  /** ERC-20 `balanceOf`. Never the 18-decimal native balance. */
  balanceOf(account: Address): Promise<bigint>;
  fee(registry: Address): Promise<bigint>;
  badgeOf(registry: Address, project: Address): Promise<BadgeView>;
  baseFeePerGas(): Promise<bigint | null>;
  call(tx: Call): Promise<{ data: Hex }>;
  estimateGas(tx: Call): Promise<bigint>;
  /** One confirmation. Arc finality is one block. */
  wait(hash: Hex): Promise<void>;
}

type BadgeRaw = {
  project: Address;
  chainId: bigint;
  reportHash: Hex;
  gates: number;
  expiry: bigint;
  registeredAt: bigint;
  registrant: Address;
  nonce: bigint;
};

function asBadge(raw: BadgeRaw): BadgeView {
  const project = getAddress(raw.project);
  const registeredAt = BigInt(raw.registeredAt);
  return {
    project,
    chainId: BigInt(raw.chainId),
    reportHash: raw.reportHash,
    gates: Number(raw.gates),
    expiry: BigInt(raw.expiry),
    registeredAt,
    registrant: getAddress(raw.registrant),
    nonce: BigInt(raw.nonce),
    listed: project !== zeroAddress && registeredAt !== 0n,
  };
}

export function createReader(network: NetworkConfig): Reader {
  const client = createPublicClient({
    chain: network.chain,
    transport: http(network.rpcUrl),
    pollingInterval: POLLING_INTERVAL_MS,
  });
  return {
    chainId: () => client.getChainId(),
    async decimals() {
      const decimals = Number(await client.readContract({ address: USDC, abi: usdcAbi, functionName: "decimals" }));
      assertErc20Decimals(decimals);
      return decimals;
    },
    balanceOf: (account) => client.readContract({ address: USDC, abi: usdcAbi, functionName: "balanceOf", args: [account] }),
    fee: (registry) => client.readContract({ address: registry, abi: registryAbi, functionName: "fee" }),
    async badgeOf(registry, project) {
      const raw = await client.readContract({ address: registry, abi: registryAbi, functionName: "badgeOf", args: [project] });
      return asBadge(raw as BadgeRaw);
    },
    async baseFeePerGas() {
      const block = await client.getBlock();
      return block.baseFeePerGas ?? null;
    },
    async call(tx) {
      const res = await client.call({ account: tx.from, to: tx.to, data: tx.data, value: 0n });
      return { data: res.data ?? "0x" };
    },
    estimateGas: (tx) => client.estimateGas({ account: tx.from, to: tx.to, data: tx.data, value: 0n }),
    async wait(hash) {
      await client.waitForTransactionReceipt({ hash, confirmations: 1 });
    },
  };
}

import { parseGwei } from "viem";

export async function send(wallet: any, account: `0x${string}`, to: `0x${string}`, value: bigint, baseFee: bigint) {
  const floor = parseGwei("20");
  return wallet.sendTransaction({
    account,
    to,
    value,
    maxFeePerGas: baseFee * 2n > floor ? baseFee * 2n : floor,
    maxPriorityFeePerGas: 0n,
  });
}

export const defaults = { maxFeePerGas: parseGwei("20") };

import { parseGwei } from "viem";

export async function send(wallet: any, account: `0x${string}`, to: `0x${string}`, value: bigint) {
  return wallet.sendTransaction({
    account,
    to,
    value,
    maxFeePerGas: parseGwei("1"),
    maxPriorityFeePerGas: parseGwei("1"),
  });
}

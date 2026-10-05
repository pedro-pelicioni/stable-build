import { parseUnits } from "viem";

const MULTICALL3_FROM = "0x522fAf9A91c41c443c66765030741e4AaCe147D0";

export async function batch(wallet: any, account: `0x${string}`, abi: readonly unknown[], calls: unknown[]) {
  return wallet.writeContract({
    account,
    address: MULTICALL3_FROM,
    abi,
    functionName: "aggregate3",
    args: [calls],
    value: parseUnits("3", 18),
  });
}

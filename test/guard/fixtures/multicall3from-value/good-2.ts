// Canonical Multicall3 (not Multicall3From) does support aggregate3Value.
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";

export async function payAll(wallet: any, account: `0x${string}`, abi: readonly unknown[], calls: unknown[], total: bigint) {
  return wallet.writeContract({ account, address: MULTICALL3, abi, functionName: "aggregate3Value", args: [calls], value: total });
}

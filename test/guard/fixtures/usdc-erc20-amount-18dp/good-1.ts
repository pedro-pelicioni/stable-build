import { erc20Abi, parseUnits } from "viem";

const USDC_ADDRESS = "0x3600000000000000000000000000000000000000";

export async function pay(walletClient: any, account: `0x${string}`, to: `0x${string}`, amount: string) {
  return walletClient.writeContract({
    account,
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "transfer",
    args: [to, parseUnits(amount, 6)],
  });
}

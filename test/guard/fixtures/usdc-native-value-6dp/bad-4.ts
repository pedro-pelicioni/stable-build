import { parseUnits } from "viem";
const USDC_DECIMALS = 6;
export async function pay(wallet: any, to: `0x${string}`, amount: string) {
  return wallet.sendTransaction({ to, value: parseUnits(amount, USDC_DECIMALS) });
}

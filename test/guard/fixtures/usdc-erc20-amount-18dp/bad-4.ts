import { parseUnits } from "viem";
const NATIVE_DECIMALS = 18;
export async function pay(usdc: any, to: string, amount: string) {
  return usdc.write.transfer([to, parseUnits(amount, NATIVE_DECIMALS)]);
}

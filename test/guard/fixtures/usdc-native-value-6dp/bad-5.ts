import { parseUnits } from "viem";
export async function batch(wallet: any, rows: { to: `0x${string}`; amount: string }[]) {
  return wallet.sendCalls({ calls: rows.map((r) => ({ to: r.to, value: parseUnits(r.amount, 6) })) });
}

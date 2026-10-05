import { parseUnits } from "viem";

type Row = { recipient: `0x${string}`; amount: string };

// Payout rows: `value` is an ERC-20 amount (6 decimals) used later in USDC.transfer.
export function plan(rows: Row[]) {
  const transfers = rows.map((r) => ({ to: r.recipient, value: parseUnits(r.amount, 6) }));
  const totals: { value: bigint }[] = [];
  totals.push({ value: parseUnits("0", 6) });
  return { transfers, totals };
}

import { createPublicClient, http, formatUnits } from "viem";
import { arcTestnet } from "viem/chains";

const client = createPublicClient({ chain: arcTestnet, transport: http() });

// One balance, read once, scaled by 18 decimals.
export async function usdcBalance(address: `0x${string}`) {
  const wei = await client.getBalance({ address });
  return formatUnits(wei, 18);
}

export async function teamBalance(a: `0x${string}`, b: `0x${string}`) {
  const first = await client.getBalance({ address: a });
  const second = await client.getBalance({ address: b });
  return first + second;
}

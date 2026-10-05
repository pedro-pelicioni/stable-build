import { createPublicClient, http, erc20Abi, formatUnits } from "viem";
import { arcTestnet } from "viem/chains";

const client = createPublicClient({ chain: arcTestnet, transport: http() });
const USDC = "0x3600000000000000000000000000000000000000";

export async function totalUsdc(address: `0x${string}`) {
  const nativeWei = await client.getBalance({ address });
  const erc20Units = await client.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [address] });
  const total = nativeWei + erc20Units * 10n ** 12n;
  return formatUnits(total, 18);
}

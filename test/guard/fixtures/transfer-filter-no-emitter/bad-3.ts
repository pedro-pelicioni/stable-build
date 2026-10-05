import { createPublicClient, http, parseAbiItem } from "viem";
import { arcTestnet } from "viem/chains";

const client = createPublicClient({ chain: arcTestnet, transport: http() });
const USDC_ADDRESS = "0x3600000000000000000000000000000000000000";

// Only the ERC-20 emitter: plain native sends never show up here.
export async function received(to: `0x${string}`, fromBlock: bigint, toBlock: bigint) {
  return client.getLogs({
    address: USDC_ADDRESS,
    event: parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)"),
    args: { to },
    fromBlock,
    toBlock,
  });
}

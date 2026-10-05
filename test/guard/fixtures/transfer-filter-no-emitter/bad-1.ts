import { createPublicClient, http, parseAbiItem } from "viem";
import { arcTestnet } from "viem/chains";

const client = createPublicClient({ chain: arcTestnet, transport: http() });
const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

export async function incoming(to: `0x${string}`, fromBlock: bigint, toBlock: bigint) {
  return client.getLogs({ event: transferEvent, args: { to }, fromBlock, toBlock });
}

import { createPublicClient, http, parseAbiItem } from "viem";
import { arcTestnet } from "viem/chains";

const client = createPublicClient({ chain: arcTestnet, transport: http() });
const BADGES = "0x00000000000000000000000000000000000BAD6e";

// ERC-721 Transfer from one known contract: not a USDC stream.
export async function badgeMints(to: `0x${string}`, fromBlock: bigint, toBlock: bigint) {
  return client.getLogs({
    address: BADGES,
    event: parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)"),
    args: { to },
    fromBlock,
    toBlock,
  });
}

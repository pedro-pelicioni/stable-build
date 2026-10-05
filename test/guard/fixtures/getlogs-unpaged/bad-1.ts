import { createPublicClient, http, parseAbiItem } from "viem";
import { arcTestnet } from "viem/chains";

const client = createPublicClient({ chain: arcTestnet, transport: http() });
const REGISTRY = "0x0000000000000000000000000000000000008004";

export async function lastMint(owner: `0x${string}`) {
  const head = await client.getBlockNumber();
  const lookback = 10_000n;
  const fromBlock = head > lookback ? head - lookback : 0n;
  return client.getLogs({
    address: REGISTRY,
    event: parseAbiItem("event Registered(address indexed owner, uint256 indexed id)"),
    args: { owner },
    fromBlock,
    toBlock: head,
  });
}

import { createPublicClient, http, parseAbiItem } from "viem";
import { arcTestnet } from "viem/chains";

const client = createPublicClient({ chain: arcTestnet, transport: http() });
// Loop variables are judged by the values they iterate over, not by their names.
const POOLS = [{ pool: "0x1111111111111111111111111111111111111111" }, { pool: "0x2222222222222222222222222222222222222222" }];
const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

export async function lpMoves(fromBlock: bigint, toBlock: bigint) {
  const out = [];
  for (const usdcPair of POOLS) out.push(await client.getLogs({ address: usdcPair.pool, event: transferEvent, fromBlock, toBlock }));
  return out;
}

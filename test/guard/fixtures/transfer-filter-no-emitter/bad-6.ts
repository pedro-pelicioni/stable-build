import { createPublicClient, http, parseAbiItem } from "viem";
import { arcTestnet } from "viem/chains";

const client = createPublicClient({ chain: arcTestnet, transport: http() });
const USDC_ERC20 = "0x3600000000000000000000000000000000000000";
const NATIVE_EMITTER = "0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE";
const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

// Two separate queries, one per emitter: merging them counts each ERC-20 transfer twice.
export async function incoming(to: `0x${string}`, fromBlock: bigint, toBlock: bigint) {
  const [erc20, native] = await Promise.all([
    client.getLogs({ address: USDC_ERC20, event: transferEvent, args: { to }, fromBlock, toBlock }),
    client.getLogs({ address: NATIVE_EMITTER, event: transferEvent, args: { to }, fromBlock, toBlock }),
  ]);
  return [...erc20, ...native];
}

import { createPublicClient, http, parseAbiItem } from "viem";
import { arcTestnet } from "viem/chains";

const client = createPublicClient({ chain: arcTestnet, transport: http() });
const SOURCES = [{ address: "0x3600000000000000000000000000000000000000" }, { address: "0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE" }];
const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

export async function all(fromBlock: bigint, toBlock: bigint) {
  return Promise.all(SOURCES.map(({ address }) => client.getLogs({ address, event: transferEvent, fromBlock, toBlock })));
}

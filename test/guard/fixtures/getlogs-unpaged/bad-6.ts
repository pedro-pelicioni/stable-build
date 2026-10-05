import { createPublicClient, http, parseAbiItem } from "viem";
import { arcTestnet } from "viem/chains";

const client = createPublicClient({ chain: arcTestnet, transport: http() });
const NATIVE_EMITTER = "0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE";
const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const CHUNK = 10_000n;

// toBlock = from + CHUNK covers 10,001 blocks: the public RPC answers -32012.
export async function history(latest: bigint) {
  const out = [];
  for (let from = 0n; from <= latest; from += CHUNK + 1n) {
    out.push(...(await client.getLogs({ address: NATIVE_EMITTER, event: transferEvent, fromBlock: from, toBlock: from + CHUNK })));
  }
  return out;
}

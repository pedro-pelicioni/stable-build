import { createPublicClient, http, parseAbiItem } from "viem";
import { arcTestnet } from "viem/chains";

const client = createPublicClient({ chain: arcTestnet, transport: http() });
const NATIVE_EMITTER = "0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE";
const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
// Live regression (2026-10-04): pages of exactly 10,000 blocks (from + CHUNK - 1n) are accepted by the RPC.
const CHUNK = 10_000n;

export async function history(latest: bigint) {
  const out = [];
  for (let from = 0n; from <= latest; from += CHUNK) {
    const to = from + CHUNK - 1n < latest ? from + CHUNK - 1n : latest;
    out.push(...(await client.getLogs({ address: NATIVE_EMITTER, event: transferEvent, fromBlock: from, toBlock: to })));
  }
  return out;
}

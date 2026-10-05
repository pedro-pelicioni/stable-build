import { createPublicClient, formatUnits, http, parseAbiItem } from "viem";
import { arcTestnet } from "viem/chains";

const client = createPublicClient({ chain: arcTestnet, transport: http() });
// Live regression (2026-10-04): a loop over both emitters double counts every ERC-20 transfer.
const EMITTERS = [
  { label: "erc20", address: "0x3600000000000000000000000000000000000000", decimals: 6 },
  { label: "native", address: "0xffffFFFfFFffffffffffffffFfFFFfffFFfFFfFE", decimals: 18 },
] as const;
const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

export async function count(to: `0x${string}`, fromBlock: bigint, toBlock: bigint) {
  let n = 0;
  for (const emitter of EMITTERS) {
    const logs = await client.getLogs({ address: emitter.address, event: transferEvent, args: { to }, fromBlock, toBlock });
    for (const log of logs) { n++; console.log(formatUnits(log.args.value!, emitter.decimals)); }
  }
  return n;
}

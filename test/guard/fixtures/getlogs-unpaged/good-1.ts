import { createPublicClient, http, parseAbiItem } from "viem";
import { arcTestnet } from "viem/chains";

const client = createPublicClient({ chain: arcTestnet, transport: http() });
const STEP = 9_999n;
const MEMO = "0x5294E9927c3306DcBaDb03fe70b92e01cCede505";
const memoEvent = parseAbiItem("event BeforeMemo(uint256 indexed memoIndex)");

export async function memosSince(start: bigint) {
  const head = await client.getBlockNumber();
  const out = [];
  for (let from = start; from <= head; from += STEP) {
    const to = from + STEP - 1n > head ? head : from + STEP - 1n;
    out.push(...(await client.getLogs({ address: MEMO, event: memoEvent, fromBlock: from, toBlock: to })));
  }
  return out;
}

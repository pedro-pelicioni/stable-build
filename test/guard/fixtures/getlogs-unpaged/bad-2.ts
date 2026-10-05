import { createPublicClient, http, parseAbi } from "viem";
import { arcTestnet } from "viem/chains";

const client = createPublicClient({ chain: arcTestnet, transport: http() });
const MEMO = "0x5294E9927c3306DcBaDb03fe70b92e01cCede505";
const memoAbi = parseAbi(["event BeforeMemo(uint256 indexed memoIndex)"]);

export async function allMemos() {
  return client.getContractEvents({ address: MEMO, abi: memoAbi, eventName: "BeforeMemo", fromBlock: 0n });
}

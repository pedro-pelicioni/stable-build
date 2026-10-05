import { JsonRpcProvider } from "ethers";

const provider = new JsonRpcProvider("https://rpc.testnet.arc.io");
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export async function deposits(block: number) {
  return provider.getLogs({ topics: [TRANSFER_TOPIC], fromBlock: block, toBlock: block });
}

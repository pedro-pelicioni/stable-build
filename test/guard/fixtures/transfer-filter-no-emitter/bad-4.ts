import { JsonRpcProvider } from "ethers";

const provider = new JsonRpcProvider("https://rpc.testnet.arc.io");
const USDC_ADDRESS = "0x3600000000000000000000000000000000000000";
const NATIVE_USDC_EMITTER = "0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export async function everything(block: number) {
  return provider.getLogs({ address: [USDC_ADDRESS, NATIVE_USDC_EMITTER], topics: [TRANSFER_TOPIC], fromBlock: block, toBlock: block });
}

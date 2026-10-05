import { JsonRpcProvider } from "ethers";

const provider = new JsonRpcProvider("https://rpc.testnet.arc.io");
// Native USDC system emitter: every USDC movement, 18 decimals.
const NATIVE_USDC_EMITTER = "0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export async function deposits(block: number) {
  return provider.getLogs({ address: NATIVE_USDC_EMITTER, topics: [TRANSFER_TOPIC, null, null], fromBlock: block, toBlock: block });
}

import { JsonRpcProvider } from "ethers";

const provider = new JsonRpcProvider("https://rpc.testnet.arc.io");
const BATCH_SIZE = 1000;

export async function backfill(startBlock: number, endBlock: number, onLogs: (l: unknown[]) => Promise<void>) {
  for (let from = startBlock; from <= endBlock; from += BATCH_SIZE) {
    const to = Math.min(from + BATCH_SIZE - 1, endBlock);
    await onLogs(await provider.getLogs({ fromBlock: from, toBlock: to }));
  }
}

export async function oneBlock(blockNumber: number) {
  return provider.getLogs({ fromBlock: blockNumber, toBlock: blockNumber });
}

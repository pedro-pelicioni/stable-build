// Exactly 10,000 blocks (toBlock - fromBlock = 9,999) is accepted; the guard flags only larger ranges.
export async function edges(client: any, address: `0x${string}`, latestBlock: bigint) {
  const a = await client.getLogs({ address, fromBlock: 1_000_000n, toBlock: 1_009_999n });
  const b = await client.getLogs({ address, fromBlock: latestBlock - 9_999n, toBlock: latestBlock });
  return [...a, ...b];
}

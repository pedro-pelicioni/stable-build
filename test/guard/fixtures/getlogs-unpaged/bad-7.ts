export async function recent(client: any, address: `0x${string}`) {
  const latestBlock = await client.getBlockNumber();
  // latestBlock - 10000n to latestBlock is 10,001 blocks
  return client.getLogs({ address, fromBlock: latestBlock - 10000n, toBlock: latestBlock });
}

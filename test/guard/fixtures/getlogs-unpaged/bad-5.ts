export async function backfill(client: any, address: `0x${string}`) {
  return client.getLogs({ address, fromBlock: 1_000_000n, toBlock: 1_050_000n });
}

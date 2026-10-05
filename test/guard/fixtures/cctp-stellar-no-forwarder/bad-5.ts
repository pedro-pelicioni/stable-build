// viem write form: one array argument. No CctpForwarder anywhere in the file.
export function burnToStellar(tm: any, amount: bigint, recipientB32: `0x${string}`, usdc: `0x${string}`) {
  return tm.write.depositForBurn([amount, 27, recipientB32, usdc, recipientB32, 0n, 1000]);
}

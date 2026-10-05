// WAD (1e18) scaling used as a divisor gives a 6-decimal amount.
const WAD = 10n ** 18n;
export async function payShare(usdc: any, to: string, shares: bigint, price: bigint) {
  await usdc.write.transfer([to, (shares * price) / 10n ** 18n]);
  return usdc.write.transfer([to, (shares * price) / WAD]);
}

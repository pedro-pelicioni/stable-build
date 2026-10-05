// An ERC-2771 trusted forwarder is not the CCTP forwarder.
export const trustedForwarder = "0x0000000000000000000000000000000000000001";
export function burnToStellar(tm: any, amount: bigint, recipientB32: string, usdc: string) {
  return tm.depositForBurn(amount, 27, recipientB32, usdc, recipientB32, 0n, 1000);
}

// viem write form with CctpForwarder as both mintRecipient and destinationCaller.
const CCTP_FORWARDER_B32 = "0x" + "ab".repeat(32);
export function burn(tm: any, amount: bigint, usdc: `0x${string}`, hookData: `0x${string}`) {
  return tm.write.depositForBurnWithHook([amount, 27, CCTP_FORWARDER_B32, usdc, CCTP_FORWARDER_B32, 0n, 1000, hookData]);
}

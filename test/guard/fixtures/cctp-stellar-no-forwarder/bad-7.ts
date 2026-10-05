// The forwarder is only the destination caller; the user is the mint recipient (funds stuck).
const CCTP_FORWARDER = "0x" + "11".repeat(32);
export function burnArgs(amount: bigint, userBytes32: `0x${string}`, usdc: `0x${string}`, hookData: `0x${string}`) {
  return {
    functionName: "depositForBurnWithHook",
    args: [amount, 27, userBytes32, usdc, CCTP_FORWARDER, 0n, 1000, hookData],
  };
}

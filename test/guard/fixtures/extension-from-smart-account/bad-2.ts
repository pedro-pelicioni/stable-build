import Safe from "@safe-global/protocol-kit";

const MULTICALL3_FROM = "0x522fAf9A91c41c443c66765030741e4AaCe147D0";

export async function batchFromSafe(protocolKit: Safe, data: string) {
  const tx = await protocolKit.createTransaction({ transactions: [{ to: MULTICALL3_FROM, value: "0", data }] });
  return protocolKit.executeTransaction(tx);
}

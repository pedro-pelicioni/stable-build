import { parseAbi } from "viem";

const MULTICALL3_FROM = "0x522fAf9A91c41c443c66765030741e4AaCe147D0";
const abi = parseAbi([
  "struct Call3Value { address target; bool allowFailure; uint256 value; bytes callData; }",
  "function aggregate3Value(Call3Value[] calls) payable returns ((bool success, bytes returnData)[])",
]);

export async function payAll(wallet: any, account: `0x${string}`, calls: unknown[], total: bigint) {
  return wallet.writeContract({ account, address: MULTICALL3_FROM, abi, functionName: "aggregate3Value", args: [calls], value: total });
}

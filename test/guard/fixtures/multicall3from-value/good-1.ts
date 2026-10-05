import { encodeFunctionData, erc20Abi, parseUnits, parseAbi } from "viem";

const MULTICALL3_FROM = "0x522fAf9A91c41c443c66765030741e4AaCe147D0";
const USDC = "0x3600000000000000000000000000000000000000";
const abi = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "function aggregate3(Call3[] calls) returns ((bool success, bytes returnData)[])",
]);

export async function payAll(wallet: any, account: `0x${string}`, rows: { to: `0x${string}`; amount: string }[]) {
  const calls = rows.map((r) => ({
    target: USDC,
    allowFailure: false,
    callData: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [r.to, parseUnits(r.amount, 6)] }),
  }));
  return wallet.writeContract({ account, address: MULTICALL3_FROM, abi, functionName: "aggregate3", args: [calls] });
}

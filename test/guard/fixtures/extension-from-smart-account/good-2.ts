import { encodeFunctionData, erc20Abi, parseUnits } from "viem";
import { toCircleSmartAccount } from "@circle-fin/modular-wallets-core";

const USDC = "0x3600000000000000000000000000000000000000";

// Smart account paying a plain USDC transfer: no Memo or Multicall3From involved.
export async function pay(bundlerClient: any, client: any, owner: any, to: `0x${string}`, amount: string) {
  const account = await toCircleSmartAccount({ client, owner });
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, parseUnits(amount, 6)] });
  return bundlerClient.sendUserOperation({ account, calls: [{ to: USDC, data }] });
}

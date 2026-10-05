import { encodeFunctionData } from "viem";
import { toCircleSmartAccount } from "@circle-fin/modular-wallets-core";

const MEMO = "0x5294E9927c3306DcBaDb03fe70b92e01cCede505";

export async function payWithMemo(bundlerClient: any, owner: any, client: any, call: { data: `0x${string}` }) {
  const account = await toCircleSmartAccount({ client, owner });
  return bundlerClient.sendUserOperation({
    account,
    calls: [{ to: MEMO, data: call.data }],
  });
}

export const enc = encodeFunctionData;

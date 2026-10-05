import { createWalletClient, custom, encodeFunctionData, erc20Abi, parseUnits, parseAbi } from "viem";
import { arcTestnet } from "viem/chains";

const MEMO = "0x5294E9927c3306DcBaDb03fe70b92e01cCede505";
const USDC = "0x3600000000000000000000000000000000000000";
const memoAbi = parseAbi(["function memo(address target, bytes data, bytes32 memoId, bytes memoData)"]);

// Direct EOA transaction from a browser wallet: the supported path.
export async function payWithMemo(to: `0x${string}`, amount: string, memoId: `0x${string}`, memoData: `0x${string}`) {
  const wallet = createWalletClient({ chain: arcTestnet, transport: custom(window.ethereum) });
  const [account] = await wallet.getAddresses();
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, parseUnits(amount, 6)] });
  return wallet.writeContract({ account, address: MEMO, abi: memoAbi, functionName: "memo", args: [USDC, data, memoId, memoData] });
}

import { createWalletClient, custom, parseUnits, erc20Abi } from "viem";
import { arcTestnet } from "viem/chains";

const USDC = "0x3600000000000000000000000000000000000000";
const wallet = createWalletClient({ chain: arcTestnet, transport: custom(window.ethereum) });

export async function tipNative(to: `0x${string}`, amount: string) {
  const [account] = await wallet.getAddresses();
  return wallet.sendTransaction({ account, to, value: parseUnits(amount, 18) });
}

export async function tipErc20(to: `0x${string}`, amount: string) {
  const [account] = await wallet.getAddresses();
  return wallet.writeContract({
    account,
    address: USDC,
    abi: erc20Abi,
    functionName: "transfer",
    args: [to, parseUnits(amount, 6)],
  });
}

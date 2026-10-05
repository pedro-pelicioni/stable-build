import { createWalletClient, custom, parseUnits } from "viem";
import { arcTestnet } from "viem/chains";

const wallet = createWalletClient({ chain: arcTestnet, transport: custom(window.ethereum) });

// Pays a tip in native USDC, but builds the native value with the ERC-20 decimals.
export async function tip(to: `0x${string}`, amount: string) {
  const [account] = await wallet.getAddresses();
  return wallet.sendTransaction({
    account,
    to,
    value: parseUnits(amount, 6),
  });
}

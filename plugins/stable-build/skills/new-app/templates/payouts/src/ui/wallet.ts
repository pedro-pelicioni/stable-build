import { createWalletClient, custom, type Address, type EIP1193Provider, type WalletClient } from "viem";
import type { NetworkConfig } from "../config/networks";

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

export function injectedProvider(): EIP1193Provider | undefined {
  return typeof window === "undefined" ? undefined : window.ethereum;
}

/**
 * Connects an injected EIP-1193 wallet (MetaMask, Rabby, Coinbase Wallet, …).
 * Memo and Multicall3From need a plain EOA: transactions go out through
 * eth_sendTransaction. wallet_sendCalls (EIP-5792) is never used, because
 * wallets may route those calls through a smart account.
 * Source: https://docs.arc.io/arc/concepts/transaction-memos (Wallet types)
 */
export async function connectWallet(network: NetworkConfig): Promise<{ wallet: WalletClient; account: Address }> {
  const provider = injectedProvider();
  if (!provider) throw new Error("No browser wallet found. Install an EOA wallet such as MetaMask or Rabby.");
  const wallet = createWalletClient({ chain: network.chain, transport: custom(provider) });
  const [account] = await wallet.requestAddresses();
  if (!account) throw new Error("The wallet returned no account.");
  const chainId = await wallet.getChainId();
  if (chainId !== network.chainId) {
    try {
      await wallet.switchChain({ id: network.chainId });
    } catch {
      await wallet.addChain({ chain: network.chain });
      await wallet.switchChain({ id: network.chainId });
    }
  }
  return { wallet, account };
}

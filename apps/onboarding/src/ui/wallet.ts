import { createWalletClient, custom, getAddress, type Address, type EIP1193Provider, type Hex, type WalletClient } from "viem";
import { assertChain, WrongChain } from "../core/guard";
import type { NetworkConfig } from "../config/networks";
import type { UnsignedTx } from "../core/guard";

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

export function injectedProvider(): EIP1193Provider | undefined {
  return typeof window === "undefined" ? undefined : window.ethereum;
}

/**
 * Connects an injected EIP-1193 wallet and switches it to `network`.
 * The user signs later, in the wallet. This function only requests accounts.
 */
export async function connectWallet(network: NetworkConfig): Promise<{ wallet: WalletClient; account: Address; chainId: number }> {
  const provider = injectedProvider();
  if (!provider) throw new Error("No browser wallet found. Install an EIP-1193 wallet such as MetaMask or Rabby.");
  const wallet = createWalletClient({ chain: network.chain, transport: custom(provider) });
  const [account] = await wallet.requestAddresses();
  if (!account) throw new Error("The wallet returned no account.");
  let chainId = await wallet.getChainId();
  if (chainId !== network.chainId) {
    try {
      await wallet.switchChain({ id: network.chainId });
    } catch {
      await wallet.addChain({ chain: network.chain });
      await wallet.switchChain({ id: network.chainId });
    }
    chainId = await wallet.getChainId();
  }
  assertChain(chainId, network.chainId);
  return { wallet, account: getAddress(account), chainId };
}

/** Sends an unsigned transaction the app already built. Value stays 0. */
export async function sendPrepared(wallet: WalletClient, account: Address, tx: UnsignedTx): Promise<Hex> {
  if (tx.value !== 0n) throw new Error("refusing to send native value");
  return wallet.sendTransaction({
    account,
    chain: wallet.chain,
    to: tx.to,
    data: tx.data,
    value: 0n,
    maxFeePerGas: tx.maxFeePerGas,
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
    ...(tx.gas == null ? {} : { gas: tx.gas }),
  });
}

export function isWrongChain(err: unknown): err is WrongChain {
  return err instanceof WrongChain;
}

import { ethers } from "ethers";
// ethers contract filters carry the contract address (here EURC, not USDC).
export async function eurcIn(provider: ethers.providers.Provider, eurc: ethers.Contract, me: string, from: number, to: number) {
  const filter = eurc.filters.Transfer(null, me);
  return provider.getLogs({ ...filter, fromBlock: from, toBlock: to });
}

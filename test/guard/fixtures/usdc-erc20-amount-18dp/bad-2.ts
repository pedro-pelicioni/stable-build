import { ethers } from "ethers";

export async function allowRouter(usdc: ethers.Contract, router: string, amount: string) {
  const tx = await usdc.approve(router, ethers.parseUnits(amount, 18));
  return tx.wait();
}

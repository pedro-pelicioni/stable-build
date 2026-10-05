import { ethers } from "ethers";

// WETH on Arc is a bridged 18-decimal token, so parseEther is right here.
export async function sendWeth(weth: ethers.Contract, to: string, amount: string) {
  return weth.transfer(to, ethers.parseEther(amount));
}

export async function approveUsdc(usdc: ethers.Contract, spender: string, amount: string) {
  return usdc.approve(spender, ethers.parseUnits(amount, 6));
}

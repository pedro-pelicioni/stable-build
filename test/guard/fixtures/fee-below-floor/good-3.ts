import { ethers } from "ethers";

export async function send(signer: ethers.Signer, to: string) {
  return signer.sendTransaction({
    to,
    value: ethers.parseUnits("1", 18),
    maxFeePerGas: ethers.parseUnits("20", "gwei"),
    maxPriorityFeePerGas: ethers.parseUnits("1", "gwei"),
  });
}

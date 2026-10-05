import { ethers } from "ethers";

const MAX_FEE = 1_000_000_000n; // 1 gwei

export async function legacySend(signer: ethers.Signer, to: string) {
  await signer.sendTransaction({ to, value: 1n, gasPrice: ethers.parseUnits("5", "gwei") });
  await signer.sendTransaction({ to, value: 1n, maxFeePerGas: MAX_FEE });
}

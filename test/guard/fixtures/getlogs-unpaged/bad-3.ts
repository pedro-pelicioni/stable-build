import { ethers } from "ethers";

const DEPLOY_BLOCK = 1_250_000;

export async function history(escrow: ethers.Contract) {
  return escrow.queryFilter(escrow.filters.Settled(), DEPLOY_BLOCK, "latest");
}

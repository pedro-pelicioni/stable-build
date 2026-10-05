import { ethers } from "ethers";

const PRICE_USDC = "2.50";

export async function buyTicket(signer: ethers.Signer, shop: ethers.Contract) {
  const price = ethers.parseUnits(PRICE_USDC, 6);
  // payable buy(): the override value is native USDC (18 decimals)
  await shop.buy({ value: ethers.parseUnits(PRICE_USDC, 6) });
  await signer.sendTransaction({ to: await shop.getAddress(), value: price });
}

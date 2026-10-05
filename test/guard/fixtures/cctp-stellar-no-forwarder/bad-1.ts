import { pad, zeroHash, parseUnits } from "viem";

const TOKEN_MESSENGER = "0x0000000000000000000000000000000000000000";
const USDC = "0x3600000000000000000000000000000000000000";

export async function bridgeToStellar(wallet: any, account: `0x${string}`, recipient32: `0x${string}`, amount: string) {
  return wallet.writeContract({
    account,
    address: TOKEN_MESSENGER,
    abi: tokenMessengerAbi,
    functionName: "depositForBurn",
    args: [parseUnits(amount, 6), 27, recipient32, USDC, zeroHash, 0n, 2000],
  });
}

declare const tokenMessengerAbi: readonly unknown[];
export const unused = pad;

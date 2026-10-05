import { parseUnits, pad } from "viem";

const BASE_DOMAIN = 6;

export function burnToBase(recipient: `0x${string}`, amount: string) {
  return {
    amount: parseUnits(amount, 6),
    destinationDomain: BASE_DOMAIN,
    mintRecipient: pad(recipient),
  };
}

import { parseUnits, toHex } from "viem";

// EIP-3009 authorization: the typed-data `value` is the ERC-20 amount, 6 decimals.
export function authorization(from: `0x${string}`, to: `0x${string}`, amount: string, nonce: `0x${string}`) {
  return {
    primaryType: "TransferWithAuthorization" as const,
    message: {
      from,
      to,
      value: parseUnits(amount, 6),
      validAfter: 0n,
      validBefore: BigInt(Math.floor(Date.now() / 1000) + 3600),
      nonce,
    },
  };
}

export const field = { label: "Amount", value: parseUnits("1", 6), hint: toHex(1) };

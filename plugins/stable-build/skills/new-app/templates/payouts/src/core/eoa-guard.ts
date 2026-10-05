import { getAddress, type Address, type Hex } from "viem";

/**
 * Memo and Multicall3From must be called directly by an externally owned
 * account (EOA). Smart contract wallets, ERC-4337 accounts, multisig contract
 * wallets and any intermediary contract revert ("sender spoofing").
 * Sources: https://docs.arc.io/arc/concepts/transaction-memos (Wallet types)
 *          https://docs.arc.io/arc/concepts/batched-transactions (guardrails)
 *
 * Arc supports EIP-7702 set-code transactions
 * (https://docs.arc.io/arc/references/evm-differences). An EOA with a 7702
 * delegation has code 0xef0100 || address. How such an account behaves with
 * Memo/Multicall3From is UNVERIFIED, so this template refuses it.
 */
export type AccountKind = "eoa" | "eip7702-delegated" | "contract";

export const EIP7702_PREFIX = "0xef0100";

export class EoaGuardError extends Error {
  constructor(
    message: string,
    public readonly kind: AccountKind | "receipt-from-mismatch" | "wrong-chain",
  ) {
    super(message);
    this.name = "EoaGuardError";
  }
}

export function classifyCode(code: Hex | undefined | null): AccountKind {
  if (!code || code === "0x") return "eoa";
  if (code.toLowerCase().startsWith(EIP7702_PREFIX)) return "eip7702-delegated";
  return "contract";
}

export async function assertEoa(getCode: (address: Address) => Promise<Hex | undefined>, account: Address): Promise<void> {
  const kind = classifyCode(await getCode(account));
  if (kind === "eip7702-delegated")
    throw new EoaGuardError(
      `${account} has an EIP-7702 delegation (code starts with 0xef0100). Its behaviour with Memo and Multicall3From is unverified, so this app refuses it. Use a plain EOA.`,
      kind,
    );
  if (kind === "contract")
    throw new EoaGuardError(
      `${account} is a contract account. Memo and Multicall3From only accept a direct EOA caller; smart accounts and multisig contract wallets revert. Use a plain EOA.`,
      kind,
    );
}

export async function assertChain(getChainId: () => Promise<number>, expected: number): Promise<void> {
  const actual = await getChainId();
  if (actual !== expected) throw new EoaGuardError(`connected chain is ${actual}, expected ${expected}`, "wrong-chain");
}

/** After sending: the receipt must come from the paying account. */
export function assertReceiptFrom(receipt: { from: Address; transactionHash: Hex }, account: Address): void {
  if (getAddress(receipt.from) !== getAddress(account))
    throw new EoaGuardError(`receipt ${receipt.transactionHash} is from ${receipt.from}, expected ${account}`, "receipt-from-mismatch");
}

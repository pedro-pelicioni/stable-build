import type { Address } from "viem";
import type { NetworkConfig } from "../config/networks";
import { assertFeeMatch, assertSendable, feesFor, type MainnetGate, type UnsignedTx } from "./guard";
import type { ValidPayload } from "./payload";

export interface BuiltTx extends UnsignedTx {
  kind: "approve" | "register";
}

/** Unsigned approve of the exact signed fee. Throws FeeMismatch when the stored fee differs. */
export function buildApproveTx(payload: ValidPayload, storedFee: bigint, baseFeePerGas: bigint | null, gas: bigint | null = null): BuiltTx {
  assertFeeMatch(payload.fee, storedFee);
  if (!payload.approve) throw new Error("this payload has no fee to approve");
  const fees = feesFor(baseFeePerGas);
  return {
    kind: "approve",
    to: payload.approve.to,
    data: payload.approve.data,
    value: 0n,
    ...fees,
    ...(gas == null ? {} : { gas }),
  };
}

/** Unsigned register(). Value is 0. The fee moves inside the contract via transferFrom. */
export function buildRegisterTx(payload: ValidPayload, storedFee: bigint, baseFeePerGas: bigint | null, gas: bigint | null = null): BuiltTx {
  assertFeeMatch(payload.fee, storedFee);
  const fees = feesFor(baseFeePerGas);
  return {
    kind: "register",
    to: payload.register.to,
    data: payload.register.data,
    value: 0n,
    ...fees,
    ...(gas == null ? {} : { gas }),
  };
}

export function gateTx(network: NetworkConfig, tx: BuiltTx, fee: bigint, gate: MainnetGate): BuiltTx {
  assertSendable(network, tx, fee, gate);
  return tx;
}

export function sameCall(a: { to: Address; data: string; value: bigint | string }, b: { to: Address; data: string; value: bigint | string }): boolean {
  const valueOf = (v: bigint | string) => (typeof v === "bigint" ? v : BigInt(v));
  return a.to.toLowerCase() === b.to.toLowerCase() && a.data.toLowerCase() === b.data.toLowerCase() && valueOf(a.value) === valueOf(b.value) && valueOf(a.value) === 0n;
}

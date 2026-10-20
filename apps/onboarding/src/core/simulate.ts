import { BaseError, type Address, type Hex } from "viem";
import type { UnsignedTx } from "./guard";
import { feesFor } from "./guard";
import { registryErrorName, type ValidPayload } from "./payload";
import type { Call } from "./reader";
import type { Reader } from "../chain/reader";

export interface CallOutcome {
  ok: boolean;
  gas: bigint | null;
  revert: string | null;
  /** Set when the revert data is a GoLiveRegistry custom error. */
  registryError: string | null;
}

export interface Simulation {
  approve: CallOutcome | null;
  register: CallOutcome;
  /** The approve call succeeded and register still needs the allowance. */
  canApprove: boolean;
  /** register() succeeded in eth_call, so the user can sign it. */
  canRegister: boolean;
  note: string;
}

const GAS_HEADROOM_PERCENT = 120n;

function revertText(err: unknown): { message: string; data: Hex | null } {
  if (err instanceof BaseError) {
    const data = findHexData(err);
    return { message: err.shortMessage || err.message, data };
  }
  if (err instanceof Error) return { message: err.message, data: findHexData(err) };
  return { message: String(err), data: null };
}

function findHexData(err: unknown): Hex | null {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    const rec = cur as { data?: unknown; cause?: unknown };
    if (typeof rec.data === "string" && rec.data.startsWith("0x") && rec.data.length >= 10) return rec.data as Hex;
    cur = rec.cause;
  }
  return null;
}

async function probe(reader: Reader, tx: Call): Promise<CallOutcome> {
  try {
    await reader.call(tx);
  } catch (err) {
    const info = revertText(err);
    const registryError = registryErrorName(info.data);
    return { ok: false, gas: null, revert: info.message, registryError };
  }
  try {
    const gas = await reader.estimateGas(tx);
    return { ok: true, gas, revert: null, registryError: null };
  } catch (err) {
    const info = revertText(err);
    return { ok: false, gas: null, revert: info.message, registryError: registryErrorName(info.data) };
  }
}

/**
 * eth_call and estimateGas for approve (when the fee is non-zero) and register.
 * A registry custom error blocks both signatures. Any other register revert is treated
 * as the token pull (allowance, balance, blocklist): approve can still be offered.
 */
export async function simulateRegistration(reader: Reader, payload: ValidPayload, from: Address): Promise<Simulation> {
  const registerCall: Call = { to: payload.register.to, data: payload.register.data, from, value: 0n };
  const register = await probe(reader, registerCall);
  if (register.registryError) {
    return {
      approve: null,
      register,
      canApprove: false,
      canRegister: false,
      note: `register() reverted with ${register.registryError}`,
    };
  }
  if (register.ok) {
    return {
      approve: null,
      register,
      canApprove: false,
      canRegister: true,
      note: payload.fee === 0n ? "register() simulated with no fee" : "register() simulated; the allowance is already in place",
    };
  }
  if (payload.fee === 0n || !payload.approve) {
    return {
      approve: null,
      register,
      canApprove: false,
      canRegister: false,
      note: register.revert ?? "register() reverted",
    };
  }
  const approve = await probe(reader, { to: payload.approve.to, data: payload.approve.data, from, value: 0n });
  if (!approve.ok) {
    return {
      approve,
      register,
      canApprove: false,
      canRegister: false,
      note: approve.registryError ? `approve() reverted with ${approve.registryError}` : (approve.revert ?? "approve() reverted"),
    };
  }
  return {
    approve,
    register,
    canApprove: true,
    canRegister: false,
    note: "approve() simulated; register() still needs the allowance",
  };
}

export function withGas<T extends Omit<UnsignedTx, "gas">>(tx: T, gas: bigint | null): T {
  if (gas == null) return tx;
  return { ...tx, gas: (gas * GAS_HEADROOM_PERCENT) / 100n };
}

export function transactionFees(baseFeePerGas: bigint | null) {
  return feesFor(baseFeePerGas);
}

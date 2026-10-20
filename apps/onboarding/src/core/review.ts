import { getAddress, isAddress, type Address } from "viem";
import type { NetworkConfig } from "../config/networks";
import type { BadgeView, Reader } from "../chain/reader";
import { assertChain, assertFeeMatch, FeeMismatch } from "./guard";
import { PayloadError, parsePayload, type ValidPayload } from "./payload";
import { simulateRegistration, withGas, type Simulation } from "./simulate";
import { assertErc20Decimals } from "./units";
import { buildApproveTx, buildRegisterTx, type BuiltTx } from "./tx";

export type Phase = "connect" | "payload" | "approve" | "register" | "done" | "blocked";

export interface Review {
  payload: ValidPayload;
  storedFee: bigint;
  balance: bigint;
  simulation: Simulation;
  baseFeePerGas: bigint | null;
  approveTx: BuiltTx | null;
  registerTx: BuiltTx | null;
  blocked: string | null;
}

export class ReviewError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ReviewError";
    this.code = code;
  }
}

export function registryAddress(value: string | undefined | null): Address | null {
  if (!value || !isAddress(value)) return null;
  return getAddress(value);
}

/**
 * Validate the payload, compare its fee with the registry, and simulate.
 * Does not sign or send. A FeeMismatch, a wrong chain, or a bad decimals() view throws.
 */
export async function reviewPayload(args: {
  json: unknown;
  network: NetworkConfig;
  registry: Address;
  reader: Reader;
  account: Address;
}): Promise<Review> {
  const chainId = await args.reader.chainId();
  assertChain(chainId, args.network.chainId);
  assertErc20Decimals(await args.reader.decimals());

  let payload: ValidPayload;
  try {
    payload = await parsePayload(args.json, { chainId: args.network.chainId, registry: args.registry });
  } catch (err) {
    if (err instanceof PayloadError) throw new ReviewError(err.code, err.message);
    throw err;
  }

  const storedFee = await args.reader.fee(args.registry);
  try {
    assertFeeMatch(payload.fee, storedFee);
  } catch (err) {
    if (err instanceof FeeMismatch) throw new ReviewError("fee-mismatch", err.message);
    throw err;
  }

  const [balance, baseFeePerGas, simulation] = await Promise.all([
    args.reader.balanceOf(args.account),
    args.reader.baseFeePerGas(),
    simulateRegistration(args.reader, payload, args.account),
  ]);

  const approveTx = simulation.canApprove
    ? withGas(buildApproveTx(payload, storedFee, baseFeePerGas), simulation.approve?.gas ?? null)
    : null;
  const registerTx = simulation.canRegister
    ? withGas(buildRegisterTx(payload, storedFee, baseFeePerGas), simulation.register.gas)
    : null;

  return {
    payload,
    storedFee,
    balance,
    simulation,
    baseFeePerGas,
    approveTx,
    registerTx,
    blocked: simulation.canApprove || simulation.canRegister ? null : simulation.note,
  };
}

export async function readBadge(reader: Reader, registry: Address, project: Address): Promise<BadgeView> {
  return reader.badgeOf(registry, project);
}

export interface PhaseInput {
  account: Address | null;
  chainOk: boolean;
  payloadReady: boolean;
  /** A review ran for this payload. Until then the guide stays on the payload step. */
  reviewed: boolean;
  blocked: string | null;
  canApprove: boolean;
  canRegister: boolean;
  registered: boolean;
}

/** Where the scripted guide is, from facts the chain steps already established. */
export function derivePhase(input: PhaseInput): Phase {
  if (input.registered) return "done";
  if (!input.account || !input.chainOk) return "connect";
  if (!input.payloadReady || !input.reviewed) return "payload";
  if (input.blocked) return "blocked";
  if (input.canRegister) return "register";
  if (input.canApprove) return "approve";
  return "blocked";
}

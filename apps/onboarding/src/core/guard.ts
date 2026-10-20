import { parseUnits } from "viem";
import {
  FEE_FLOOR,
  MAINNET_CONFIRMATION,
  MAX_FEE,
  PRIORITY_FEE,
  USDC_DECIMALS,
  type NetworkConfig,
} from "../config/networks";

export class FeeMismatch extends Error {
  readonly signedFee: bigint;
  readonly storedFee: bigint;
  constructor(signedFee: bigint, storedFee: bigint) {
    super(`FeeMismatch: signed fee ${signedFee} does not equal the registry fee ${storedFee}`);
    this.name = "FeeMismatch";
    this.signedFee = signedFee;
    this.storedFee = storedFee;
  }
}

/** Exact match. A later setFee makes the signature revert until the stored fee is the signed fee. */
export function assertFeeMatch(signedFee: bigint, storedFee: bigint): void {
  if (signedFee !== storedFee) throw new FeeMismatch(signedFee, storedFee);
}

export class WrongChain extends Error {
  readonly chainId: number;
  readonly expected: number;
  constructor(chainId: number, expected: number) {
    super(`WrongChain: chain id ${chainId}, expected ${expected}`);
    this.name = "WrongChain";
    this.chainId = chainId;
    this.expected = expected;
  }
}

export function assertChain(chainId: number, expected: number): void {
  if (!Number.isInteger(chainId) || chainId !== expected) throw new WrongChain(chainId, expected);
}

export class GateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GateError";
  }
}

export interface MainnetGate {
  /** Must equal MAINNET_CONFIRMATION exactly. Ignored off mainnet. */
  confirmation?: string;
  /** Cap in USDC, 6 decimals, e.g. "0.05". Required on mainnet. */
  capUsdc?: string;
}

export interface UnsignedTx {
  to: `0x${string}`;
  data: `0x${string}`;
  value: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  gas?: bigint;
}

/** maxFeePerGas = max(20 gwei, 2 x baseFee). Gas is paid in native USDC units. */
export function feesFor(baseFeePerGas: bigint | null | undefined): { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } {
  const doubled = (baseFeePerGas ?? 0n) * 2n;
  const maxFeePerGas = doubled > FEE_FLOOR ? doubled : FEE_FLOOR;
  return { maxFeePerGas, maxPriorityFeePerGas: PRIORITY_FEE < maxFeePerGas ? PRIORITY_FEE : maxFeePerGas };
}

/** Parse a user cap. Up to 6 decimal places, no sign, no empty string. */
export function parseCapUsdc(capUsdc: string): bigint {
  const trimmed = capUsdc.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(trimmed)) throw new GateError("mainnet send refused: set a fee cap in USDC");
  return parseUnits(trimmed, USDC_DECIMALS);
}

/**
 * Mainnet sends need the typed phrase and a cap that covers the signed fee.
 * Testnet returns without reading either. Native value is refused on every network.
 */
export function assertSendable(network: NetworkConfig, tx: Pick<UnsignedTx, "value" | "maxFeePerGas">, fee: bigint, gate: MainnetGate = {}): void {
  if (tx.value !== 0n) throw new GateError("native value is refused; the fee moves through the ERC-20");
  if (tx.maxFeePerGas < FEE_FLOOR) throw new GateError("maxFeePerGas is below 20 gwei");
  if (fee < 0n || fee > MAX_FEE) throw new GateError(`fee ${fee} is outside 0..${MAX_FEE} base units`);
  if (network.name !== "mainnet") return;
  if (gate.confirmation !== MAINNET_CONFIRMATION) {
    throw new GateError(`mainnet send refused: type "${MAINNET_CONFIRMATION}" to confirm`);
  }
  const cap = parseCapUsdc(gate.capUsdc ?? "");
  if (fee > cap) throw new GateError(`mainnet send refused: fee is above the cap ${gate.capUsdc} USDC`);
}

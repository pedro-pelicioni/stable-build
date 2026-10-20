import { formatUnits } from "viem";
import { USDC_DECIMALS } from "../config/networks";

/** 6-decimal base units, grouped for display. `10000n` is `0.01`. */
export function formatErc20Usdc(baseUnits: bigint): string {
  return formatUnits(baseUnits, USDC_DECIMALS);
}

/**
 * The ERC-20 `decimals()` view must be 6. A different value means this is not the
 * USDC interface the registry pulls from. Do not scale it, and do not add it to a
 * native balance.
 */
export function assertErc20Decimals(decimals: number): void {
  if (decimals !== USDC_DECIMALS) {
    throw new DecimalsError(decimals);
  }
}

export class DecimalsError extends Error {
  readonly decimals: number;
  constructor(decimals: number) {
    super(`USDC decimals() returned ${decimals}; the ERC-20 interface uses 6. The native view is a different unit and is not added here.`);
    this.name = "DecimalsError";
    this.decimals = decimals;
  }
}

/** Gas ceiling in native units (18 decimals on Arc), shown apart from the ERC-20 fee. */
export function formatGasCeiling(gas: bigint, maxFeePerGas: bigint): string {
  return formatUnits(gas * maxFeePerGas, 18);
}

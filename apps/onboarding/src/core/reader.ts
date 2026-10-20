import type { Address, Hex } from "viem";

/** A read or a gas estimate. `value` is always 0. The fee is not native value. */
export interface Call {
  to: Address;
  data: Hex;
  from?: Address;
  value: 0n;
}

import type { Address, Hex } from "viem";
import type { BadgeView, Reader } from "../src/chain/reader";
import type { Call } from "../src/core/reader";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;

export function emptyBadge(project: Address = ZERO): BadgeView {
  return {
    project,
    chainId: 0n,
    reportHash: `0x${"00".repeat(32)}`,
    gates: 0,
    expiry: 0n,
    registeredAt: 0n,
    registrant: ZERO,
    nonce: 0n,
    listed: false,
  };
}

export interface FakeOptions {
  chainId?: number;
  decimals?: number;
  balance?: bigint;
  fee?: bigint;
  baseFee?: bigint | null;
  badge?: BadgeView;
  call?: (tx: Call) => Hex | Error;
  estimate?: (tx: Call) => bigint | Error;
}

/** In-memory chain. Records every method so tests can see that nothing is sent. */
export function fakeReader(options: FakeOptions = {}): { reader: Reader; calls: string[] } {
  const calls: string[] = [];
  const note = (name: string) => calls.push(name);
  const reader: Reader = {
    async chainId() {
      note("chainId");
      return options.chainId ?? 5042002;
    },
    async decimals() {
      note("decimals");
      return options.decimals ?? 6;
    },
    async balanceOf() {
      note("balanceOf");
      return options.balance ?? 1_000_000n;
    },
    async fee() {
      note("fee");
      return options.fee ?? 10_000n;
    },
    async badgeOf(_registry, project) {
      note("badgeOf");
      return options.badge ?? emptyBadge(project);
    },
    async baseFeePerGas() {
      note("baseFeePerGas");
      return options.baseFee === undefined ? 20_000_000_000n : options.baseFee;
    },
    async call(tx) {
      note("call");
      if (tx.value !== 0n) throw new Error("fake reader refused native value");
      const result = options.call ? options.call(tx) : "0x0000000000000000000000000000000000000000000000000000000000000001";
      if (result instanceof Error) throw result;
      return { data: result };
    },
    async estimateGas(tx) {
      note("estimateGas");
      if (tx.value !== 0n) throw new Error("fake reader refused native value");
      const result = options.estimate ? options.estimate(tx) : 80_000n;
      if (result instanceof Error) throw result;
      return result;
    },
    async wait() {
      note("wait");
    },
  };
  return { reader, calls };
}

import { decodeFunctionData, keccak256, parseGwei, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { memoAbi } from "../src/config/abis";
import { ADDRESSES } from "../src/config/networks";
import { parsePayoutCsv, type PayoutRow } from "../src/core/csv";
import { hexToString } from "viem";
import {
  DEFAULT_CHUNK_SIZE,
  FEE_FLOOR,
  chunkRows,
  decodeBatchInput,
  feesFor,
  planRow,
  planRows,
  preflight,
  sizeChunks,
  txFor,
  withHeadroom,
  type PlannedRow,
} from "../src/core/plan";
import { addr, loadFixture, memoFailed, revertError } from "./helpers";

const BATCH = "0x00112233445566778899aabbccddeeff" as const;
const rows = (n: number): PayoutRow[] =>
  Array.from({ length: n }, (_, i) => ({ index: i, line: i + 2, recipient: addr(`r${i}`), amount: "0.01", amount6: 10_000n, reference: `R-${i}` }));

describe("plan", () => {
  it("builds Memo.memo(USDC, transfer) per row with allowFailure false", () => {
    const [p] = planRows(parsePayoutCsv("recipient,amount,reference\n0x0Bcf6849b35cEA52FDfcCFD41166CE5dc4c51cE1,12.5,INV-1").rows, BATCH);
    expect(p.call.target).toBe(ADDRESSES.MEMO);
    expect(p.call.allowFailure).toBe(false);
    const m = decodeFunctionData({ abi: memoAbi, data: p.call.callData });
    expect(m.args[0]).toBe(ADDRESSES.USDC);
    expect(m.args[1]).toBe(p.transferData);
    expect(p.callDataHash).toBe(keccak256(p.transferData));
    expect(hexToString(m.args[3] as Hex)).toContain('"ref":"INV-1"');
    const [decoded] = decodeBatchInput(txFor([p], "batch").data);
    expect(decoded.memo).toMatchObject({ recipient: "0x0Bcf6849b35cEA52FDfcCFD41166CE5dc4c51cE1", amount6: 12_500_000n, memoId: p.memoId });
  });

  it("targets Multicall3From in batch mode and Memo in per-row mode", () => {
    const planned = planRows(rows(3), BATCH);
    expect(txFor(planned, "batch").to).toBe(ADDRESSES.MULTICALL3FROM);
    expect(decodeBatchInput(txFor(planned, "batch").data)).toHaveLength(3);
    expect(txFor([planned[0]], "per-row")).toEqual({ to: ADDRESSES.MEMO, data: planned[0].call.callData });
    expect(() => txFor(planned, "per-row")).toThrow(/exactly one row/);
  });

  it("decodes recorded testnet batches", () => {
    const thirteen = decodeBatchInput(loadFixture("receipt-batch-13rows.json").tx.input);
    expect(thirteen).toHaveLength(13);
    expect(thirteen.every((c) => c.target === ADDRESSES.MEMO && c.memo?.target === ADDRESSES.USDC && c.memo.amount6! > 0n)).toBe(true);
    const mixed = decodeBatchInput(loadFixture("receipt-batch-non-memo-calls.json").tx.input);
    expect(mixed.map((c) => (c.memo ? "memo" : "other"))).toEqual(["memo", "other", "memo", "other"]);
  });

  it("chunks", () => {
    expect(chunkRows([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(() => chunkRows([1], 0)).toThrow();
    expect(DEFAULT_CHUNK_SIZE).toBe(50);
  });

  it("never sets maxFeePerGas below the 20 gwei floor", () => {
    expect(feesFor(null).maxFeePerGas).toBe(FEE_FLOOR);
    expect(feesFor(parseGwei("5")).maxFeePerGas).toBe(parseGwei("20"));
    expect(feesFor(parseGwei("20")).maxFeePerGas).toBe(parseGwei("40"));
    expect(feesFor(parseGwei("20")).maxPriorityFeePerGas).toBe(parseGwei("1"));
    expect(withHeadroom(100n)).toBe(120n);
  });

  it("sizes chunks at 50 rows and halves when a chunk is too big", async () => {
    const planned = planRows(rows(120), BATCH);
    const estimate = async (r: PlannedRow[]) => 21_000n + 58_000n * BigInt(r.length);
    const big = await sizeChunks(planned, { simulate: async () => {}, estimate, blockGasLimit: 30_000_000n });
    expect(big.chunks.map((c) => c.rows.length)).toEqual([50, 50, 20]);
    const small = await sizeChunks(planned, { simulate: async () => {}, estimate, blockGasLimit: 4_000_000n });
    expect(Math.max(...small.chunks.map((c) => c.rows.length))).toBe(25);
    expect(small.chunks.every((c) => c.gas <= 2_000_000n)).toBe(true);
    expect(small.chunks.flatMap((c) => c.rows.map((r) => r.index))).toEqual(planned.map((r) => r.index));
    const failing = await sizeChunks(planned, {
      simulate: async () => {},
      estimate: async (r) => {
        if (r.length > 12) throw new Error("estimate failed");
        return estimate(r);
      },
      blockGasLimit: 30_000_000n,
    });
    expect(Math.max(...failing.chunks.map((c) => c.rows.length))).toBe(12);
  });

  it("isolates rows that revert in simulation and never sends them", async () => {
    const planned = planRows(rows(10), BATCH);
    const blocked = new Set([planned[3].recipient, planned[7].recipient]);
    const simulate = async (r: PlannedRow[]) => {
      if (r.some((x) => blocked.has(x.recipient))) throw revertError(memoFailed("Blacklistable: account is blacklisted"));
    };
    const out = await sizeChunks(planned, { simulate, estimate: async (r) => 58_000n * BigInt(r.length), blockGasLimit: 30_000_000n });
    expect(out.rejected.map((r) => r.row.index)).toEqual([3, 7]);
    expect(out.rejected[0].reason).toBe("MemoFailed: Blacklistable: account is blacklisted");
    expect(out.chunks.flatMap((c) => c.rows.map((r) => r.index))).toEqual([0, 1, 2, 4, 5, 6, 8, 9]);
  });

  it("per-row mode plans one row per transaction", async () => {
    const out = await sizeChunks(planRows(rows(3), BATCH), { simulate: async () => {}, estimate: async () => 60_000n, blockGasLimit: 30_000_000n, mode: "per-row" });
    expect(out.chunks.map((c) => c.rows.length)).toEqual([1, 1, 1]);
  });

  it("preflight uses the native 18-decimal balance only", () => {
    const planned = [planRow({ index: 0, line: 2, recipient: addr("x"), amount: "1", amount6: 1_000_000n, reference: "A" }, BATCH)];
    const p = preflight(planned, 100_000n, parseGwei("20"), 10n ** 18n);
    expect(p.payouts18).toBe(10n ** 18n);
    expect(p.fees18).toBe(100_000n * parseGwei("20"));
    expect(p.ok).toBe(false);
    expect(p.shortBy18).toBe(p.fees18);
    expect(preflight(planned, 100_000n, parseGwei("20"), 2n * 10n ** 18n).ok).toBe(true);
  });
});

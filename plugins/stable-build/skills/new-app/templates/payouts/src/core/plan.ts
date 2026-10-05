import { decodeFunctionData, encodeFunctionData, keccak256, parseGwei, type Address, type Hex } from "viem";
import { memoAbi, multicall3FromAbi, usdcAbi } from "../config/abis";
import { ADDRESSES } from "../config/networks";
import type { PayoutRow } from "./csv";
import { encodeMemo, memoIdFor, type BatchId } from "./memo-schema";
import { InsufficientBalanceError, isBalanceRevert, isRevertError, isTransientRpcError, revertReason } from "./rpc-errors";

/**
 * Per-row call:
 *   transferData = USDC.transfer(recipient, amount6)
 *   Call3 { target: Memo, allowFailure: false, callData: Memo.memo(USDC, transferData, memoId, memoBytes) }
 * A chunk is sent as Multicall3From.aggregate3(calls) by the paying EOA.
 *
 * Memo:           https://docs.arc.io/arc/concepts/transaction-memos
 * Multicall3From: https://docs.arc.io/arc/concepts/batched-transactions
 * The nesting Multicall3From -> Memo -> USDC is not described in the docs. It was
 * checked against live Arc Testnet receipts and eth_call; see docs/batch-memo-evidence.md.
 */
export interface Call3 {
  target: Address;
  allowFailure: boolean;
  callData: Hex;
}

export interface PlannedRow extends PayoutRow {
  memoId: Hex;
  memoBytes: Hex;
  transferData: Hex;
  callDataHash: Hex;
  call: Call3;
}

export type SendMode = "batch" | "per-row";

/** Starting chunk size. The right size for production is UNVERIFIED; the
 * spike estimated about 58k gas per row (test/fixtures/eth-call-results.json). */
export const DEFAULT_CHUNK_SIZE = 50;

/** Minimum maxFeePerGas: lower values are silently dropped by the mempool.
 * Source: https://docs.arc.io/arc/references/evm-differences (Fee market) and
 * https://docs.arc.io/arc/references/gas-and-fees */
export const FEE_FLOOR = parseGwei("20");
/** Small tip; the gas-and-fees page says 0 is accepted and ~1 gwei can help inclusion. */
export const PRIORITY_FEE = parseGwei("1");
/** Gas limit headroom over eth_estimateGas, in percent. */
export const GAS_HEADROOM_PERCENT = 120n;

export function planRow(row: PayoutRow, batchId: BatchId): PlannedRow {
  const transferData = encodeFunctionData({ abi: usdcAbi, functionName: "transfer", args: [row.recipient, row.amount6] });
  const memoId = memoIdFor(batchId, row.index);
  const memoBytes = encodeMemo(batchId, row.index, row.reference);
  const callData = encodeFunctionData({ abi: memoAbi, functionName: "memo", args: [ADDRESSES.USDC, transferData, memoId, memoBytes] });
  return {
    ...row,
    memoId,
    memoBytes,
    transferData,
    callDataHash: keccak256(transferData),
    call: { target: ADDRESSES.MEMO, allowFailure: false, callData },
  };
}

export function planRows(rows: PayoutRow[], batchId: BatchId): PlannedRow[] {
  return rows.map((row) => planRow(row, batchId));
}

/** Transaction request for one chunk (batch mode) or one row (per-row fallback). */
export function txFor(rows: PlannedRow[], mode: SendMode): { to: Address; data: Hex } {
  if (mode === "per-row") {
    if (rows.length !== 1) throw new Error("per-row mode sends exactly one row per transaction");
    return { to: ADDRESSES.MEMO, data: rows[0].call.callData };
  }
  return {
    to: ADDRESSES.MULTICALL3FROM,
    data: encodeFunctionData({ abi: multicall3FromAbi, functionName: "aggregate3", args: [rows.map((r) => r.call)] }),
  };
}

export interface DecodedBatchCall {
  target: Address;
  allowFailure: boolean;
  memo?: { target: Address; data: Hex; memoId: Hex; memoBytes: Hex; recipient?: Address; amount6?: bigint };
}

/** Inverse of txFor(batch): reads aggregate3 calldata back into rows. */
export function decodeBatchInput(input: Hex): DecodedBatchCall[] {
  const outer = decodeFunctionData({ abi: multicall3FromAbi, data: input });
  if (outer.functionName !== "aggregate3") throw new Error("not an aggregate3 call");
  return outer.args[0].map((call) => {
    const decoded: DecodedBatchCall = { target: call.target, allowFailure: call.allowFailure };
    if (call.target.toLowerCase() !== ADDRESSES.MEMO.toLowerCase()) return decoded;
    try {
      const m = decodeFunctionData({ abi: memoAbi, data: call.callData });
      if (m.functionName !== "memo") return decoded;
      const [target, data, memoId, memoBytes] = m.args;
      decoded.memo = { target, data, memoId, memoBytes };
      try {
        const t = decodeFunctionData({ abi: usdcAbi, data });
        if (t.functionName === "transfer") {
          decoded.memo.recipient = t.args[0];
          decoded.memo.amount6 = t.args[1];
        }
      } catch {
        // inner call is not an ERC-20 transfer
      }
    } catch {
      // not a Memo.memo call
    }
    return decoded;
  });
}

export function chunkRows<T>(items: T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new Error("chunk size must be a positive integer");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** maxFeePerGas = max(20 gwei, 2 x baseFee). Fees are paid in USDC (18 decimals). */
export function feesFor(baseFeePerGas: bigint | null | undefined): { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } {
  const doubled = (baseFeePerGas ?? 0n) * 2n;
  const maxFeePerGas = doubled > FEE_FLOOR ? doubled : FEE_FLOOR;
  return { maxFeePerGas, maxPriorityFeePerGas: PRIORITY_FEE < maxFeePerGas ? PRIORITY_FEE : maxFeePerGas };
}

export function withHeadroom(gas: bigint): bigint {
  return (gas * GAS_HEADROOM_PERCENT) / 100n;
}

export interface SizedChunk {
  rows: PlannedRow[];
  gas: bigint;
}

export interface RejectedRow {
  row: PlannedRow;
  reason: string;
}

export type Simulate = (rows: PlannedRow[]) => Promise<void>;
export type Estimate = (rows: PlannedRow[]) => Promise<bigint>;

/**
 * Classifies a failed simulation of `rows`. A revert caused by the row (bad recipient, blocklisted
 * address) returns its reason. Anything else is rethrown so the run stops and nothing is marked
 * rejected: an RPC outage (HTTP 5xx, timeout, rate limit after retries) says nothing about the row,
 * and a balance revert is about the payer.
 */
export function rowRevertReason(err: unknown): string {
  if (!isRevertError(err)) throw err;
  const reason = revertReason(err);
  if (isBalanceRevert(reason)) throw new InsufficientBalanceError(reason);
  return reason;
}

/**
 * Simulates rows one by one to find the ones that revert (bad recipient,
 * blocklisted address). Blocklisted transfers revert and still consume gas
 * when included, so they are never sent.
 * Source: https://docs.arc.io/arc/references/evm-differences (Value transfer rules)
 */
export async function isolateRejected(rows: PlannedRow[], simulate: Simulate): Promise<{ ok: PlannedRow[]; rejected: RejectedRow[] }> {
  const ok: PlannedRow[] = [];
  const rejected: RejectedRow[] = [];
  for (const row of rows) {
    try {
      await simulate([row]);
      ok.push(row);
    } catch (err) {
      rejected.push({ row, reason: rowRevertReason(err) });
    }
  }
  return { ok, rejected };
}

/**
 * Splits rows into chunks that simulate cleanly and fit under half the block
 * gas limit. Starts at `startSize`; halves a chunk whose estimate fails or is
 * too large; isolates reverting rows by simulating them one by one.
 */
export async function sizeChunks(
  rows: PlannedRow[],
  deps: { simulate: Simulate; estimate: Estimate; blockGasLimit: bigint; startSize?: number; mode?: SendMode },
): Promise<{ chunks: SizedChunk[]; rejected: RejectedRow[] }> {
  const mode = deps.mode ?? "batch";
  const startSize = mode === "per-row" ? 1 : (deps.startSize ?? DEFAULT_CHUNK_SIZE);
  const gasCap = deps.blockGasLimit / 2n;
  const chunks: SizedChunk[] = [];
  const rejected: RejectedRow[] = [];
  let queue = [...rows];
  let size = startSize;
  while (queue.length > 0) {
    const candidate = queue.slice(0, size);
    try {
      await deps.simulate(candidate);
    } catch (err) {
      if (candidate.length === 1) {
        rejected.push({ row: candidate[0], reason: rowRevertReason(err) });
        queue = queue.slice(1);
        continue;
      }
      if (!isRevertError(err)) throw err;
      const isolated = await isolateRejected(candidate, deps.simulate);
      rejected.push(...isolated.rejected);
      const bad = new Set(isolated.rejected.map((r) => r.row.index));
      queue = queue.filter((r) => !bad.has(r.index));
      if (isolated.rejected.length === 0) size = Math.max(1, Math.floor(candidate.length / 2));
      continue;
    }
    let gas: bigint | null = null;
    try {
      gas = await deps.estimate(candidate);
    } catch (err) {
      // RPC trouble says nothing about the rows: stop. Other estimate failures (a revert, or a chunk
      // too large to estimate) halve the chunk as before.
      if (isTransientRpcError(err)) throw err;
      gas = null;
    }
    if (gas !== null && gas <= gasCap) {
      chunks.push({ rows: candidate, gas });
      queue = queue.slice(candidate.length);
      continue;
    }
    if (candidate.length === 1) {
      rejected.push({ row: candidate[0], reason: gas === null ? "gas estimation failed" : `needs ${gas} gas, above half the block gas limit` });
      queue = queue.slice(1);
      continue;
    }
    size = Math.max(1, Math.floor(candidate.length / 2));
  }
  return { chunks, rejected };
}

export interface Preflight {
  /** Sum of payouts in native 18-decimal units. */
  payouts18: bigint;
  /** Upper bound on fees: sum of gas x maxFeePerGas, 18 decimals. */
  fees18: bigint;
  needed18: bigint;
  balance18: bigint;
  ok: boolean;
  shortBy18: bigint;
}

/** Balance check against the native balance only (eth_getBalance, 18 decimals).
 * The ERC-20 balanceOf view is the same money and is never added to it.
 * Source: https://docs.arc.io/integrate/wallets (One balance, two decimal views) */
export function preflight(rows: Pick<PlannedRow, "amount6">[], gasTotal: bigint, maxFeePerGas: bigint, balance18: bigint): Preflight {
  const payouts18 = rows.reduce((sum, r) => sum + r.amount6, 0n) * 10n ** 12n;
  const fees18 = gasTotal * maxFeePerGas;
  const needed18 = payouts18 + fees18;
  return { payouts18, fees18, needed18, balance18, ok: balance18 >= needed18, shortBy18: needed18 > balance18 ? needed18 - balance18 : 0n };
}

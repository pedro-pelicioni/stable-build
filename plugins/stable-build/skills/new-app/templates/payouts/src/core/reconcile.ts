import { decodeEventLog, encodeFunctionData, getAddress, keccak256, toEventSelector, type Address, type Hex, type Log, type TransactionReceipt } from "viem";
import { memoAbi, usdcAbi } from "../config/abis";
import { ADDRESSES } from "../config/networks";
import { decodeMemo, memoIdMatches, type DecodedMemo } from "./memo-schema";
import { BEFORE_MEMO_EVENT_TOPIC, MEMO_EVENT_TOPIC } from "./logs";

/**
 * Reconciliation inside one receipt.
 *
 * Memo emits BeforeMemo(k), then the target's events, then Memo(..., k), so the
 * logs between BeforeMemo(k) and Memo(k) belong to row k. Nested frames unwind
 * innermost first. Source: https://docs.arc.io/arc/concepts/transaction-memos
 *
 * A USDC ERC-20 transfer() emits two Transfer logs: 6 decimals from 0x3600… and
 * 18 decimals from the native system emitter. They are paired by
 * (from, to, value), never by position.
 * Source: https://docs.arc.io/arc/references/usdc-system-events
 */
export const TRANSFER_TOPIC = toEventSelector("Transfer(address,address,uint256)");
const SCALE_6_TO_18 = 10n ** 12n;

export interface ExpectedRow {
  index: number;
  memoId: Hex;
  recipient: Address;
  amount6: bigint;
  callDataHash: Hex;
}

export type CheckName =
  | "memoSender"
  | "memoTarget"
  | "transfer6"
  | "transfer18"
  | "callDataHash"
  | "memoV1"
  | "memoIdMatchesMemo"
  | "matchesPlan";

export interface ReconciledRow {
  txHash: Hex;
  blockNumber: bigint;
  memoId: Hex;
  memoIndex: bigint;
  memoLogIndex: number;
  sender: Address;
  target: Address;
  callDataHash: Hex;
  recipient?: Address;
  amount6?: bigint;
  amount18?: bigint;
  /** logIndex of the 6-decimal ERC-20 Transfer log. */
  transferLogIndex?: number;
  memo: DecodedMemo;
  expectedIndex?: number;
  checks: Partial<Record<CheckName, boolean>>;
  problems: string[];
  ok: boolean;
}

export interface ReceiptReconciliation {
  txHash: Hex;
  blockNumber: bigint;
  status: "success" | "reverted";
  fromMatches: boolean;
  /** Rows whose memoId is in the plan (or every memo row when no plan is given). */
  rows: ReconciledRow[];
  /** Memo rows in this receipt that are not part of the plan. */
  unexpected: ReconciledRow[];
  /** Planned rows with no Memo event in this receipt. */
  missing: ExpectedRow[];
  problems: string[];
}

interface Frame {
  memoIndex: bigint;
  logs: Log[];
}

interface TransferLog {
  emitter: "erc20" | "native";
  from: Address;
  to: Address;
  value: bigint;
  logIndex: number;
}

const same = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

export function transferCallData(recipient: Address, amount6: bigint): Hex {
  return encodeFunctionData({ abi: usdcAbi, functionName: "transfer", args: [recipient, amount6] });
}

function decodeTransfers(logs: Log[]): TransferLog[] {
  const out: TransferLog[] = [];
  for (const log of logs) {
    if (!same(log.topics[0], TRANSFER_TOPIC)) continue;
    const emitter = same(log.address, ADDRESSES.USDC) ? "erc20" : same(log.address, ADDRESSES.NATIVE_USDC_EMITTER) ? "native" : null;
    if (!emitter) continue;
    const ev = decodeEventLog({ abi: usdcAbi, eventName: "Transfer", data: log.data, topics: log.topics as [Hex, ...Hex[]] });
    out.push({ emitter, from: ev.args.from, to: ev.args.to, value: ev.args.value, logIndex: Number(log.logIndex) });
  }
  return out;
}

/** Splits receipt logs into Memo frames using the BeforeMemo/Memo bracket. */
export function memoWindows(logs: Log[]): { frame: Frame; memoLog: Log }[] {
  const sorted = [...logs].sort((a, b) => Number(a.logIndex) - Number(b.logIndex));
  const stack: Frame[] = [];
  const windows: { frame: Frame; memoLog: Log }[] = [];
  for (const log of sorted) {
    const fromMemo = same(log.address, ADDRESSES.MEMO);
    if (fromMemo && same(log.topics[0], BEFORE_MEMO_EVENT_TOPIC)) {
      stack.push({ memoIndex: BigInt(log.topics[1] as Hex), logs: [] });
      continue;
    }
    if (fromMemo && same(log.topics[0], MEMO_EVENT_TOPIC)) {
      const frame = stack.pop();
      if (frame) windows.push({ frame, memoLog: log });
      continue;
    }
    if (stack.length > 0) stack[stack.length - 1].logs.push(log);
  }
  return windows;
}

export function reconcileReceipt(
  receipt: Pick<TransactionReceipt, "transactionHash" | "blockNumber" | "status" | "from" | "logs">,
  opts: { account: Address; expected?: ExpectedRow[] },
): ReceiptReconciliation {
  const account = getAddress(opts.account);
  const expectedById = new Map((opts.expected ?? []).map((row) => [row.memoId.toLowerCase(), row]));
  const result: ReceiptReconciliation = {
    txHash: receipt.transactionHash,
    blockNumber: receipt.blockNumber,
    status: receipt.status === "success" ? "success" : "reverted",
    fromMatches: same(receipt.from, account),
    rows: [],
    unexpected: [],
    missing: [],
    problems: [],
  };
  if (!result.fromMatches) result.problems.push(`receipt.from ${receipt.from} is not the paying account ${account}`);
  if (result.status !== "success") {
    result.problems.push("transaction reverted; no row in it was paid");
    result.missing = [...expectedById.values()];
    return result;
  }

  const seen = new Set<string>();
  for (const { frame, memoLog } of memoWindows(receipt.logs)) {
    const ev = decodeEventLog({ abi: memoAbi, eventName: "Memo", data: memoLog.data, topics: memoLog.topics as [Hex, ...Hex[]] });
    const { sender, target, callDataHash, memoId, memo, memoIndex } = ev.args;
    const row: ReconciledRow = {
      txHash: receipt.transactionHash,
      blockNumber: receipt.blockNumber,
      memoId,
      memoIndex,
      memoLogIndex: Number(memoLog.logIndex),
      sender,
      target,
      callDataHash,
      memo: decodeMemo(memo),
      checks: {},
      problems: [],
      ok: false,
    };
    if (frame.memoIndex !== memoIndex) row.problems.push(`BeforeMemo(${frame.memoIndex}) closed by Memo(${memoIndex})`);
    row.checks.memoSender = same(sender, account) && result.fromMatches;
    if (!row.checks.memoSender) row.problems.push(`Memo.sender ${sender} is not the paying account`);
    row.checks.memoTarget = same(target, ADDRESSES.USDC);
    if (!row.checks.memoTarget) row.problems.push(`Memo.target ${target} is not USDC`);

    const expected = expectedById.get(memoId.toLowerCase());
    const transfers = decodeTransfers(frame.logs);
    const erc20 = transfers.filter((t) => t.emitter === "erc20");
    const native = transfers.filter((t) => t.emitter === "native");
    // Pair by (from, to, value): the ERC-20 log in 6 decimals and the native log in 18.
    const pairs: { t6: TransferLog; t18: TransferLog }[] = [];
    const used = new Set<TransferLog>();
    for (const t6 of erc20) {
      const t18 = native.find((n) => !used.has(n) && same(n.from, t6.from) && same(n.to, t6.to) && n.value === t6.value * SCALE_6_TO_18);
      if (t18) {
        used.add(t18);
        pairs.push({ t6, t18 });
      }
    }
    let chosen = expected
      ? pairs.find((p) => same(p.t6.from, account) && same(p.t6.to, expected.recipient) && p.t6.value === expected.amount6)
      : pairs.find((p) => same(p.t6.from, account));
    if (!chosen && pairs.length === 1) chosen = pairs[0];
    const t6 = chosen?.t6 ?? (expected ? erc20.find((t) => same(t.to, expected.recipient)) : erc20[0]);
    if (t6) {
      row.recipient = t6.to;
      row.amount6 = t6.value;
      row.amount18 = t6.value * SCALE_6_TO_18;
      row.transferLogIndex = t6.logIndex;
    }
    row.checks.transfer6 = !!t6 && same(t6.from, account);
    if (!t6) row.problems.push("no 6-decimal USDC Transfer inside this memo frame");
    else if (!row.checks.transfer6) row.problems.push(`USDC Transfer.from ${t6.from} is not the paying account`);
    row.checks.transfer18 = !!chosen && same(chosen.t18.from, account);
    if (!row.checks.transfer18) row.problems.push("no matching 18-decimal native Transfer (from, to, value x 1e12) inside this memo frame");
    row.checks.callDataHash = !!t6 && keccak256(transferCallData(t6.to, t6.value)).toLowerCase() === callDataHash.toLowerCase();
    if (!row.checks.callDataHash) row.problems.push("callDataHash does not match transfer(recipient, amount) seen in the logs");
    row.checks.memoV1 = row.memo.ok;
    if (!row.memo.ok) row.problems.push(`memo: ${row.memo.reason}`);
    row.checks.memoIdMatchesMemo = memoIdMatches(memoId, row.memo);
    if (row.memo.ok && !row.checks.memoIdMatchesMemo) row.problems.push("memoId does not match the batch id and row index in the memo");

    if (expected) {
      row.expectedIndex = expected.index;
      row.checks.matchesPlan =
        same(row.recipient, expected.recipient) &&
        row.amount6 === expected.amount6 &&
        callDataHash.toLowerCase() === expected.callDataHash.toLowerCase();
      if (!row.checks.matchesPlan) row.problems.push("recipient, amount or calldata differ from the plan");
      seen.add(memoId.toLowerCase());
    }
    row.ok = row.problems.length === 0;
    if (expected || expectedById.size === 0) result.rows.push(row);
    else result.unexpected.push(row);
  }
  result.missing = [...expectedById.values()].filter((row) => !seen.has(row.memoId.toLowerCase()));
  return result;
}

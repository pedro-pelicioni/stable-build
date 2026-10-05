import { formatUnits, keccak256, stringToHex, type Address, type Hex } from "viem";
import type { NetworkName } from "../config/networks";
import type { PayoutRow } from "./csv";
import { isBatchId, type BatchId } from "./memo-schema";
import type { PlannedRow, RejectedRow, SendMode } from "./plan";
import type { ExpectedRow, ReceiptReconciliation, ReconciledRow } from "./reconcile";

/**
 * Ledger: one JSON document per batch. Amounts are stored as integer strings in
 * native 18-decimal units (amount18), which is the precision Arc credits at.
 * Source: https://docs.arc.io/integrate/exchanges/deposits (Credit deposits at full precision)
 */
export const LEDGER_SCHEMA = "sb-payouts-ledger/1";

export type RowStatus = "planned" | "rejected" | "sent" | "paid" | "failed" | "mismatch";

export interface LedgerRow {
  index: number;
  line: number;
  recipient: Address;
  /** Decimal display amount, e.g. "12.5". */
  amount: string;
  /** Integer string, 18-decimal native units. */
  amount18: string;
  reference: string;
  memoId: Hex;
  callDataHash: Hex;
  status: RowStatus;
  txHash?: Hex;
  nonce?: number;
  blockNumber?: string;
  /** logIndex of the 6-decimal USDC Transfer log for this row. */
  logIndex?: number;
  memoIndex?: string;
  explorerUrl?: string;
  error?: string;
  updatedAt: string;
}

export interface Ledger {
  schema: typeof LEDGER_SCHEMA;
  network: NetworkName;
  chainId: number;
  account: Address;
  batchId: BatchId;
  mode: SendMode;
  /** keccak256 of the canonical rows; used to spot a re-uploaded file. */
  rowsDigest: Hex;
  /** Block height when the batch was created; history lookups start here. */
  startBlock: string;
  createdAt: string;
  updatedAt: string;
  rows: LedgerRow[];
}

const now = () => new Date().toISOString();
const SCALE = 10n ** 12n;

export function rowsDigest(rows: Pick<PayoutRow, "recipient" | "amount6" | "reference">[]): Hex {
  const canonical = rows.map((r) => `${r.recipient.toLowerCase()},${r.amount6.toString()},${r.reference}`).join("\n");
  return keccak256(stringToHex(canonical));
}

export function createLedger(input: {
  network: NetworkName;
  chainId: number;
  account: Address;
  batchId: BatchId;
  mode: SendMode;
  startBlock: bigint;
  rows: PlannedRow[];
}): Ledger {
  const t = now();
  return {
    schema: LEDGER_SCHEMA,
    network: input.network,
    chainId: input.chainId,
    account: input.account,
    batchId: input.batchId,
    mode: input.mode,
    rowsDigest: rowsDigest(input.rows),
    startBlock: input.startBlock.toString(),
    createdAt: t,
    updatedAt: t,
    rows: input.rows.map((r) => ({
      index: r.index,
      line: r.line,
      recipient: r.recipient,
      amount: r.amount,
      amount18: (r.amount6 * SCALE).toString(),
      reference: r.reference,
      memoId: r.memoId,
      callDataHash: r.callDataHash,
      status: "planned",
      updatedAt: t,
    })),
  };
}

export function amount6Of(row: Pick<LedgerRow, "amount18">): bigint {
  const v = BigInt(row.amount18);
  if (v % SCALE !== 0n) throw new Error(`amount18 ${row.amount18} is not a whole 6-decimal amount`);
  return v / SCALE;
}

export function expectedRows(ledger: Ledger, rows: LedgerRow[] = ledger.rows): ExpectedRow[] {
  return rows.map((r) => ({ index: r.index, memoId: r.memoId, recipient: r.recipient, amount6: amount6Of(r), callDataHash: r.callDataHash }));
}

/** Rows that may be (re)sent: never paid, never rejected, not waiting on a sent tx. */
export function pendingRows(ledger: Ledger): LedgerRow[] {
  return ledger.rows.filter((r) => r.status === "planned" || r.status === "failed");
}

export function unresolvedSentRows(ledger: Ledger): LedgerRow[] {
  return ledger.rows.filter((r) => r.status === "sent");
}

function touch(ledger: Ledger, mutate: (rows: LedgerRow[]) => void): Ledger {
  const rows = ledger.rows.map((r) => ({ ...r }));
  mutate(rows);
  return { ...ledger, rows, updatedAt: now() };
}

export function markRejected(ledger: Ledger, rejected: RejectedRow[]): Ledger {
  const reasons = new Map(rejected.map((r) => [r.row.index, r.reason]));
  return touch(ledger, (rows) => {
    for (const row of rows)
      if (reasons.has(row.index) && row.status !== "paid") {
        row.status = "rejected";
        row.error = reasons.get(row.index);
        row.updatedAt = now();
      }
  });
}

export function markSent(ledger: Ledger, indices: number[], txHash: Hex, explorerUrl: string, nonce?: number): Ledger {
  const set = new Set(indices);
  return touch(ledger, (rows) => {
    for (const row of rows)
      if (set.has(row.index)) {
        row.status = "sent";
        row.txHash = txHash;
        row.explorerUrl = explorerUrl;
        row.nonce = nonce;
        row.error = undefined;
        row.updatedAt = now();
      }
  });
}

/** Puts rejected rows back in the queue (all of them, or the given indices); they are simulated again
 * before anything is sent, so a row that still reverts is rejected again. */
export function requeueRejected(ledger: Ledger, indices?: number[]): Ledger {
  const only = indices ? new Set(indices) : null;
  return touch(ledger, (rows) => {
    for (const row of rows)
      if (row.status === "rejected" && (!only || only.has(row.index))) {
        row.status = "planned";
        row.error = undefined;
        row.updatedAt = now();
      }
  });
}

/** Returns rows to the queue (a sent transaction was dropped or replaced). */
export function markUnsent(ledger: Ledger, indices: number[], reason: string): Ledger {
  const set = new Set(indices);
  return touch(ledger, (rows) => {
    for (const row of rows)
      if (set.has(row.index) && row.status === "sent") {
        row.status = "failed";
        row.error = reason;
        row.updatedAt = now();
      }
  });
}

function applyRow(row: LedgerRow, rec: ReconciledRow, explorerTx: (hash: Hex) => string) {
  row.txHash = rec.txHash;
  row.explorerUrl = explorerTx(rec.txHash);
  row.blockNumber = rec.blockNumber.toString();
  row.memoIndex = rec.memoIndex.toString();
  row.logIndex = rec.transferLogIndex;
  row.status = rec.ok ? "paid" : "mismatch";
  row.error = rec.ok ? undefined : rec.problems.join("; ");
  row.updatedAt = now();
}

/** Applies one receipt's reconciliation. Rows found onchain become paid (or
 * mismatch); planned rows of a reverted transaction become failed. */
export function applyReconciliation(ledger: Ledger, rec: ReceiptReconciliation, explorerTx: (hash: Hex) => string): Ledger {
  const byId = new Map(rec.rows.map((r) => [r.memoId.toLowerCase(), r]));
  const missing = new Set(rec.missing.map((r) => r.memoId.toLowerCase()));
  return touch(ledger, (rows) => {
    for (const row of rows) {
      const found = byId.get(row.memoId.toLowerCase());
      if (found) applyRow(row, found, explorerTx);
      else if (missing.has(row.memoId.toLowerCase()) && row.txHash?.toLowerCase() === rec.txHash.toLowerCase()) {
        row.status = "failed";
        row.error = rec.status === "reverted" ? "transaction reverted" : "no Memo event for this row in its transaction";
        row.blockNumber = rec.blockNumber.toString();
        row.updatedAt = now();
      }
    }
  });
}

export interface LedgerSummary {
  count: number;
  byStatus: Record<RowStatus, number>;
  total18: string;
  paid18: string;
}

export function summarize(ledger: Ledger): LedgerSummary {
  const byStatus: Record<RowStatus, number> = { planned: 0, rejected: 0, sent: 0, paid: 0, failed: 0, mismatch: 0 };
  let total = 0n;
  let paid = 0n;
  for (const r of ledger.rows) {
    byStatus[r.status]++;
    total += BigInt(r.amount18);
    if (r.status === "paid") paid += BigInt(r.amount18);
  }
  return { count: ledger.rows.length, byStatus, total18: total.toString(), paid18: paid.toString() };
}

/** Formats an 18-decimal integer string or bigint as a USDC decimal string. */
export function formatUsdc18(value: string | bigint): string {
  return formatUnits(typeof value === "bigint" ? value : BigInt(value), 18);
}

const CSV_COLUMNS = [
  "index",
  "recipient",
  "amount",
  "amount18",
  "reference",
  "status",
  "txHash",
  "blockNumber",
  "logIndex",
  "memoIndex",
  "memoId",
  "explorerUrl",
  "error",
] as const;

function csvCell(value: unknown): string {
  const s = value === undefined || value === null ? "" : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function ledgerToCsv(ledger: Ledger): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const row of ledger.rows) lines.push(CSV_COLUMNS.map((c) => csvCell(row[c])).join(","));
  return lines.join("\n") + "\n";
}

export function ledgerToJson(ledger: Ledger): string {
  return JSON.stringify(ledger, null, 2) + "\n";
}

export function parseLedgerJson(text: string): Ledger {
  const value = JSON.parse(text) as Ledger;
  if (value?.schema !== LEDGER_SCHEMA) throw new Error(`not a ${LEDGER_SCHEMA} document`);
  if (!isBatchId(value.batchId)) throw new Error("ledger batchId is malformed");
  if (!Array.isArray(value.rows)) throw new Error("ledger rows are missing");
  for (const row of value.rows) {
    if (!/^\d+$/.test(row.amount18)) throw new Error(`row ${row.index}: amount18 must be an integer string`);
  }
  return value;
}

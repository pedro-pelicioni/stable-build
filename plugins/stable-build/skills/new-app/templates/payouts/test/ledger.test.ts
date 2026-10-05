import { describe, expect, it } from "vitest";
import { explorerTxUrl, getNetwork } from "../src/config/networks";
import { parsePayoutCsv } from "../src/core/csv";
import {
  LEDGER_SCHEMA,
  amount6Of,
  applyReconciliation,
  createLedger,
  expectedRows,
  formatUsdc18,
  ledgerToCsv,
  ledgerToJson,
  markRejected,
  markSent,
  parseLedgerJson,
  pendingRows,
  rowsDigest,
  summarize,
} from "../src/core/ledger";
import { planRows } from "../src/core/plan";
import { reconcileReceipt } from "../src/core/reconcile";
import { addr, synthReceipt } from "./helpers";

const ACCOUNT = addr("payer");
const BATCH = "0xfedcba9876543210fedcba9876543210" as const;
const csv = `recipient,amount,reference\n${addr("a")},0.01,A-1\n${addr("b")},1234.567891,A-2\n${addr("c")},2,"A-3"`;
const rows = parsePayoutCsv(csv).rows;
const planned = planRows(rows, BATCH);
const fresh = () => createLedger({ network: "testnet", chainId: 5042002, account: ACCOUNT, batchId: BATCH, mode: "batch", startBlock: 100n, rows: planned });
const explorer = (h: string) => explorerTxUrl(getNetwork("testnet"), h);

describe("ledger", () => {
  it("stores amounts as 18-decimal integer strings", () => {
    const l = fresh();
    expect(l.schema).toBe(LEDGER_SCHEMA);
    expect(l.rows.map((r) => r.amount18)).toEqual(["10000000000000000", "1234567891000000000000", "2000000000000000000"]);
    expect(l.rows.map(amount6Of)).toEqual([10_000n, 1_234_567_891n, 2_000_000n]);
    expect(formatUsdc18(l.rows[1].amount18)).toBe("1234.567891");
    expect(summarize(l)).toMatchObject({ count: 3, total18: "1236577891000000000000", paid18: "0" });
    expect(l.rowsDigest).toBe(rowsDigest(rows));
  });

  it("applies a reconciled receipt: paid rows get tx, block, logIndex and memoIndex", () => {
    let l = fresh();
    const hash = `0x${"11".repeat(32)}` as const;
    l = markSent(l, [0, 1, 2], hash, explorer(hash), 7);
    expect(pendingRows(l)).toEqual([]);
    const receipt = synthReceipt({ from: ACCOUNT, rows: planned, hash, blockNumber: 123n, memoIndexStart: 40n });
    l = applyReconciliation(l, reconcileReceipt(receipt, { account: ACCOUNT, expected: expectedRows(l) }), explorer);
    expect(l.rows.map((r) => r.status)).toEqual(["paid", "paid", "paid"]);
    expect(l.rows[1]).toMatchObject({ txHash: hash, blockNumber: "123", memoIndex: "41", logIndex: 6, nonce: 7, explorerUrl: explorer(hash) });
    expect(summarize(l).paid18).toBe(summarize(l).total18);
  });

  it("returns rows of a reverted transaction to the queue as failed", () => {
    const hash = `0x${"22".repeat(32)}` as const;
    let l = markSent(fresh(), [0, 1], hash, explorer(hash));
    const receipt = synthReceipt({ from: ACCOUNT, rows: planned.slice(0, 2), hash, blockNumber: 5n, status: "reverted" });
    l = applyReconciliation(l, reconcileReceipt(receipt, { account: ACCOUNT, expected: expectedRows(l) }), explorer);
    expect(l.rows.map((r) => r.status)).toEqual(["failed", "failed", "planned"]);
    expect(pendingRows(l).map((r) => r.index)).toEqual([0, 1, 2]);
  });

  it("never re-queues rejected rows", () => {
    const l = markRejected(fresh(), [{ row: planned[1], reason: "MemoFailed: blocked" }]);
    expect(l.rows[1]).toMatchObject({ status: "rejected", error: "MemoFailed: blocked" });
    expect(pendingRows(l).map((r) => r.index)).toEqual([0, 2]);
  });

  it("exports CSV and JSON and validates imports", () => {
    const l = fresh();
    const out = ledgerToCsv(l).trim().split("\n");
    expect(out[0]).toBe("index,recipient,amount,amount18,reference,status,txHash,blockNumber,logIndex,memoIndex,memoId,explorerUrl,error");
    expect(out).toHaveLength(4);
    expect(out[2]).toContain(",1234.567891,1234567891000000000000,A-2,planned,");
    expect(parseLedgerJson(ledgerToJson(l))).toEqual(l);
    expect(() => parseLedgerJson("{}")).toThrow(/sb-payouts-ledger/);
    const bad = JSON.parse(ledgerToJson(l));
    bad.rows[0].amount18 = "0.01";
    expect(() => parseLedgerJson(JSON.stringify(bad))).toThrow(/integer string/);
  });
});

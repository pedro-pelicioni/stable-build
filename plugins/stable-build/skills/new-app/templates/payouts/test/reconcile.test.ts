import { getAddress, type TransactionReceipt } from "viem";
import { describe, expect, it } from "vitest";
import { ADDRESSES } from "../src/config/networks";
import { assertReceiptFrom } from "../src/core/eoa-guard";
import { memoWindows, reconcileReceipt } from "../src/core/reconcile";
import { addr, expectedFromInput, fixtureReceipt, loadFixture } from "./helpers";

// All receipts below were recorded from Arc Testnet (chain 5042002); see test/fixtures/README.md.
const SENDER = "0x427C62eDCae20DDc8c5e875De39D4E4845491458";
const transferChecks = ["memoSender", "memoTarget", "transfer6", "transfer18", "callDataHash"] as const;

describe("reconcile recorded Multicall3From -> Memo -> USDC receipts", () => {
  it.each([
    ["receipt-batch-2rows.json", 2],
    ["receipt-batch-2rows-b.json", 2],
    ["receipt-batch-13rows.json", 13],
  ])("%s: every row has Memo.sender == EOA and Transfer.from == EOA", (file, n) => {
    const fx = loadFixture(file);
    const receipt = fixtureReceipt(file);
    expect(receipt.to?.toLowerCase()).toBe(ADDRESSES.MULTICALL3FROM.toLowerCase());
    const expected = expectedFromInput(fx.tx.input);
    const rec = reconcileReceipt(receipt, { account: SENDER, expected });
    expect(rec.status).toBe("success");
    expect(rec.fromMatches).toBe(true);
    expect(rec.rows).toHaveLength(n);
    expect(rec.missing).toEqual([]);
    for (const [i, row] of rec.rows.entries()) {
      for (const c of transferChecks) expect(row.checks[c], `${c} row ${i}`).toBe(true);
      expect(row.checks.matchesPlan).toBe(true);
      expect(row.sender).toBe(SENDER);
      expect(row.recipient).toBe(expected[i].recipient);
      expect(row.amount18).toBe(expected[i].amount6 * 10n ** 12n);
      // Another app's memo format: decoded as foreign, never trusted.
      expect(row.checks.memoV1).toBe(false);
      expect(row.memo.ok).toBe(false);
    }
  });

  it("works for a different sender and flags the wrong account", () => {
    const fx = loadFixture("receipt-batch-2rows-other-eoa.json");
    const receipt = fixtureReceipt("receipt-batch-2rows-other-eoa.json");
    const ok = reconcileReceipt(receipt, { account: fx.tx.from });
    expect(ok.rows.every((r) => transferChecks.every((c) => r.checks[c]))).toBe(true);
    const wrong = reconcileReceipt(receipt, { account: SENDER });
    expect(wrong.fromMatches).toBe(false);
    expect(wrong.rows.every((r) => !r.checks.memoSender && !r.checks.transfer6)).toBe(true);
  });

  it("does not treat EURC rows as USDC payouts", () => {
    const rec = reconcileReceipt(fixtureReceipt("receipt-batch-eurc-mixed.json"), { account: SENDER });
    expect(rec.rows.map((r) => r.checks.memoTarget)).toEqual([false, false, true]);
    expect(rec.rows.map((r) => r.checks.transfer6)).toEqual([false, false, true]);
    expect(rec.rows[2].checks.transfer18).toBe(true);
  });

  it("ignores logs outside memo frames (plain subcalls in the same batch)", () => {
    const fx = loadFixture("receipt-batch-non-memo-calls.json");
    const rec = reconcileReceipt(fixtureReceipt("receipt-batch-non-memo-calls.json"), { account: fx.tx.from, expected: expectedFromInput(fx.tx.input) });
    expect(rec.rows).toHaveLength(2);
    expect(rec.rows.every((r) => transferChecks.every((c) => r.checks[c]) && r.checks.matchesPlan)).toBe(true);
  });

  it("splits frames with BeforeMemo/Memo and keeps memo indexes paired", () => {
    const windows = memoWindows(fixtureReceipt("receipt-batch-13rows.json").logs);
    expect(windows).toHaveLength(13);
    expect(windows.every((w) => w.frame.logs.length === 2)).toBe(true);
  });

  it("separates rows that are in the plan from rows that are not", () => {
    const fx = loadFixture("receipt-batch-2rows.json");
    const [first] = expectedFromInput(fx.tx.input);
    const rec = reconcileReceipt(fixtureReceipt("receipt-batch-2rows.json"), { account: SENDER, expected: [first, { ...first, memoId: `0x${"ab".repeat(32)}`, index: 9 }] });
    expect(rec.rows).toHaveLength(1);
    expect(rec.unexpected).toHaveLength(1);
    expect(rec.missing.map((m) => m.index)).toEqual([9]);
  });
});

describe("reconcile derived (synthetic) variants of a recorded receipt", () => {
  const base = () => fixtureReceipt("receipt-batch-2rows.json");
  const expected = () => expectedFromInput(loadFixture("receipt-batch-2rows.json").tx.input);

  it("pairs the 6- and 18-decimal logs by (from, to, value), not by order", () => {
    const r = base();
    // Swap logIndex of the native and ERC-20 Transfer inside every frame.
    const logs = r.logs.map((l) => ({ ...l })) as TransactionReceipt["logs"];
    for (let i = 0; i < logs.length; i++) {
      const a = logs[i];
      const b = logs[i + 1];
      if (b && a.address.toLowerCase() === ADDRESSES.NATIVE_USDC_EMITTER.toLowerCase() && b.address.toLowerCase() === ADDRESSES.USDC.toLowerCase()) {
        const t = a.logIndex;
        a.logIndex = b.logIndex;
        b.logIndex = t;
      }
    }
    const rec = reconcileReceipt({ ...r, logs }, { account: SENDER, expected: expected() });
    expect(rec.rows.every((row) => row.checks.transfer6 && row.checks.transfer18 && row.checks.matchesPlan)).toBe(true);
  });

  it("flags an 18-decimal value that is not value6 x 1e12", () => {
    const r = base();
    const logs = r.logs.map((l) =>
      l.address.toLowerCase() === ADDRESSES.NATIVE_USDC_EMITTER.toLowerCase() ? { ...l, data: `0x${"00".repeat(31)}01` } : l,
    ) as TransactionReceipt["logs"];
    const rec = reconcileReceipt({ ...r, logs }, { account: SENDER, expected: expected() });
    expect(rec.rows.every((row) => row.checks.transfer18 === false && !row.ok)).toBe(true);
  });

  it("marks every planned row missing when the transaction reverted", () => {
    const r: TransactionReceipt = { ...base(), status: "reverted", logs: [] };
    const rec = reconcileReceipt(r, { account: SENDER, expected: expected() });
    expect(rec.status).toBe("reverted");
    expect(rec.rows).toEqual([]);
    expect(rec.missing).toHaveLength(2);
  });

  it("refuses a receipt that came from another account (e.g. a smart account or relayer)", () => {
    const relayer = getAddress(addr("relayer"));
    const r: TransactionReceipt = { ...base(), from: relayer };
    expect(() => assertReceiptFrom(r, SENDER)).toThrow(/expected/);
    const rec = reconcileReceipt(r, { account: SENDER, expected: expected() });
    expect(rec.fromMatches).toBe(false);
    expect(rec.rows.every((row) => !row.ok && row.checks.memoSender === false)).toBe(true);
  });
});

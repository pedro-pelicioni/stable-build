import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getNetwork } from "../src/config/networks";
import { parsePayoutCsv } from "../src/core/csv";
import { createLedger, markSent, type Ledger } from "../src/core/ledger";
import { newBatchId } from "../src/core/memo-schema";
import { planRows } from "../src/core/plan";
import { findLedger, ledgerKey, loadLedger, saveLedger } from "../src/ui/storage";
import { addr } from "./helpers";

// The web app keeps one ledger per (network, account, file), so planning another file never
// overwrites a batch that is still in flight.
class MemoryStorage {
  map = new Map<string, string>();
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}

const net = getNetwork("testnet");
const PAYER = addr("payer");
function ledgerFor(refs: string[], batchId = newBatchId()): Ledger {
  const rows = parsePayoutCsv(["recipient,amount,reference", ...refs.map((r, i) => `${addr(`s${i}`)},1,${r}`)].join("\n")).rows;
  return createLedger({ network: net.name, chainId: net.chainId, account: PAYER, batchId, mode: "batch", startBlock: 1n, rows: planRows(rows, batchId) });
}

let storage: MemoryStorage;
beforeEach(() => {
  storage = new MemoryStorage();
  (globalThis as { localStorage?: unknown }).localStorage = storage;
});
afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe("ledger storage", () => {
  it("keeps one ledger per file, account and network", () => {
    const a = ledgerFor(["A-1"]);
    const b = ledgerFor(["B-1"]);
    saveLedger(a);
    saveLedger(b);
    expect(findLedger(net.name, PAYER, a.rowsDigest)?.batchId).toBe(a.batchId);
    expect(findLedger(net.name, PAYER, b.rowsDigest)?.batchId).toBe(b.batchId);
    expect(loadLedger()?.batchId).toBe(b.batchId);
    expect(findLedger("mainnet", PAYER, a.rowsDigest)).toBeNull();
  });

  it("archives a stored batch with rows in flight instead of overwriting it", () => {
    const inFlight = markSent(ledgerFor(["C-1"]), [0], `0x${"11".repeat(32)}`, "https://example.invalid");
    saveLedger(inFlight);
    const other = ledgerFor(["C-1"]); // same file, another batch id
    saveLedger(other);
    const key = ledgerKey(net.name, PAYER, inFlight.rowsDigest);
    expect(JSON.parse(storage.getItem(`${key}:${inFlight.batchId}`)!).batchId).toBe(inFlight.batchId);
    expect(findLedger(net.name, PAYER, inFlight.rowsDigest)?.batchId).toBe(other.batchId);
  });

  it("reads the single slot written by earlier versions", () => {
    const old = ledgerFor(["L-1"]);
    storage.setItem("sb-payouts:last-ledger", JSON.stringify(old));
    expect(loadLedger()?.batchId).toBe(old.batchId);
    expect(findLedger(net.name, PAYER, old.rowsDigest)?.batchId).toBe(old.batchId);
  });
});

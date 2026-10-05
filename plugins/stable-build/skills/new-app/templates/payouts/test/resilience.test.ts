import { type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { getNetwork } from "../src/config/networks";
import { parsePayoutCsv, type PayoutRow } from "../src/core/csv";
import { requeueRejected, type Ledger } from "../src/core/ledger";
import { AlreadyPaidError, UnknownTransactionError, executeLedger, prepareBatch, recoverLedger, syncLedger } from "../src/core/run";
import { FakeChain, FakeSender } from "./fake-chain";
import { addr, memoFailed, revertError, synthReceipt } from "./helpers";

// Paths that move money and that the first review found unguarded: re-planning a file that was
// already paid, transient RPC errors, wallet cancel/speed-up, missing nonces, re-queueing.
const testnet = getNetwork("testnet");
const PAYER = addr("payer");
const ONE_USDC = 10n ** 18n;
const noWait = async () => {};
const csvRows = (refs: string[], amount = "0.01"): PayoutRow[] =>
  parsePayoutCsv(["recipient,amount,reference", ...refs.map((ref, i) => `${addr(`r${i}`)},${amount},${ref}`)].join("\n")).rows;

function setup() {
  const chain = new FakeChain();
  chain.fund(PAYER, 100n * ONE_USDC);
  return { chain, sender: new FakeSender(PAYER, chain) };
}
const spent6 = (chain: FakeChain) => (100n * ONE_USDC - chain.balances.get(PAYER.toLowerCase())!) / 10n ** 12n;
const http503 = () => Object.assign(new Error("HTTP request failed."), { status: 503, shortMessage: "HTTP request failed." });

describe("a file that was already paid is never paid again", () => {
  it("re-planning the same rows (ledger lost) resumes the paid batch and sends nothing", async () => {
    const { chain, sender } = setup();
    const rows = csvRows(["INV-1", "INV-2", "INV-3"]);
    const first = await prepareBatch({ chain, network: testnet, account: PAYER, rows });
    await executeLedger({ chain, sender, network: testnet, ledger: first.ledger });
    chain.head += 20_000n;
    const again = await prepareBatch({ chain, network: testnet, account: PAYER, rows });
    expect(again.resumed).toEqual({ batchId: first.ledger.batchId, paidRows: 3 });
    expect(again.ledger.batchId).toBe(first.ledger.batchId);
    expect(again.chunks).toEqual([]);
    const run = await executeLedger({ chain, sender, network: testnet, ledger: again.ledger });
    expect(run.sent).toEqual([]);
    expect(sender.sent).toHaveLength(1);
    expect(spent6(chain)).toBe(30_000n);
  });

  it("a partly paid file resumes and sends only the unpaid rows", async () => {
    const { chain, sender } = setup();
    const rows = csvRows(["A-1", "A-2", "A-3", "A-4"]);
    const first = await prepareBatch({ chain, network: testnet, account: PAYER, rows, chunkSize: 2 });
    let afterFirstChunk: Ledger | undefined;
    chain.revertNext = false;
    let n = 0;
    const realMine = chain.mine.bind(chain);
    chain.mine = (from, tx) => {
      if (++n === 2) throw new Error("wallet closed"); // the second chunk never goes out
      return realMine(from, tx);
    };
    await expect(
      executeLedger({ chain, sender, network: testnet, ledger: first.ledger, chunkSize: 2, onLedger: (l) => void (afterFirstChunk = l) }),
    ).rejects.toThrow(/wallet closed/);
    expect(afterFirstChunk!.rows.map((r) => r.status)).toEqual(["paid", "paid", "planned", "planned"]);
    chain.mine = realMine;
    const again = await prepareBatch({ chain, network: testnet, account: PAYER, rows, chunkSize: 2 });
    expect(again.resumed?.paidRows).toBe(2);
    const run = await executeLedger({ chain, sender, network: testnet, ledger: again.ledger, chunkSize: 2 });
    expect(run.sent).toHaveLength(1);
    expect(run.ledger.rows.every((r) => r.status === "paid")).toBe(true);
    expect(spent6(chain)).toBe(40_000n);
  });

  it("refuses a file whose references were paid at other positions or in several batches", async () => {
    const { chain, sender } = setup();
    const paid = await prepareBatch({ chain, network: testnet, account: PAYER, rows: csvRows(["X-1", "X-2"]) });
    await executeLedger({ chain, sender, network: testnet, ledger: paid.ledger });
    // same references, reordered: memoIds would differ, so this cannot resume that batch
    const reordered = csvRows(["NEW-1", "X-2", "X-1"]);
    const err = await prepareBatch({ chain, network: testnet, account: PAYER, rows: reordered }).catch((e) => e);
    expect(err).toBeInstanceOf(AlreadyPaidError);
    expect((err as AlreadyPaidError).paid.map((p) => p.reference).sort()).toEqual(["X-1", "X-2"]);
    expect(sender.sent).toHaveLength(1);
    // without the paid rows the file plans normally
    const fresh = await prepareBatch({ chain, network: testnet, account: PAYER, rows: csvRows(["NEW-1"]) });
    expect(fresh.resumed).toBeUndefined();
    expect(fresh.ledger.batchId).not.toBe(paid.ledger.batchId);
  });

  it("CLI --sync without a ledger rebuilds it from Memo history by reference", async () => {
    const { chain, sender } = setup();
    const rows = csvRows(["S-1", "S-2"]);
    const p = await prepareBatch({ chain, network: testnet, account: PAYER, rows });
    await executeLedger({ chain, sender, network: testnet, ledger: p.ledger });
    const rebuilt = await recoverLedger({ chain, network: testnet, account: PAYER, rows });
    expect(rebuilt?.batchId).toBe(p.ledger.batchId);
    expect(rebuilt?.rows.every((r) => r.status === "paid")).toBe(true);
    expect(await recoverLedger({ chain, network: testnet, account: PAYER, rows: csvRows(["NEVER-PAID"]) })).toBeNull();
  });
});

describe("transient RPC errors never reject a row", () => {
  it("a 503 during simulation stops planning; the rows stay sendable", async () => {
    const { chain, sender } = setup();
    const rows = csvRows(["T-1", "T-2", "T-3"]);
    const realCall = chain.call.bind(chain);
    let failures = 0;
    chain.call = async (tx) => {
      if (failures < 1) {
        failures++;
        throw http503(); // what is left after viem's own HTTP retries
      }
      return realCall(tx);
    };
    await expect(prepareBatch({ chain, network: testnet, account: PAYER, rows })).rejects.toMatchObject({ status: 503 });
    const p = await prepareBatch({ chain, network: testnet, account: PAYER, rows });
    expect(p.rejected).toEqual([]);
    const run = await executeLedger({ chain, sender, network: testnet, ledger: p.ledger });
    expect(run.ledger.rows.map((r) => r.status)).toEqual(["paid", "paid", "paid"]);
  });

  it("a 503 while isolating rows inside a send stops the run without rejecting", async () => {
    const { chain, sender } = setup();
    const rows = csvRows(["U-1", "U-2"]);
    const p = await prepareBatch({ chain, network: testnet, account: PAYER, rows });
    chain.call = async () => {
      throw http503();
    };
    let last: Ledger | undefined;
    await expect(executeLedger({ chain, sender, network: testnet, ledger: p.ledger, onLedger: (l) => void (last = l) })).rejects.toMatchObject({ status: 503 });
    expect((last ?? p.ledger).rows.every((r) => r.status === "planned")).toBe(true);
    expect(sender.sent).toHaveLength(0);
  });

  it("a balance revert is reported, not stored as a rejected row", async () => {
    const { chain } = setup();
    const rows = csvRows(["B-1", "B-2"]);
    chain.call = async () => {
      throw revertError(memoFailed("ERC20: transfer amount exceeds balance"));
    };
    await expect(prepareBatch({ chain, network: testnet, account: PAYER, rows })).rejects.toThrow(/balance no longer covers/);
  });

  it("rejected rows can be put back in the queue", async () => {
    const { chain, sender } = setup();
    const rows = csvRows(["R-1", "R-2"]);
    chain.blocklist.add(rows[1].recipient.toLowerCase());
    const p = await prepareBatch({ chain, network: testnet, account: PAYER, rows });
    const first = await executeLedger({ chain, sender, network: testnet, ledger: p.ledger });
    expect(first.ledger.rows.map((r) => r.status)).toEqual(["paid", "rejected"]);
    chain.blocklist.clear();
    const retry = await executeLedger({ chain, sender, network: testnet, ledger: requeueRejected(first.ledger) });
    expect(retry.ledger.rows.map((r) => r.status)).toEqual(["paid", "paid"]);
  });
});

describe("wallet cancel and speed-up", () => {
  it("a cancelled transaction puts its rows back in the queue and stops the run", async () => {
    const { chain, sender } = setup();
    const p = await prepareBatch({ chain, network: testnet, account: PAYER, rows: csvRows(["C-1", "C-2"]) });
    const cancelHash = `0x${"ab".repeat(32)}` as Hex;
    chain.waitForReceipt = async () => synthReceipt({ from: PAYER, rows: [], hash: cancelHash, blockNumber: chain.head, to: PAYER });
    let last: Ledger | undefined;
    await expect(executeLedger({ chain, sender, network: testnet, ledger: p.ledger, onLedger: (l) => void (last = l) })).rejects.toThrow(/cancelled or replaced/);
    expect(last!.rows.map((r) => r.status)).toEqual(["failed", "failed"]);
    expect(last!.rows[0].error).toMatch(new RegExp(cancelHash));
  });

  it("a sped-up transaction with the same rows reconciles them under the new hash", async () => {
    const { chain, sender } = setup();
    const p = await prepareBatch({ chain, network: testnet, account: PAYER, rows: csvRows(["F-1", "F-2"]) });
    const realWait = chain.waitForReceipt.bind(chain);
    const fastHash = `0x${"cd".repeat(32)}` as Hex;
    chain.waitForReceipt = async (hash) => {
      const r = await realWait(hash);
      return { ...r, transactionHash: fastHash, logs: r.logs.map((l) => ({ ...l, transactionHash: fastHash })) };
    };
    const run = await executeLedger({ chain, sender, network: testnet, ledger: p.ledger });
    expect(run.ledger.rows.every((r) => r.status === "paid" && r.txHash === fastHash)).toBe(true);
  });
});

describe("nonces and unknown transactions", () => {
  it("a local key records the nonce before the broadcast returns", async () => {
    const { chain, sender } = setup();
    chain.nonces.set(PAYER.toLowerCase(), 7);
    chain.getTransaction = async () => null; // the RPC does not know the tx right after broadcast
    const p = await prepareBatch({ chain, network: testnet, account: PAYER, rows: csvRows(["N-1"]) });
    const states: Ledger[] = [];
    await executeLedger({ chain, sender, network: testnet, ledger: p.ledger, onLedger: (l) => void states.push(l) });
    const sentState = states.find((l) => l.rows[0].status === "sent")!;
    expect(sentState.rows[0].nonce).toBe(7);
    expect(sender.sent[0].nonce).toBe(7);
  });

  it("an unknown transaction is checked against Memo history before anything else", async () => {
    const { chain } = setup();
    const browser = new FakeSender(PAYER, chain);
    browser.controlsNonce = false; // a browser wallet picks its own nonce
    chain.getTransaction = async () => null;
    const p = await prepareBatch({ chain, network: testnet, account: PAYER, rows: csvRows(["W-1", "W-2"]) });
    let lastSent: Ledger | undefined;
    chain.waitForReceipt = async () => {
      throw new Error("timed out");
    };
    await executeLedger({ chain, sender: browser, network: testnet, ledger: p.ledger, wait: noWait, onLedger: (l) => void (lastSent = l) }).catch(() => {});
    expect(lastSent!.rows.map((r) => [r.status, r.nonce])).toEqual([
      ["sent", undefined],
      ["sent", undefined],
    ]);
    // The transaction did land, but the backend that answers first lags: no receipt, no transaction.
    // The Memo history scan (another backend) finds it, and then its receipt.
    const hash = lastSent!.rows[0].txHash!;
    const realReceipt = chain.getTransactionReceipt.bind(chain);
    let lookups = 0;
    chain.getTransactionReceipt = async (h) => (h === hash && lookups++ === 0 ? null : realReceipt(h));
    const synced = await syncLedger({ chain, network: testnet, ledger: lastSent! });
    expect(synced.rows.every((r) => r.status === "paid")).toBe(true);
  });

  it("an unknown transaction with no history and no nonce stops, unless re-queued on request", async () => {
    const { chain } = setup();
    const browser = new FakeSender(PAYER, chain);
    browser.controlsNonce = false;
    chain.getTransaction = async () => null;
    const p = await prepareBatch({ chain, network: testnet, account: PAYER, rows: csvRows(["V-1"]) });
    let lastSent: Ledger | undefined;
    chain.waitForReceipt = async () => {
      throw new Error("timed out");
    };
    await executeLedger({ chain, sender: browser, network: testnet, ledger: p.ledger, wait: noWait, onLedger: (l) => void (lastSent = l) }).catch(() => {});
    chain.forget.add(lastSent!.rows[0].txHash!);
    chain.memoLogStore = []; // it never landed
    await expect(syncLedger({ chain, network: testnet, ledger: lastSent! })).rejects.toBeInstanceOf(UnknownTransactionError);
    const requeued = await syncLedger({ chain, network: testnet, ledger: lastSent!, requeueUnknown: true });
    expect(requeued.rows[0]).toMatchObject({ status: "failed" });
    expect(requeued.rows[0].error).toMatch(/re-queued on request/);
  });
});

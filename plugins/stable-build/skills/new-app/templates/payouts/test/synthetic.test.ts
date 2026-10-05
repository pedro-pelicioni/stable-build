import { describe, expect, it } from "vitest";
import { parsePayoutCsv } from "../src/core/csv";
import { planRows } from "../src/core/plan";
import { reconcileReceipt } from "../src/core/reconcile";
import { addr, fixtureReceipt, synthReceipt } from "./helpers";

// The engine tests use receipts built by synthReceipt (no memo of ours exists
// onchain yet). This test pins that builder to the layout of a recorded receipt.
describe("synthetic receipts match the recorded layout", () => {
  it("same emitters and topic0 sequence per row as the recorded 2-row batch", () => {
    const recorded = fixtureReceipt("receipt-batch-2rows.json");
    const sender = recorded.from;
    const rows = planRows(
      parsePayoutCsv(`recipient,amount,reference\n${addr("a")},0.01,A-1\n${addr("b")},0.25,A-2`).rows,
      "0x0123456789abcdef0123456789abcdef",
    );
    const synth = synthReceipt({ from: sender, rows, hash: recorded.transactionHash, blockNumber: recorded.blockNumber });
    const shape = (logs: typeof recorded.logs) => logs.map((l) => `${l.address.toLowerCase()}:${l.topics[0]}:${l.topics.length}`);
    expect(shape(synth.logs)).toEqual(shape(recorded.logs));
    const rec = reconcileReceipt(synth, { account: sender });
    expect(rec.rows.every((r) => r.ok)).toBe(true);
  });
});

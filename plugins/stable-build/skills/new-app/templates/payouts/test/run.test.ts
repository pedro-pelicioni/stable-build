import { type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { ADDRESSES, getNetwork, MAINNET_CONFIRMATION } from "../src/config/networks";
import { parsePayoutCsv, type PayoutRow } from "../src/core/csv";
import { EoaGuardError } from "../src/core/eoa-guard";
import type { Ledger } from "../src/core/ledger";
import { GateError, assertMainnetAllowed, executeLedger, prepareBatch, rebuildFromHistory, syncLedger } from "../src/core/run";
import { FakeChain, FakeSender } from "./fake-chain";
import { addr } from "./helpers";

const testnet = getNetwork("testnet");
const mainnet = getNetwork("mainnet");
const PAYER = addr("payer");
const ONE_USDC = 10n ** 18n;
const rowsOf = (n: number, amount = "0.01"): PayoutRow[] =>
  parsePayoutCsv(["recipient,amount,reference", ...Array.from({ length: n }, (_, i) => `${addr(`r${i}`)},${amount},R-${i}`)].join("\n")).rows;

function setup(n = 3) {
  const chain = new FakeChain();
  chain.fund(PAYER, 100n * ONE_USDC);
  const sender = new FakeSender(PAYER, chain);
  return { chain, sender, rows: rowsOf(n) };
}

describe("payout engine", () => {
  it("plans, sends one aggregate3 per chunk and reconciles every row", async () => {
    const { chain, sender, rows } = setup(3);
    const prepared = await prepareBatch({ chain, network: testnet, account: PAYER, rows });
    expect(prepared.chunks.map((c) => c.rows.length)).toEqual([3]);
    expect(prepared.preflight.ok).toBe(true);
    expect(prepared.fees.maxFeePerGas).toBe(40_000_000_000n);
    const saved: Ledger[] = [];
    const { ledger, sent } = await executeLedger({ chain, sender, network: testnet, ledger: prepared.ledger, onLedger: (l) => void saved.push(l) });
    expect(sent).toHaveLength(1);
    expect(sender.sent[0].to).toBe(ADDRESSES.MULTICALL3FROM);
    expect(ledger.rows.every((r) => r.status === "paid" && r.txHash === sent[0])).toBe(true);
    // The ledger is persisted as "sent" before the receipt arrives.
    expect(saved.some((l) => l.rows.every((r) => r.status === "sent"))).toBe(true);
    expect(chain.balances.get(PAYER.toLowerCase())).toBe(100n * ONE_USDC - 30_000n * 10n ** 12n);
  });

  it("is idempotent: a rerun with the same ledger sends nothing", async () => {
    const { chain, sender, rows } = setup(3);
    const prepared = await prepareBatch({ chain, network: testnet, account: PAYER, rows });
    const first = await executeLedger({ chain, sender, network: testnet, ledger: prepared.ledger });
    const again = await executeLedger({ chain, sender, network: testnet, ledger: first.ledger });
    expect(again.sent).toEqual([]);
    expect(sender.sent).toHaveLength(1);
  });

  it("recovers paid rows from Memo events when the ledger was lost after sending", async () => {
    const { chain, sender, rows } = setup(3);
    const prepared = await prepareBatch({ chain, network: testnet, account: PAYER, rows });
    await executeLedger({ chain, sender, network: testnet, ledger: prepared.ledger });
    chain.head += 25_000n; // history spans several 9,999-block pages
    const stale = prepared.ledger; // every row still "planned"
    const resumed = await executeLedger({ chain, sender, network: testnet, ledger: stale });
    expect(resumed.sent).toEqual([]);
    expect(resumed.ledger.rows.every((r) => r.status === "paid")).toBe(true);
    expect(chain.calls.getLogs).toBeGreaterThanOrEqual(3);
  });

  it("resolves a broadcast transaction whose receipt was never recorded", async () => {
    const { chain, sender, rows } = setup(2);
    const prepared = await prepareBatch({ chain, network: testnet, account: PAYER, rows });
    let lastSent: Ledger | undefined;
    await executeLedger({
      chain,
      sender,
      network: testnet,
      ledger: prepared.ledger,
      onLedger: (l) => {
        if (!lastSent && l.rows.every((r) => r.status === "sent")) lastSent = l;
      },
    });
    const synced = await syncLedger({ chain, network: testnet, ledger: lastSent! });
    expect(synced.rows.every((r) => r.status === "paid")).toBe(true);
  });

  it("re-queues rows of a dropped transaction once its nonce is used", async () => {
    const { chain, sender, rows } = setup(2);
    const prepared = await prepareBatch({ chain, network: testnet, account: PAYER, rows });
    let lastSent: Ledger | undefined;
    const first = await executeLedger({
      chain,
      sender,
      network: testnet,
      ledger: prepared.ledger,
      onLedger: (l) => {
        if (!lastSent && l.rows.some((r) => r.nonce !== undefined)) lastSent = l;
      },
    });
    // Pretend that transaction vanished and nothing reached the chain.
    const hash = first.sent[0];
    chain.forget.add(hash);
    chain.memoLogStore = [];
    const synced = await syncLedger({ chain, network: testnet, ledger: lastSent! });
    expect(synced.rows.every((r) => r.status === "failed" && /dropped or replaced/.test(r.error ?? ""))).toBe(true);
  });

  it("splits 120 rows into chunks of 50, 50 and 20", async () => {
    const { chain, sender } = setup();
    const rows = rowsOf(120);
    const prepared = await prepareBatch({ chain, network: testnet, account: PAYER, rows });
    const { sent, ledger } = await executeLedger({ chain, sender, network: testnet, ledger: prepared.ledger });
    expect(sent).toHaveLength(3);
    expect(ledger.rows.every((r) => r.status === "paid")).toBe(true);
    expect(new Set(ledger.rows.slice(0, 50).map((r) => r.txHash)).size).toBe(1);
  });

  it("rejects a blocklisted recipient without sending it", async () => {
    const { chain, sender, rows } = setup(4);
    chain.blocklist.add(rows[2].recipient.toLowerCase());
    const prepared = await prepareBatch({ chain, network: testnet, account: PAYER, rows });
    expect(prepared.rejected.map((r) => r.row.index)).toEqual([2]);
    expect(prepared.rejected[0].reason).toMatch(/^MemoFailed: Blacklistable/);
    const { ledger } = await executeLedger({ chain, sender, network: testnet, ledger: prepared.ledger });
    expect(ledger.rows.map((r) => r.status)).toEqual(["paid", "paid", "rejected", "paid"]);
  });

  it("supports the per-row fallback (one Memo.memo transaction per row)", async () => {
    const { chain, sender, rows } = setup(3);
    const prepared = await prepareBatch({ chain, network: testnet, account: PAYER, rows, mode: "per-row" });
    const { sent, ledger } = await executeLedger({ chain, sender, network: testnet, ledger: prepared.ledger });
    expect(sent).toHaveLength(3);
    expect(sender.sent.every((t) => t.to === ADDRESSES.MEMO)).toBe(true);
    expect(ledger.rows.every((r) => r.status === "paid")).toBe(true);
  });

  it("stops before sending when the balance cannot cover payouts and fees", async () => {
    const { chain, sender, rows } = setup(3);
    chain.fund(PAYER, 30_000n * 10n ** 12n); // exactly the payouts, nothing for fees
    const prepared = await prepareBatch({ chain, network: testnet, account: PAYER, rows });
    expect(prepared.preflight.ok).toBe(false);
    await expect(executeLedger({ chain, sender, network: testnet, ledger: prepared.ledger })).rejects.toThrow(/insufficient balance/);
    expect(sender.sent).toHaveLength(0);
  });

  it("reports a shortfall instead of rejecting rows when the balance is empty", async () => {
    const { chain, sender, rows } = setup(3);
    chain.fund(PAYER, 0n);
    const prepared = await prepareBatch({ chain, network: testnet, account: PAYER, rows });
    expect(prepared.preflight.ok).toBe(false);
    expect(prepared.rejected).toEqual([]);
    expect(prepared.ledger.rows.every((r) => r.status === "planned")).toBe(true);
    await expect(executeLedger({ chain, sender, network: testnet, ledger: prepared.ledger })).rejects.toThrow(/insufficient balance/);
    expect(sender.sent).toHaveLength(0);
  });

  it("stops on a reverted chunk and leaves its rows failed (re-queued)", async () => {
    const { chain, sender, rows } = setup(2);
    const prepared = await prepareBatch({ chain, network: testnet, account: PAYER, rows });
    chain.revertNext = true;
    let last: Ledger | undefined;
    await expect(executeLedger({ chain, sender, network: testnet, ledger: prepared.ledger, onLedger: (l) => void (last = l) })).rejects.toThrow(/reverted/);
    expect(last!.rows.map((r) => r.status)).toEqual(["failed", "failed"]);
    const retry = await executeLedger({ chain, sender, network: testnet, ledger: last! });
    expect(retry.ledger.rows.every((r) => r.status === "paid")).toBe(true);
  });

  it("refuses EIP-7702 delegated and contract accounts, and the wrong chain", async () => {
    const { chain, rows } = setup(1);
    chain.codes.set(PAYER.toLowerCase(), `0xef0100${"cd".repeat(20)}` as Hex);
    await expect(prepareBatch({ chain, network: testnet, account: PAYER, rows })).rejects.toBeInstanceOf(EoaGuardError);
    chain.codes.set(PAYER.toLowerCase(), "0x60806040");
    await expect(prepareBatch({ chain, network: testnet, account: PAYER, rows })).rejects.toThrow(/contract account/);
    chain.codes.clear();
    chain.id = 1;
    await expect(prepareBatch({ chain, network: testnet, account: PAYER, rows })).rejects.toThrow(/expected 5042002/);
  });

  it("gates mainnet behind the typed confirmation and a per-batch cap", async () => {
    expect(() => assertMainnetAllowed(testnet, {}, 10n ** 12n)).not.toThrow();
    expect(() => assertMainnetAllowed(mainnet, {}, 1n)).toThrow(GateError);
    expect(() => assertMainnetAllowed(mainnet, { confirmation: "send real usdc", capUsdc: "10" }, 1n)).toThrow(/SEND REAL USDC/);
    expect(() => assertMainnetAllowed(mainnet, { confirmation: MAINNET_CONFIRMATION }, 1n)).toThrow(/cap/);
    expect(() => assertMainnetAllowed(mainnet, { confirmation: MAINNET_CONFIRMATION, capUsdc: "0.05" }, 60_000n)).toThrow(/above the cap/);
    expect(() => assertMainnetAllowed(mainnet, { confirmation: MAINNET_CONFIRMATION, capUsdc: "0.06" }, 60_000n)).not.toThrow();

    const { chain, sender, rows } = setup(3);
    chain.id = 5042;
    const prepared = await prepareBatch({ chain, network: mainnet, account: PAYER, rows });
    await expect(executeLedger({ chain, sender, network: mainnet, ledger: prepared.ledger })).rejects.toThrow(/mainnet send refused/);
    expect(sender.sent).toHaveLength(0);
    const ok = await executeLedger({ chain, sender, network: mainnet, ledger: prepared.ledger, gate: { confirmation: MAINNET_CONFIRMATION, capUsdc: "1" } });
    expect(ok.sent).toHaveLength(1);
  });

  it("refuses a ledger for another network or signer", async () => {
    const { chain, sender, rows } = setup(1);
    const prepared = await prepareBatch({ chain, network: testnet, account: PAYER, rows });
    await expect(executeLedger({ chain, sender, network: mainnet, ledger: prepared.ledger })).rejects.toThrow(/ledger is for testnet/);
    await expect(executeLedger({ chain, sender: new FakeSender(addr("other"), chain), network: testnet, ledger: prepared.ledger })).rejects.toThrow(/not the ledger account/);
  });

  it("rebuilds paid rows from paged history alone", async () => {
    const { chain, sender, rows } = setup(3);
    const prepared = await prepareBatch({ chain, network: testnet, account: PAYER, rows });
    const { ledger } = await executeLedger({ chain, sender, network: testnet, ledger: prepared.ledger });
    chain.head += 30_000n;
    const rebuilt = await rebuildFromHistory({ chain, account: PAYER, fromBlock: BigInt(ledger.startBlock), batchId: ledger.batchId });
    expect(rebuilt.map((r) => [r.memoId, r.recipient, r.amount6, r.txHash])).toEqual(
      ledger.rows.map((r) => [r.memoId, r.recipient, BigInt(r.amount18) / 10n ** 12n, r.txHash]),
    );
    expect(rebuilt.every((r) => r.ok)).toBe(true);
  });
});

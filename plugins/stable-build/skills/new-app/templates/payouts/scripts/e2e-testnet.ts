#!/usr/bin/env node
/**
 * Manual end-to-end check on Arc Testnet. Never runs in CI, never on mainnet.
 *
 *   STABLE_BUILD_E2E_KEY=0x… npm run e2e:testnet
 *
 * Uses a funded TESTNET key (faucet: https://faucet.circle.com). Sends 3 rows of
 * 0.01 USDC to freshly generated addresses in one Multicall3From.aggregate3 call,
 * then asserts:
 *   1. receipt success, 3 Memo events with sender == payer;
 *   2. 3 pairs of Transfer logs (6 dp from 0x3600…, 18 dp from the system
 *      emitter) with from == payer and value18 == value6 x 1e12;
 *   3. the rows rebuilt from paged Memo history match the ledger;
 *   4. a rerun with the same batch id sends nothing (also from a fresh ledger);
 * and prints the receipt latency seen with 250 ms polling.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createWalletClient, decodeEventLog, getAddress, http, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { memoAbi, usdcAbi } from "../src/config/abis";
import { ADDRESSES, POLLING_INTERVAL_MS, explorerTxUrl, getNetwork } from "../src/config/networks";
import { createReader, readerPort, walletSender } from "../src/core/chain";
import { parsePayoutCsv } from "../src/core/csv";
import { ledgerToJson } from "../src/core/ledger";
import { errorMessage } from "../src/core/rpc-errors";
import { executeLedger, prepareBatch, rebuildFromHistory } from "../src/core/run";

const TESTNET_CHAIN_ID = 5042002;

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`ASSERTION FAILED: ${message}`);
  console.log(`ok  ${message}`);
}

async function main() {
  if (process.env.CI) throw new Error("e2e-testnet never runs in CI");
  const rawKey = process.env.STABLE_BUILD_E2E_KEY?.trim();
  if (!rawKey) throw new Error("set STABLE_BUILD_E2E_KEY to a funded Arc Testnet key (https://faucet.circle.com)");
  const network = getNetwork("testnet", process.env.STABLE_BUILD_E2E_RPC || undefined);
  const client = createReader(network);
  const reader = readerPort(client);
  const chainId = await reader.chainId();
  if (chainId !== TESTNET_CHAIN_ID) throw new Error(`refusing to run: RPC chain id is ${chainId}, expected Arc Testnet ${TESTNET_CHAIN_ID}`);

  const account = privateKeyToAccount((rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as Hex);
  // Fresh recipients; their keys are discarded.
  const recipients = [0, 1, 2].map(() => privateKeyToAccount(generatePrivateKey()).address);
  const csv = ["recipient,amount,reference", ...recipients.map((r, i) => `${r},0.01,E2E-${Date.now()}-${i}`)].join("\n");
  const parsed = parsePayoutCsv(csv);
  check(parsed.errors.length === 0 && parsed.count === 3, "CSV parsed: 3 rows of 0.01 USDC");

  const prepared = await prepareBatch({ chain: reader, network, account: account.address, rows: parsed.rows });
  check(prepared.rejected.length === 0, "no row rejected in simulation");
  check(prepared.preflight.ok, "balance covers payouts and fees");

  const wallet = createWalletClient({ account, chain: network.chain, transport: http(network.rpcUrl) });
  const sender = walletSender(wallet, account, network);
  let latency = 0;
  const first = await executeLedger({
    chain: reader,
    sender,
    network,
    ledger: prepared.ledger,
    onEvent: (e) => {
      if (e.type === "confirmed") latency = e.latencyMs;
      console.log(`    ${e.type}${"hash" in e ? ` ${e.hash}` : ""}`);
    },
  });
  check(first.sent.length === 1, "one transaction for 3 rows");
  const hash = first.sent[0];
  console.log(`    ${explorerTxUrl(network, hash)}`);

  const receipt = await reader.getTransactionReceipt(hash);
  check(receipt?.status === "success", "receipt status success");
  const memos = receipt!.logs
    .filter((l) => l.address.toLowerCase() === ADDRESSES.MEMO.toLowerCase())
    .map((l) => {
      try {
        return decodeEventLog({ abi: memoAbi, data: l.data, topics: l.topics });
      } catch {
        return null;
      }
    })
    .filter((e) => e?.eventName === "Memo");
  check(memos.length === 3, "3 Memo events");
  check(memos.every((m) => m?.eventName === "Memo" && getAddress(m.args.sender) === account.address), "Memo.sender == payer for every row");
  const transfers = receipt!.logs.flatMap((l) => {
    const emitter = l.address.toLowerCase();
    if (emitter !== ADDRESSES.USDC.toLowerCase() && emitter !== ADDRESSES.NATIVE_USDC_EMITTER.toLowerCase()) return [];
    const ev = decodeEventLog({ abi: usdcAbi, data: l.data, topics: l.topics });
    return ev.eventName === "Transfer" ? [{ emitter, ...ev.args }] : [];
  });
  const t6 = transfers.filter((t) => t.emitter === ADDRESSES.USDC.toLowerCase());
  const t18 = transfers.filter((t) => t.emitter === ADDRESSES.NATIVE_USDC_EMITTER.toLowerCase());
  check(t6.length === 3 && t18.length === 3, "3 pairs of Transfer logs (6 dp + 18 dp)");
  check([...t6, ...t18].every((t) => getAddress(t.from) === account.address), "Transfer.from == payer for every log");
  check(t6.every((a) => t18.some((b) => getAddress(b.to) === getAddress(a.to) && b.value === a.value * 10n ** 12n)), "value18 == value6 x 1e12 for every pair");
  check(first.ledger.rows.every((r) => r.status === "paid"), "ledger: every row paid");

  const rebuilt = await rebuildFromHistory({ chain: reader, account: account.address, fromBlock: BigInt(first.ledger.startBlock), batchId: first.ledger.batchId });
  const key = (memoId: string, to: string, amount: bigint, tx: string) => `${memoId.toLowerCase()}|${to.toLowerCase()}|${amount}|${tx.toLowerCase()}`;
  const fromHistory = rebuilt.map((r) => key(r.memoId, r.recipient ?? "", r.amount18 ?? 0n, r.txHash)).sort();
  const fromLedger = first.ledger.rows.map((r) => key(r.memoId, r.recipient, BigInt(r.amount18), r.txHash ?? "")).sort();
  check(JSON.stringify(fromHistory) === JSON.stringify(fromLedger), "ledger rebuilt from paged history matches");

  const rerun = await executeLedger({ chain: reader, sender, network, ledger: first.ledger });
  check(rerun.sent.length === 0, "rerun with the same ledger sends 0 transactions");
  const fresh = await prepareBatch({ chain: reader, network, account: account.address, rows: parsed.rows, batchId: first.ledger.batchId });
  const rerunFresh = await executeLedger({ chain: reader, sender, network, ledger: { ...fresh.ledger, startBlock: first.ledger.startBlock } });
  check(rerunFresh.sent.length === 0, "rerun from a fresh ledger with the same batch id sends 0 transactions");

  mkdirSync("ledgers", { recursive: true });
  const out = `ledgers/e2e-${first.ledger.batchId.slice(2, 10)}.json`;
  writeFileSync(out, ledgerToJson(first.ledger));
  console.log(`receipt latency with ${POLLING_INTERVAL_MS} ms polling: ${latency} ms`);
  console.log(`all assertions passed; ledger written to ${out}`);
}

main().catch((err) => {
  console.error(errorMessage(err));
  process.exit(1);
});

#!/usr/bin/env node
/**
 * CSV payouts from the command line.
 *
 *   npm run payout -- sample/payroll.csv --dry-run
 *   PAYOUT_PRIVATE_KEY=0x… npm run payout -- sample/payroll.csv
 *   PAYOUT_PRIVATE_KEY=0x… npm run payout -- payroll.csv --network mainnet --cap 500 --confirm "SEND REAL USDC"
 *
 * The key is read from the PAYOUT_PRIVATE_KEY environment variable only, never
 * from argv or a file in this repo. Testnet is the default; mainnet needs
 * --network mainnet, the typed confirmation and a per-batch cap.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { createWalletClient, formatUnits, getAddress, http, isAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { MAINNET_CONFIRMATION, explorerTxUrl, getNetwork, type NetworkConfig } from "../src/config/networks";
import { createReader, readerPort, walletSender } from "../src/core/chain";
import { parsePayoutCsv } from "../src/core/csv";
import { formatUsdc18, ledgerToJson, parseLedgerJson, requeueRejected, rowsDigest, summarize, type Ledger } from "../src/core/ledger";
import { DEFAULT_CHUNK_SIZE, chunkRows, feesFor, type SendMode } from "../src/core/plan";
import { errorMessage } from "../src/core/rpc-errors";
import { HISTORY_LOOKBACK_BLOCKS, assertMainnetAllowed, executeLedger, prepareBatch, recoverLedger, syncLedger, type RunEvent } from "../src/core/run";
import { CAP_PATTERN, cliGateError, leakedKeysFor } from "./cli-gates";

const HELP = `Usage: npm run payout -- <file.csv> [options]

  --network testnet|mainnet   default testnet
  --rpc <url>                 custom RPC endpoint
  --dry-run                   plan only, send nothing (no key needed)
  --from <address>            account to simulate from in --dry-run
  --ledger <path>             ledger file (default ledgers/<file>.<network>.json)
  --chunk-size <n>            rows per transaction, default ${DEFAULT_CHUNK_SIZE}
  --mode batch|per-row        per-row sends one Memo.memo transaction per row
  --cap <usdc>                mainnet: per-batch cap in USDC (required)
  --confirm <text>            mainnet: must be "${MAINNET_CONFIRMATION}" (or type it at the prompt)
  --yes                       testnet: skip the "send?" prompt
  --sync                      update the ledger from chain history and exit (no key needed:
                              the account comes from the ledger, --from or the key). With no
                              ledger file, rebuilds it from Memo history by reference.
  --retry-rejected            put rows rejected in simulation back in the queue before sending
  --requeue-unknown           after checking the explorer: re-queue rows of sent transactions the
                              RPC does not know and Memo history does not show as paid
  --history-blocks <n>        blocks of Memo history to check for references already paid
                              (default ${HISTORY_LOOKBACK_BLOCKS}; 0 skips the check)

Before a new batch, the CLI looks for the file's references in this account's Memo history (see
--history-blocks): a file paid before resumes its batch, and a file whose references were paid in
another way is refused.

Key: export PAYOUT_PRIVATE_KEY in your shell. Never commit it, never prefix it with VITE_.`;

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function writeAtomic(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

function describe(e: RunEvent, network: NetworkConfig): string {
  switch (e.type) {
    case "info":
      return e.message;
    case "rejected":
      return `rejected: ${e.rows.map((r) => `row ${r.row.index + 1} (line ${r.row.line}): ${r.reason}`).join("; ")}`;
    case "sent":
      return `sent rows ${e.rows.map((i) => i + 1).join(",")}: ${explorerTxUrl(network, e.hash)}`;
    case "confirmed":
      return `confirmed ${e.hash}: ${e.paid}/${e.rows.length} rows reconciled in ${e.latencyMs} ms`;
    case "recovered":
      return `found an earlier payment in Memo history: ${explorerTxUrl(network, e.hash)}`;
  }
}

async function ask(question: string): Promise<string> {
  if (!process.stdin.isTTY) return "";
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

function printLedger(ledger: Ledger) {
  const s = summarize(ledger);
  console.log(
    `batch ${ledger.batchId}: ${s.byStatus.paid} paid, ${s.byStatus.planned + s.byStatus.failed} to send, ${s.byStatus.sent} in flight, ${s.byStatus.rejected} rejected, ${s.byStatus.mismatch} mismatched; paid ${formatUsdc18(s.paid18)} of ${formatUsdc18(s.total18)} USDC`,
  );
  for (const r of ledger.rows.filter((x) => x.status !== "paid"))
    console.log(`  row ${r.index + 1} (line ${r.line}) ${r.status}${r.error ? `: ${r.error}` : ""}`);
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      network: { type: "string", default: "testnet" },
      rpc: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      from: { type: "string" },
      ledger: { type: "string" },
      "chunk-size": { type: "string" },
      mode: { type: "string", default: "batch" },
      cap: { type: "string" },
      confirm: { type: "string" },
      yes: { type: "boolean", default: false },
      sync: { type: "boolean", default: false },
      "retry-rejected": { type: "boolean", default: false },
      "requeue-unknown": { type: "boolean", default: false },
      "history-blocks": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help || positionals.length !== 1) {
    console.log(HELP);
    process.exit(values.help ? 0 : 1);
  }
  if (values.network !== "testnet" && values.network !== "mainnet") fail("--network must be testnet or mainnet");
  if (values.mode !== "batch" && values.mode !== "per-row") fail("--mode must be batch or per-row");
  const mode = values.mode as SendMode;
  const chunkSize = values["chunk-size"] ? Number(values["chunk-size"]) : DEFAULT_CHUNK_SIZE;
  if (!Number.isInteger(chunkSize) || chunkSize < 1) fail("--chunk-size must be a positive integer");
  const dryRun = values["dry-run"];
  const historyArg = values["history-blocks"];
  if (historyArg !== undefined && !/^\d+$/.test(historyArg)) fail("--history-blocks must be a whole number of blocks");
  const historyLookbackBlocks = historyArg === undefined ? HISTORY_LOOKBACK_BLOCKS : BigInt(historyArg);

  const gate = cliGateError({
    leaked: leakedKeysFor(process.cwd(), process.env),
    ci: Boolean(process.env.CI),
    dryRun,
    sync: values.sync,
    network: values.network,
    cap: values.cap,
  });
  if (gate) fail(gate);

  const network = getNetwork(values.network, values.rpc);
  if (network.name === "mainnet" && !dryRun && !values.sync && values.cap && CAP_PATTERN.test(values.cap))
    console.log(`MAINNET: this sends real USDC. You will need to type "${MAINNET_CONFIRMATION}".`);
  const csvPath = resolve(positionals[0]);
  const parsed = parsePayoutCsv(readFileSync(csvPath, "utf8"));
  for (const w of parsed.warnings) console.warn(`warning line ${w.line} ${w.field ?? ""}: ${w.message}`);
  if (parsed.errors.length > 0) {
    for (const e of parsed.errors) console.error(`error line ${e.line} ${e.field ?? ""}: ${e.message}`);
    fail(`${parsed.errors.length} problem(s) in ${basename(csvPath)}; nothing was sent`);
  }
  console.log(`${network.label} (chain ${network.chainId}), ${parsed.count} rows, total ${formatUnits(parsed.total6, 6)} USDC`);
  console.log("Reminder: recipients, amounts and memo references are public onchain forever.");

  const ledgerPath = resolve(values.ledger ?? `ledgers/${basename(csvPath).replace(/\.csv$/i, "")}.${network.name}.json`);
  const existing = existsSync(ledgerPath) ? parseLedgerJson(readFileSync(ledgerPath, "utf8")) : null;
  if (existing && existing.rowsDigest !== rowsDigest(parsed.rows))
    fail(`${ledgerPath} belongs to a different file; pass --ledger <new path> for a new batch`);
  if (existing && existing.network !== network.name) fail(`${ledgerPath} is a ${existing.network} ledger`);

  const reader = readerPort(createReader(network));
  const rawKey = process.env.PAYOUT_PRIVATE_KEY?.trim();
  const account = rawKey ? privateKeyToAccount((rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as Hex) : undefined;

  if (dryRun) {
    const from = values.from ? (isAddress(values.from) ? getAddress(values.from) : fail("--from is not an address")) : account?.address;
    if (!from) {
      const block = await reader.getLatestBlock();
      const fees = feesFor(block.baseFeePerGas);
      const chunks = chunkRows(parsed.rows, mode === "per-row" ? 1 : chunkSize);
      // ~58k gas per row was measured with eth_estimateGas on testnet (docs/batch-memo-evidence.md).
      const gas = chunks.reduce((s, c) => s + 21_000n + 58_000n * BigInt(c.length), 0n);
      console.log(`dry run (no account given, so no simulation; pass --from <address> to simulate)`);
      console.log(`transactions: ${chunks.length} (${chunks.map((c) => c.length).join(" + ")} rows)`);
      console.log(`fee estimate: ~${formatUsdc18(((gas * 12n) / 10n) * fees.maxFeePerGas)} USDC max (maxFeePerGas ${formatUnits(fees.maxFeePerGas, 9)} gwei)`);
      console.log(`payouts: ${formatUnits(parsed.total6, 6)} USDC`);
      return;
    }
    const p = await prepareBatch({ chain: reader, network, account: from as Address, rows: parsed.rows, mode, chunkSize, batchId: existing?.batchId, historyLookbackBlocks, onEvent: (e) => console.log(describe(e, network)) });
    console.log(`dry run from ${from} (simulated with eth_call; nothing written, nothing sent)`);
    if (p.chunks.length === 0 && !p.preflight.ok) console.log("transactions: not simulated, the balance does not cover the payouts");
    else console.log(`transactions: ${p.chunks.length} (${p.chunks.map((c) => `${c.rows.length} rows / ${c.gas} gas`).join(", ")})`);
    for (const r of p.rejected) console.log(`  rejected row ${r.row.index + 1} (line ${r.row.line}): ${r.reason}`);
    console.log(`payouts: ${formatUsdc18(p.preflight.payouts18)} USDC; max fees: ${formatUsdc18(p.preflight.fees18)} USDC`);
    console.log(`balance: ${formatUsdc18(p.preflight.balance18)} USDC ${p.preflight.ok ? "(enough)" : `(short by ${formatUsdc18(p.preflight.shortBy18)} USDC)`}`);
    return;
  }

  const save = (l: Ledger) => writeAtomic(ledgerPath, ledgerToJson(l));
  const onEvent = (e: RunEvent) => console.log(describe(e, network));
  const requeueUnknown = values["requeue-unknown"];

  // --sync only reads the chain and writes the ledger file: no key needed.
  if (values.sync) {
    const from = values.from ? (isAddress(values.from) ? getAddress(values.from) : fail("--from is not an address")) : undefined;
    const who = existing ? getAddress(existing.account) : (from ?? account?.address);
    if (!who) fail("--sync without a ledger file needs --from <address> (or PAYOUT_PRIVATE_KEY) to know whose history to read");
    if (existing) {
      if (from && from !== who) fail(`${ledgerPath} belongs to ${existing.account}, not ${from}`);
      const synced = await syncLedger({ chain: reader, network, ledger: existing, onEvent, requeueUnknown });
      save(synced);
      printLedger(synced);
      return;
    }
    const recovered = await recoverLedger({ chain: reader, network, account: who, rows: parsed.rows, mode, historyLookbackBlocks, onEvent });
    if (!recovered) {
      console.log(`no payment of this file's references from ${who} in the last ${historyLookbackBlocks} blocks; no ledger written`);
      return;
    }
    save(recovered);
    console.log(`rebuilt ${ledgerPath} from Memo history (batch ${recovered.batchId})`);
    printLedger(recovered);
    return;
  }

  if (!account) fail("PAYOUT_PRIVATE_KEY is not set (export it in your shell; use --dry-run to plan without a key)");

  let ledger: Ledger;
  if (existing) {
    if (getAddress(existing.account) !== account.address) fail(`${ledgerPath} was created by ${existing.account}, not ${account.address}`);
    console.log(`resuming ${ledgerPath}`);
    ledger = await syncLedger({ chain: reader, network, ledger: existing, onEvent, requeueUnknown });
    save(ledger);
  } else {
    // Looks for these references in the account's Memo history first: a file paid before resumes
    // its batch (paid rows are skipped); references paid in another way stop the run.
    const p = await prepareBatch({ chain: reader, network, account: account.address, rows: parsed.rows, mode, chunkSize, historyLookbackBlocks, onEvent });
    ledger = p.ledger;
    save(ledger);
    console.log(p.resumed ? `resumed batch ${ledger.batchId} from Memo history (${p.resumed.paidRows} row(s) already paid), ledger ${ledgerPath}` : `new batch ${ledger.batchId}, ledger ${ledgerPath}`);
    console.log(`transactions: ${p.chunks.length}; rejected in simulation: ${p.rejected.length}; max fees ${formatUsdc18(p.preflight.fees18)} USDC`);
    for (const r of p.rejected) console.log(`  rejected row ${r.row.index + 1} (line ${r.row.line}): ${r.reason}`);
    if (!p.preflight.ok) fail(`balance ${formatUsdc18(p.preflight.balance18)} USDC is short by ${formatUsdc18(p.preflight.shortBy18)} USDC`);
  }
  if (values["retry-rejected"] && ledger.rows.some((r) => r.status === "rejected")) {
    ledger = requeueRejected(ledger);
    save(ledger);
    console.log("rejected rows are back in the queue; they are simulated again before sending");
  }

  const pending = ledger.rows.filter((r) => r.status === "planned" || r.status === "failed");
  const pending6 = pending.reduce((s, r) => s + BigInt(r.amount18) / 10n ** 12n, 0n);
  let confirmation = values.confirm;
  if (network.name === "mainnet") {
    if (confirmation !== MAINNET_CONFIRMATION)
      confirmation = await ask(`Mainnet: ${pending.length} rows, ${formatUnits(pending6, 6)} USDC. Type "${MAINNET_CONFIRMATION}" to send: `);
    assertMainnetAllowed(network, { confirmation, capUsdc: values.cap }, pending6);
  } else if (!values.yes && pending.length > 0) {
    const answer = await ask(`Send ${pending.length} rows, ${formatUnits(pending6, 6)} USDC on ${network.label}? [y/N] `);
    if (!/^y(es)?$/i.test(answer)) fail("cancelled; the ledger is saved and can be resumed");
  }

  const wallet = createWalletClient({ account, chain: network.chain, transport: http(network.rpcUrl, { retryCount: 4, retryDelay: 250 }) });
  try {
    const result = await executeLedger({
      chain: reader,
      sender: walletSender(wallet, account, network),
      network,
      ledger,
      gate: { confirmation, capUsdc: values.cap },
      chunkSize,
      onLedger: save,
      onEvent,
      requeueUnknown,
    });
    printLedger(result.ledger);
  } catch (err) {
    console.error(`stopped: ${errorMessage(err)}`);
    console.error(`the ledger at ${ledgerPath} is up to date; rerun the same command to resume`);
    process.exit(1);
  }
}

main().catch((err) => fail(errorMessage(err)));

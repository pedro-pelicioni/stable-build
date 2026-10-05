import { useMemo, useState } from "react";
import type { Address, WalletClient } from "viem";
import sampleCsv from "../sample/payroll.csv?raw";
import {
  FAUCET_URL,
  MAINNET_CONFIRMATION,
  explorerAddressUrl,
  getNetwork,
  resolveNetworkName,
} from "./config/networks";
import { createReader, readerPort, walletSender, type ChainPort } from "./core/chain";
import { parsePayoutCsv, type CsvParseResult } from "./core/csv";
import { classifyCode, type AccountKind } from "./core/eoa-guard";
import { formatUsdc18, ledgerToCsv, ledgerToJson, parseLedgerJson, requeueRejected, rowsDigest, summarize, type Ledger } from "./core/ledger";
import { executeLedger, prepareBatch, rebuildFromHistory, syncLedger, type PreparedBatch, type RunEvent } from "./core/run";
import { errorMessage } from "./core/rpc-errors";
import { RowsTable } from "./ui/RowsTable";
import { download, findLedger, loadLedger, saveLedger } from "./ui/storage";
import { connectWallet } from "./ui/wallet";

// Only named VITE_* properties are read: iterating the whole env object would make Vite inline every
// VITE_* value into the bundle. A value shaped like a private key fails the build (vite.config.ts).
const network = getNetwork(resolveNetworkName(import.meta.env.VITE_NETWORK), import.meta.env.VITE_RPC_URL || undefined);
const isMainnet = network.name === "mainnet";

function describeEvent(e: RunEvent): string {
  switch (e.type) {
    case "info":
      return e.message;
    case "rejected":
      return `rejected ${e.rows.length} row(s): ${e.rows.map((r) => `#${r.row.index + 1} ${r.reason}`).join("; ")}`;
    case "sent":
      return `sent rows ${e.rows.map((i) => i + 1).join(", ")} in ${e.hash}`;
    case "confirmed":
      return `confirmed ${e.hash}: ${e.paid}/${e.rows.length} rows reconciled (${e.latencyMs} ms)`;
    case "recovered":
      return `found earlier payment ${e.hash} in Memo history`;
  }
}

export function App() {
  const reader: ChainPort = useMemo(() => readerPort(createReader(network)), []);
  const [wallet, setWallet] = useState<WalletClient | null>(null);
  const [account, setAccount] = useState<Address | null>(null);
  const [kind, setKind] = useState<AccountKind | null>(null);
  const [balance18, setBalance18] = useState<bigint | null>(null);
  const [csv, setCsv] = useState<CsvParseResult | null>(null);
  const [prepared, setPrepared] = useState<PreparedBatch | null>(null);
  const [ledger, setLedgerState] = useState<Ledger | null>(() => loadLedger());
  const [confirmation, setConfirmation] = useState("");
  const [cap, setCap] = useState("");
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const setLedger = (l: Ledger | null) => {
    setLedgerState(l);
    if (l) saveLedger(l);
  };
  const note = (m: string) => setLog((prev) => [...prev.slice(-49), `${new Date().toLocaleTimeString()}  ${m}`]);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const refreshAccount = async (a: Address) => {
    setKind(classifyCode(await reader.getCode(a)));
    setBalance18(await reader.getBalance(a));
  };

  const onConnect = () =>
    run(async () => {
      const c = await connectWallet(network);
      setWallet(c.wallet);
      setAccount(c.account);
      await refreshAccount(c.account);
    });

  const onCsv = (text: string) => {
    setCsv(parsePayoutCsv(text));
    setPrepared(null);
  };

  // The typed mainnet confirmation and the cap cover one send of one batch: clear them after every
  // send and whenever another batch is planned or imported.
  const clearGate = () => {
    setConfirmation("");
    setCap("");
  };

  const sameBatch = (l: Ledger | null, parsed: CsvParseResult | null) =>
    !!l && !!parsed && !!account && l.rowsDigest === rowsDigest(parsed.rows) && l.account.toLowerCase() === account.toLowerCase() && l.network === network.name;

  const onPlan = () =>
    run(async () => {
      if (!account || !csv || csv.errors.length > 0) return;
      clearGate();
      // A ledger saved in this browser for this file, account and network: resume it.
      const saved = findLedger(network.name, account, rowsDigest(csv.rows)) ?? (sameBatch(ledger, csv) ? ledger : null);
      if (saved) {
        note(`this file matches saved batch ${saved.batchId}; resuming it instead of starting a new one`);
        setLedger(await syncLedger({ chain: reader, network, ledger: saved, onEvent: (e) => note(describeEvent(e)) }));
        setPrepared(null);
        return;
      }
      // Otherwise prepareBatch looks for these references in the account's Memo history: a file that
      // was paid before (another browser, a cleared cache) resumes its batch or is refused.
      const p = await prepareBatch({ chain: reader, network, account, rows: csv.rows, onEvent: (e) => note(describeEvent(e)) });
      setPrepared(p);
      setLedger(p.ledger);
      note(
        p.resumed
          ? `resumed batch ${p.ledger.batchId} from Memo history: ${p.resumed.paidRows} row(s) already paid, ${p.chunks.length} transaction(s) left`
          : `planned batch ${p.ledger.batchId}: ${p.chunks.length} transaction(s), ${p.rejected.length} rejected row(s)`,
      );
    });

  const onSend = () =>
    run(async () => {
      if (!wallet || !account || !ledger) return;
      try {
        const result = await executeLedger({
          chain: reader,
          sender: walletSender(wallet, account, network),
          network,
          ledger,
          gate: { confirmation, capUsdc: cap },
          onLedger: (l) => setLedger(l),
          onEvent: (e) => note(describeEvent(e)),
        });
        setLedger(result.ledger);
        await refreshAccount(account);
      } finally {
        clearGate();
      }
    });

  const onRequeueRejected = () => {
    if (!ledger) return;
    setLedger(requeueRejected(ledger));
    note("rejected rows are back in the queue; they are simulated again before sending");
  };

  const onRequeueUnknown = () =>
    run(async () => {
      if (!ledger) return;
      const ok = window.confirm(
        "Only continue after checking the explorer: rows of transactions the RPC does not know (and that Memo history does not show as paid) go back to the queue and can be sent again.",
      );
      if (!ok) return;
      setLedger(await syncLedger({ chain: reader, network, ledger, requeueUnknown: true, onEvent: (e) => note(describeEvent(e)) }));
    });

  const onRebuild = () =>
    run(async () => {
      if (!ledger) return;
      const rows = await rebuildFromHistory({ chain: reader, account: ledger.account, fromBlock: BigInt(ledger.startBlock), batchId: ledger.batchId });
      note(`found ${rows.length} row(s) of batch ${ledger.batchId} in Memo history`);
      setLedger(await syncLedger({ chain: reader, network, ledger, onEvent: (e) => note(describeEvent(e)) }));
    });

  const onImport = async (file: File) => {
    try {
      setLedger(parseLedgerJson(await file.text()));
      setPrepared(null);
      clearGate();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const summary = ledger ? summarize(ledger) : null;
  const mainnetReady = !isMainnet || (confirmation === MAINNET_CONFIRMATION && cap.trim() !== "");
  const canSend = !!wallet && !!ledger && kind === "eoa" && mainnetReady && !busy && ledger.account.toLowerCase() === account?.toLowerCase();

  return (
    <main className="page">
      {isMainnet ? (
        <div className="banner banner-danger" role="alert">
          Arc mainnet: this app sends real USDC. Every send needs the typed confirmation and a per-batch cap.
        </div>
      ) : (
        <div className="banner banner-info">
          Arc Testnet. Get test USDC at{" "}
          <a href={FAUCET_URL} target="_blank" rel="noreferrer">
            faucet.circle.com
          </a>
          .
        </div>
      )}

      <header>
        <h1>{"{{APP_NAME}}"}</h1>
        <p className="lede">Pay a CSV of recipients in USDC. Each row carries a memo, batches go out as one transaction, and every row is reconciled against its receipt.</p>
        <p className="privacy">
          Privacy: recipients, amounts and memos are public onchain forever. Use opaque references (INV-0042), never names, emails or notes.
        </p>
      </header>

      <section>
        <h2>1. Wallet</h2>
        {account ? (
          <div className="kv">
            <div>
              Account{" "}
              <a className="mono" href={explorerAddressUrl(network, account)} target="_blank" rel="noreferrer">
                {account}
              </a>
            </div>
            <div>
              Type: <strong>{kind === "eoa" ? "EOA (supported)" : kind === "eip7702-delegated" ? "EIP-7702 delegated (refused)" : "contract account (refused)"}</strong>
            </div>
            <div>Balance: {balance18 === null ? "…" : `${formatUsdc18(balance18)} USDC`}</div>
          </div>
        ) : (
          <button onClick={onConnect} disabled={busy}>
            Connect wallet
          </button>
        )}
        <p className="hint">Use a plain EOA wallet. Smart accounts and multisig contract wallets cannot call the Memo and Multicall3From contracts.</p>
      </section>

      <section>
        <h2>2. Payout file</h2>
        <p className="hint">
          CSV columns: <code>recipient,amount,reference</code>. Amounts in USDC with up to 6 decimals.
        </p>
        <div className="row-actions">
          <input type="file" accept=".csv,text/csv" onChange={async (e) => e.target.files?.[0] && onCsv(await e.target.files[0].text())} />
          <button className="secondary" onClick={() => onCsv(sampleCsv)}>
            Load sample
          </button>
        </div>
        {csv ? (
          <div className="kv">
            <div>
              Rows: {csv.count}. Total: {formatUsdc18(csv.total6 * 10n ** 12n)} USDC.
            </div>
            {csv.errors.map((e, i) => (
              <div key={`e${i}`} className="error">
                Line {e.line} {e.field}: {e.message}
              </div>
            ))}
            {csv.warnings.map((w, i) => (
              <div key={`w${i}`} className="warning">
                Line {w.line} {w.field}: {w.message}
              </div>
            ))}
          </div>
        ) : null}
        <button onClick={onPlan} disabled={busy || !account || !csv || csv.errors.length > 0 || csv.count === 0}>
          Simulate and plan
        </button>
      </section>

      {prepared ? (
        <section>
          <h2>3. Review</h2>
          <div className="kv">
            <div>
              Transactions: {prepared.chunks.length} ({prepared.chunks.map((c) => c.rows.length).join(" + ")} rows)
            </div>
            <div>Rejected in simulation: {prepared.rejected.length}</div>
            <div>Payouts: {formatUsdc18(prepared.preflight.payouts18)} USDC</div>
            <div>Max network fees: {formatUsdc18(prepared.preflight.fees18)} USDC</div>
            <div className={prepared.preflight.ok ? "" : "error"}>
              Balance: {formatUsdc18(prepared.preflight.balance18)} USDC {prepared.preflight.ok ? "(enough)" : `(short by ${formatUsdc18(prepared.preflight.shortBy18)} USDC)`}
            </div>
          </div>
        </section>
      ) : null}

      {ledger && summary ? (
        <section>
          <h2>4. Send and reconcile</h2>
          <div className="kv">
            <div className="mono">Batch {ledger.batchId}</div>
            <div>
              {summary.byStatus.paid} paid, {summary.byStatus.planned + summary.byStatus.failed} to send, {summary.byStatus.sent} in flight, {summary.byStatus.rejected} rejected,{" "}
              {summary.byStatus.mismatch} mismatched. Paid {formatUsdc18(summary.paid18)} of {formatUsdc18(summary.total18)} USDC.
            </div>
          </div>
          {isMainnet ? (
            <div className="gate">
              <label>
                Type <code>{MAINNET_CONFIRMATION}</code>
                <input value={confirmation} onChange={(e) => setConfirmation(e.target.value)} autoComplete="off" />
              </label>
              <label>
                Per-batch cap (USDC)
                <input value={cap} onChange={(e) => setCap(e.target.value)} inputMode="decimal" />
              </label>
            </div>
          ) : null}
          <div className="row-actions">
            <button onClick={onSend} disabled={!canSend}>
              Send pending rows
            </button>
            <button className="secondary" onClick={onRebuild} disabled={busy}>
              Rebuild from chain
            </button>
            {summary.byStatus.rejected > 0 ? (
              <button className="secondary" onClick={onRequeueRejected} disabled={busy}>
                Re-queue rejected rows
              </button>
            ) : null}
            {summary.byStatus.sent > 0 ? (
              <button className="secondary" onClick={onRequeueUnknown} disabled={busy}>
                Re-queue unknown sends
              </button>
            ) : null}
            <button className="secondary" onClick={() => download(`payouts-${ledger.batchId.slice(2, 10)}.csv`, ledgerToCsv(ledger), "text/csv")}>
              Export CSV
            </button>
            <button className="secondary" onClick={() => download(`payouts-${ledger.batchId.slice(2, 10)}.json`, ledgerToJson(ledger), "application/json")}>
              Export JSON
            </button>
          </div>
          <RowsTable rows={ledger.rows} />
        </section>
      ) : null}

      <section>
        <h2>Resume a batch</h2>
        <p className="hint">Import a ledger JSON you exported earlier. Rows already paid onchain are never sent again: their Memo events are found by memoId first.</p>
        <input type="file" accept="application/json,.json" onChange={(e) => e.target.files?.[0] && onImport(e.target.files[0])} />
      </section>

      {error ? (
        <div className="banner banner-danger" role="alert">
          {error}
        </div>
      ) : null}
      {log.length > 0 ? <pre className="log">{log.join("\n")}</pre> : null}

      <footer>
        Built from the stable-build payouts starter, a community project not affiliated with Circle. Docs:{" "}
        <a href="https://docs.arc.io/arc/tutorials/send-usdc-with-transaction-memo" target="_blank" rel="noreferrer">
          memos
        </a>
        ,{" "}
        <a href="https://docs.arc.io/arc/tutorials/batch-usdc-transfers" target="_blank" rel="noreferrer">
          batches
        </a>
        .
      </footer>
    </main>
  );
}

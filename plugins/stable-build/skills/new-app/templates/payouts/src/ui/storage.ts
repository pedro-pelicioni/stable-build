import { ledgerToJson, parseLedgerJson, type Ledger } from "../core/ledger";

// Per-browser convenience only. The exported JSON file (and the chain itself,
// via "Rebuild from chain") is the record of truth.
//
// One slot per (network, account, file): planning another file never overwrites the ledger of
// this one. If a different batch of the same file is saved while the stored one still has rows in
// flight ("sent"), the stored one is archived under its batch id instead of being replaced.
const PREFIX = "sb-payouts:ledger:";
const LAST = "sb-payouts:last";
const LEGACY = "sb-payouts:last-ledger";

function store(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function ledgerKey(network: string, account: string, rowsDigest: string): string {
  return `${PREFIX}${network}:${account.toLowerCase()}:${rowsDigest.toLowerCase()}`;
}

function read(key: string): Ledger | null {
  try {
    const text = store()?.getItem(key);
    return text ? parseLedgerJson(text) : null;
  } catch {
    return null;
  }
}

export function saveLedger(ledger: Ledger): void {
  const s = store();
  if (!s) return;
  const key = ledgerKey(ledger.network, ledger.account, ledger.rowsDigest);
  try {
    const current = read(key);
    if (current && current.batchId !== ledger.batchId && current.rows.some((r) => r.status === "sent"))
      s.setItem(`${key}:${current.batchId}`, ledgerToJson(current));
    s.setItem(key, ledgerToJson(ledger));
    s.setItem(LAST, key);
  } catch {
    // storage blocked or full: the in-memory ledger and exports still work
  }
}

/** The stored ledger for this file, account and network, if any. */
export function findLedger(network: string, account: string, rowsDigest: string): Ledger | null {
  return read(ledgerKey(network, account, rowsDigest));
}

/** The ledger saved most recently (shown when the page opens). */
export function loadLedger(): Ledger | null {
  const s = store();
  if (!s) return null;
  try {
    const key = s.getItem(LAST);
    if (key) return read(key);
    // single-slot storage from earlier versions of this starter
    const legacy = read(LEGACY);
    if (legacy) saveLedger(legacy);
    return legacy;
  } catch {
    return null;
  }
}

export function clearLedger(): void {
  try {
    store()?.removeItem(LAST);
  } catch {
    // ignore
  }
}

export function download(filename: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

import { formatUnits, getAddress, parseUnits, type Address, type Hex, type TransactionReceipt } from "viem";
import { MAINNET_CONFIRMATION, explorerTxUrl, type NetworkConfig } from "../config/networks";
import type { ChainPort, SenderPort } from "./chain";
import type { PayoutRow } from "./csv";
import { assertChain, assertEoa, assertReceiptFrom } from "./eoa-guard";
import {
  amount6Of,
  applyReconciliation,
  createLedger,
  expectedRows,
  formatUsdc18,
  markRejected,
  markSent,
  markUnsent,
  pendingRows,
  unresolvedSentRows,
  type Ledger,
  type LedgerRow,
} from "./ledger";
import { decodeMemoLog, getLogsPaged } from "./logs";
import { decodeMemo, memoIdMatches, newBatchId, type BatchId } from "./memo-schema";
import { sleep } from "./rpc-errors";
import {
  DEFAULT_CHUNK_SIZE,
  feesFor,
  isolateRejected,
  planRow,
  preflight,
  sizeChunks,
  txFor,
  withHeadroom,
  type PlannedRow,
  type Preflight,
  type RejectedRow,
  type SendMode,
  type SizedChunk,
} from "./plan";
import { reconcileReceipt, type ReconciledRow } from "./reconcile";

export type RunEvent =
  | { type: "info"; message: string }
  | { type: "rejected"; rows: RejectedRow[] }
  | { type: "sent"; hash: Hex; rows: number[] }
  | { type: "confirmed"; hash: Hex; rows: number[]; paid: number; latencyMs: number }
  | { type: "recovered"; hash: Hex; rows: number[] };

export interface MainnetGate {
  /** Must equal MAINNET_CONFIRMATION exactly. */
  confirmation?: string;
  /** Per-batch cap in USDC, e.g. "250". Required on mainnet. */
  capUsdc?: string;
}

export class GateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GateError";
  }
}

/** Mainnet needs the typed confirmation and a per-batch cap that covers the total. */
export function assertMainnetAllowed(network: NetworkConfig, gate: MainnetGate, total6: bigint): void {
  if (network.name !== "mainnet") return;
  if (gate.confirmation !== MAINNET_CONFIRMATION) throw new GateError(`mainnet send refused: type "${MAINNET_CONFIRMATION}" to confirm`);
  if (!gate.capUsdc || !/^\d+(\.\d{1,6})?$/.test(gate.capUsdc.trim())) throw new GateError("mainnet send refused: set a per-batch cap in USDC");
  const cap6 = parseUnits(gate.capUsdc.trim(), 6);
  if (total6 > cap6) throw new GateError(`mainnet send refused: batch total ${formatUnits(total6, 6)} USDC is above the cap ${gate.capUsdc} USDC`);
}

function plannedFromLedger(ledger: Ledger, rows: LedgerRow[]): PlannedRow[] {
  return rows.map((r) => {
    const payout: PayoutRow = { index: r.index, line: r.line, recipient: r.recipient, amount: r.amount, amount6: amount6Of(r), reference: r.reference };
    const planned = planRow(payout, ledger.batchId);
    if (planned.memoId.toLowerCase() !== r.memoId.toLowerCase() || planned.callDataHash.toLowerCase() !== r.callDataHash.toLowerCase())
      throw new Error(`ledger row ${r.index} does not match its memoId or calldata; refusing to send`);
    return planned;
  });
}

function simulator(chain: ChainPort, account: Address, mode: SendMode) {
  return async (rows: PlannedRow[]) => {
    const tx = txFor(rows, mode);
    await chain.call({ from: account, ...tx });
  };
}

function estimator(chain: ChainPort, account: Address, mode: SendMode) {
  return async (rows: PlannedRow[]) => chain.estimateGas({ from: account, ...txFor(rows, mode) });
}

/**
 * How far back a new batch looks for earlier payments of the same references (Memo events sent by
 * the account). 300,000 blocks is about 40 hours at the ~0.48 s testnet block time
 * (https://docs.arc.io/arc-chain). Each 9,999-block window is one eth_getLogs call: 31 calls, about
 * 25 s on the rate-limited public testnet RPC (measured 2026-10-04). Older payments are not seen, so
 * keep exported ledgers (web) and the ledgers/ folder (CLI), or pass a longer window.
 */
export const HISTORY_LOOKBACK_BLOCKS = 300_000n;

export interface PaidReference {
  reference: string;
  batchId: BatchId;
  rowIndex: number;
  memoId: Hex;
  txHash: Hex;
  blockNumber: bigint;
}

/** Memo events sent by `account` in [fromBlock, toBlock] whose v1 memo carries one of `references`
 * (case-insensitive). A Memo event exists only when the wrapped USDC transfer succeeded. */
export async function findPaidReferences(input: {
  chain: ChainPort;
  account: Address;
  references: string[];
  fromBlock: bigint;
  toBlock: bigint;
  onEvent?: (e: RunEvent) => void;
}): Promise<PaidReference[]> {
  const want = new Set(input.references.map((r) => r.toLowerCase()));
  if (want.size === 0 || input.toBlock < input.fromBlock) return [];
  let pages = 0;
  const total = (input.toBlock - input.fromBlock) / 9_999n + 1n;
  input.onEvent?.({ type: "info", message: `checking ${total} window(s) of Memo history for references already paid` });
  const logs = await getLogsPaged(input.chain.memoLogs(getAddress(input.account)), input.fromBlock, input.toBlock, {
    onPage: () => {
      if (++pages % 25 === 0) input.onEvent?.({ type: "info", message: `Memo history: ${pages} of ${total} windows checked` });
    },
  });
  const out: PaidReference[] = [];
  for (const log of logs) {
    const m = decodeMemoLog(log);
    const d = decodeMemo(m.memo);
    if (!d.ok || !memoIdMatches(m.memoId, d) || !want.has(d.memo.ref.toLowerCase())) continue;
    out.push({ reference: d.memo.ref, batchId: d.batchId, rowIndex: d.memo.i, memoId: m.memoId, txHash: m.txHash, blockNumber: m.blockNumber });
  }
  return out;
}

/** Some references in a new file were already paid onchain in a way this file cannot resume. */
export class AlreadyPaidError extends Error {
  constructor(public paid: PaidReference[]) {
    const list = paid.slice(0, 10).map((p) => `${p.reference} (tx ${p.txHash}, batch ${p.batchId})`).join("; ");
    super(
      `${paid.length} reference(s) in this file were already paid from this account: ${list}${paid.length > 10 ? "; ..." : ""}. ` +
        "Nothing was planned. Remove those rows (or use new references for a new pay run), or import the ledger of that batch to resume it.",
    );
    this.name = "AlreadyPaidError";
  }
}

/**
 * Looks for earlier payments of these rows' references. Returns null when none were found. When every
 * match belongs to one batch at the same row positions, that batch can be resumed under its batchId
 * (memoIds then match, and the Memo history scan marks the paid rows). Anything else throws
 * AlreadyPaidError so a file that was already paid is never paid again under a fresh batchId.
 */
export async function recoverBatch(input: {
  chain: ChainPort;
  account: Address;
  rows: PayoutRow[];
  head: bigint;
  lookbackBlocks?: bigint;
  onEvent?: (e: RunEvent) => void;
}): Promise<{ batchId: BatchId; startBlock: bigint; paid: PaidReference[] } | null> {
  const lookback = input.lookbackBlocks ?? HISTORY_LOOKBACK_BLOCKS;
  if (lookback <= 0n) return null;
  const fromBlock = input.head > lookback ? input.head - lookback : 0n;
  const paid = await findPaidReferences({ chain: input.chain, account: input.account, references: input.rows.map((r) => r.reference), fromBlock, toBlock: input.head, onEvent: input.onEvent });
  if (paid.length === 0) return null;
  const batchIds = new Set(paid.map((p) => p.batchId));
  const byRef = new Map(input.rows.map((r) => [r.reference.toLowerCase(), r]));
  const aligned = paid.every((p) => byRef.get(p.reference.toLowerCase())?.index === p.rowIndex);
  if (batchIds.size !== 1 || !aligned) throw new AlreadyPaidError(paid);
  const startBlock = paid.reduce((min, p) => (p.blockNumber < min ? p.blockNumber : min), paid[0].blockNumber);
  return { batchId: paid[0].batchId, startBlock, paid };
}

export interface PreparedBatch {
  ledger: Ledger;
  chunks: SizedChunk[];
  rejected: RejectedRow[];
  fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
  preflight: Preflight;
  blockGasLimit: bigint;
  /** Set when this file was found paid (in part) in Memo history and its batch was resumed. */
  resumed?: { batchId: BatchId; paidRows: number };
}

/** Plans a batch without sending: EOA and chain checks, a Memo history lookup for references
 * already paid (resume or refuse), per-row and per-chunk eth_call simulation, chunk sizing, fees
 * and the balance preflight. */
export async function prepareBatch(input: {
  chain: ChainPort;
  network: NetworkConfig;
  account: Address;
  rows: PayoutRow[];
  batchId?: BatchId;
  mode?: SendMode;
  chunkSize?: number;
  /** Blocks to look back for earlier payments of these references (default HISTORY_LOOKBACK_BLOCKS; 0n skips). */
  historyLookbackBlocks?: bigint;
  onEvent?: (e: RunEvent) => void;
}): Promise<PreparedBatch> {
  const { chain, network } = input;
  const account = getAddress(input.account);
  const mode = input.mode ?? "batch";
  await assertChain(() => chain.chainId(), network.chainId);
  await assertEoa((a) => chain.getCode(a), account);
  const block = await chain.getLatestBlock();
  let batchId = input.batchId;
  let startBlock = block.number;
  let resumed: PreparedBatch["resumed"];
  const found = batchId ? null : await recoverBatch({ chain, account, rows: input.rows, head: block.number, lookbackBlocks: input.historyLookbackBlocks, onEvent: input.onEvent });
  if (found) {
    batchId = found.batchId;
    startBlock = found.startBlock;
    input.onEvent?.({ type: "info", message: `${found.paid.length} row(s) of this file were already paid in batch ${found.batchId}; resuming that batch` });
  }
  batchId ??= newBatchId();
  const all = input.rows.map((row) => planRow(row, batchId));
  let ledger = createLedger({ network: network.name, chainId: network.chainId, account, batchId, mode, startBlock, rows: all });
  if (found) {
    ledger = await syncLedger({ chain, network, ledger, onEvent: input.onEvent });
    resumed = { batchId, paidRows: ledger.rows.filter((r) => r.status === "paid").length };
  }
  const open = new Set(pendingRows(ledger).map((r) => r.index));
  const planned = all.filter((p) => open.has(p.index));
  const fees = feesFor(block.baseFeePerGas);
  const balance18 = await chain.getBalance(account);
  // Without enough balance for the payouts themselves every simulation reverts;
  // report the shortfall instead of marking rows as rejected.
  const early = preflight(planned, 0n, fees.maxFeePerGas, balance18);
  if (!early.ok) return { ledger, chunks: [], rejected: [], fees, preflight: early, blockGasLimit: block.gasLimit, resumed };
  const sized = await sizeChunks(planned, {
    simulate: simulator(chain, account, mode),
    estimate: estimator(chain, account, mode),
    blockGasLimit: block.gasLimit,
    startSize: input.chunkSize ?? DEFAULT_CHUNK_SIZE,
    mode,
  });
  ledger = markRejected(ledger, sized.rejected);
  const gasTotal = sized.chunks.reduce((sum, c) => sum + withHeadroom(c.gas), 0n);
  const sendable = sized.chunks.flatMap((c) => c.rows);
  return { ledger, chunks: sized.chunks, rejected: sized.rejected, fees, preflight: preflight(sendable, gasTotal, fees.maxFeePerGas, balance18), blockGasLimit: block.gasLimit, resumed };
}

/** CLI `--sync` with no ledger file: rebuilds the ledger of an earlier batch of this file from Memo
 * history (by reference). Returns null when nothing of this file was paid in the lookback window. */
export async function recoverLedger(input: {
  chain: ChainPort;
  network: NetworkConfig;
  account: Address;
  rows: PayoutRow[];
  mode?: SendMode;
  historyLookbackBlocks?: bigint;
  onEvent?: (e: RunEvent) => void;
}): Promise<Ledger | null> {
  const { chain, network } = input;
  const account = getAddress(input.account);
  await assertChain(() => chain.chainId(), network.chainId);
  const head = (await chain.getLatestBlock()).number;
  const found = await recoverBatch({ chain, account, rows: input.rows, head, lookbackBlocks: input.historyLookbackBlocks, onEvent: input.onEvent });
  if (!found) return null;
  const planned = input.rows.map((row) => planRow(row, found.batchId));
  const ledger = createLedger({ network: network.name, chainId: network.chainId, account, batchId: found.batchId, mode: input.mode ?? "batch", startBlock: found.startBlock, rows: planned });
  return syncLedger({ chain, network, ledger, onEvent: input.onEvent });
}

/** A sent transaction the RPC does not know, whose rows Memo history does not show as paid. */
export class UnknownTransactionError extends Error {
  constructor(public hashes: Hex[]) {
    super(
      `transaction(s) ${hashes.join(", ")} are unknown to the RPC, and Memo history does not show their rows as paid. ` +
        "Check them on the explorer. If they never landed, put their rows back in the queue explicitly " +
        "(CLI: --requeue-unknown; web: Rebuild from chain, then Re-queue unknown sends) and resume.",
    );
    this.name = "UnknownTransactionError";
  }
}

async function reconcileHash(chain: ChainPort, network: NetworkConfig, ledger: Ledger, hash: Hex, receipt?: TransactionReceipt | null): Promise<Ledger> {
  const r = receipt ?? (await chain.getTransactionReceipt(hash));
  if (!r) return ledger;
  const inTx = ledger.rows.filter((row) => row.txHash?.toLowerCase() === hash.toLowerCase() || row.status !== "paid");
  const rec = reconcileReceipt(r, { account: ledger.account, expected: expectedRows(ledger, inTx) });
  return applyReconciliation(ledger, rec, (h) => explorerTxUrl(network, h));
}

/**
 * Brings a ledger up to date with the chain before anything is sent:
 * 1. sent rows: look up their receipts; a transaction that is gone and whose
 *    nonce is used by something else goes back to the queue;
 * 2. Memo events from this account since the batch start block (paged in
 *    9,999-block windows) mark rows that were paid but never recorded.
 * Rows already paid are therefore never sent again.
 */
export async function syncLedger(input: {
  chain: ChainPort;
  network: NetworkConfig;
  ledger: Ledger;
  onEvent?: (e: RunEvent) => void;
  /** Re-queue rows of sent transactions that the RPC does not know and history does not show as
   * paid, even when their nonce is unknown. Only after the user checked the explorer. */
  requeueUnknown?: boolean;
}): Promise<Ledger> {
  const { chain, network, onEvent } = input;
  let ledger = input.ledger;
  const hashes = [...new Set(unresolvedSentRows(ledger).map((r) => r.txHash).filter((h): h is Hex => !!h))];
  const unknown: Hex[] = [];
  for (const hash of hashes) {
    const receipt = await chain.getTransactionReceipt(hash);
    if (receipt) {
      ledger = await reconcileHash(chain, network, ledger, hash, receipt);
      continue;
    }
    const tx = await chain.getTransaction(hash);
    if (tx) {
      onEvent?.({ type: "info", message: `waiting for pending transaction ${hash}` });
      ledger = await reconcileHash(chain, network, ledger, hash, await chain.waitForReceipt(hash));
      continue;
    }
    unknown.push(hash); // decided after the history scan below
  }

  const open = new Set(ledger.rows.filter((r) => r.status !== "paid" && r.status !== "rejected").map((r) => r.memoId.toLowerCase()));
  if (open.size > 0) {
    const head = (await chain.getLatestBlock()).number;
    const logs = await getLogsPaged(chain.memoLogs(ledger.account), BigInt(ledger.startBlock), head);
    const txs = new Set<Hex>();
    for (const log of logs) {
      const m = decodeMemoLog(log);
      if (open.has(m.memoId.toLowerCase())) txs.add(m.txHash);
    }
    for (const hash of txs) {
      ledger = await reconcileHash(chain, network, ledger, hash);
      onEvent?.({ type: "recovered", hash, rows: ledger.rows.filter((r) => r.txHash === hash).map((r) => r.index) });
    }
  }

  // Unknown transactions whose rows history did not resolve: a used nonce means it can never land.
  const stuck: Hex[] = [];
  for (const hash of unknown) {
    const rows = ledger.rows.filter((r) => r.txHash === hash && r.status === "sent");
    if (rows.length === 0) continue;
    const nonce = rows.find((r) => r.nonce !== undefined)?.nonce;
    const used = await chain.getTransactionCount(ledger.account);
    if (nonce !== undefined && used > nonce) {
      ledger = markUnsent(ledger, rows.map((r) => r.index), `transaction ${hash} was dropped or replaced`);
    } else if (input.requeueUnknown) {
      ledger = markUnsent(ledger, rows.map((r) => r.index), `transaction ${hash} was unknown to the RPC; re-queued on request`);
    } else stuck.push(hash);
  }
  if (stuck.length > 0) throw new UnknownTransactionError(stuck);
  return ledger;
}

/** Nonce of a just-broadcast transaction. Load-balanced RPC backends can lag, so retry briefly. */
async function nonceOf(chain: ChainPort, hash: Hex, wait: (ms: number) => Promise<void>): Promise<number | undefined> {
  for (let i = 0; i < 4; i++) {
    const tx = await chain.getTransaction(hash).catch(() => null);
    if (tx) return tx.nonce;
    await wait(250 * 2 ** i);
  }
  return undefined;
}

/**
 * Sends every pending row of a ledger, one chunk at a time, waiting for each
 * receipt before the next chunk. Persist the ledger in `onLedger`: it is called
 * after every state change, including right after a transaction is broadcast.
 */
export async function executeLedger(input: {
  chain: ChainPort;
  sender: SenderPort;
  network: NetworkConfig;
  ledger: Ledger;
  gate?: MainnetGate;
  chunkSize?: number;
  onLedger?: (ledger: Ledger) => void | Promise<void>;
  onEvent?: (e: RunEvent) => void;
  requeueUnknown?: boolean;
  /** Delay function for the post-broadcast nonce lookup (tests pass a no-op). */
  wait?: (ms: number) => Promise<void>;
}): Promise<{ ledger: Ledger; sent: Hex[] }> {
  const { chain, sender, network, onEvent } = input;
  const save = async (l: Ledger) => {
    await input.onLedger?.(l);
    return l;
  };
  let ledger = input.ledger;
  const account = getAddress(ledger.account);
  if (getAddress(sender.account) !== account) throw new Error(`signer ${sender.account} is not the ledger account ${account}`);
  if (ledger.network !== network.name || ledger.chainId !== network.chainId) throw new Error(`ledger is for ${ledger.network} (${ledger.chainId}), not ${network.name}`);
  await assertChain(() => chain.chainId(), network.chainId);
  await assertEoa((a) => chain.getCode(a), account);

  ledger = await save(await syncLedger({ chain, network, ledger, onEvent, requeueUnknown: input.requeueUnknown }));
  const pending = pendingRows(ledger);
  const sent: Hex[] = [];
  if (pending.length === 0) {
    onEvent?.({ type: "info", message: "nothing to send: every row is paid or rejected" });
    return { ledger, sent };
  }
  assertMainnetAllowed(network, input.gate ?? {}, pending.reduce((s, r) => s + amount6Of(r), 0n));

  const mode = ledger.mode;
  const planned = plannedFromLedger(ledger, pending);
  const block = await chain.getLatestBlock();
  const early = preflight(planned, 0n, 0n, await chain.getBalance(account));
  if (!early.ok) throw new Error(`insufficient balance: need ${formatUsdc18(early.needed18)} USDC before fees, have ${formatUsdc18(early.balance18)} USDC`);
  const sized = await sizeChunks(planned, {
    simulate: simulator(chain, account, mode),
    estimate: estimator(chain, account, mode),
    blockGasLimit: block.gasLimit,
    startSize: input.chunkSize ?? DEFAULT_CHUNK_SIZE,
    mode,
  });
  if (sized.rejected.length > 0) {
    ledger = await save(markRejected(ledger, sized.rejected));
    onEvent?.({ type: "rejected", rows: sized.rejected });
  }
  const fees = feesFor(block.baseFeePerGas);
  const gasTotal = sized.chunks.reduce((sum, c) => sum + withHeadroom(c.gas), 0n);
  const check = preflight(sized.chunks.flatMap((c) => c.rows), gasTotal, fees.maxFeePerGas, await chain.getBalance(account));
  if (!check.ok) throw new Error(`insufficient balance: need ${formatUsdc18(check.needed18)} USDC including fees, have ${formatUsdc18(check.balance18)} USDC`);

  for (const chunk of sized.chunks) {
    // State may have moved since sizing: simulate again right before sending.
    let rows = chunk.rows;
    try {
      await simulator(chain, account, mode)(rows);
    } catch {
      const isolated = await isolateRejected(rows, simulator(chain, account, mode));
      if (isolated.rejected.length > 0) {
        ledger = await save(markRejected(ledger, isolated.rejected));
        onEvent?.({ type: "rejected", rows: isolated.rejected });
      }
      rows = isolated.ok;
      if (rows.length === 0) continue;
    }
    const tx = txFor(rows, mode);
    const gas = withHeadroom(rows === chunk.rows ? chunk.gas : await chain.estimateGas({ from: account, ...tx }));
    const latest = await chain.getLatestBlock();
    const f = feesFor(latest.baseFeePerGas);
    // A local key signs with the pending nonce we read here, so the ledger knows it before the
    // broadcast returns; a browser wallet picks its own and we ask the RPC for it afterwards.
    const nonce = sender.controlsNonce ? await chain.getTransactionCount(account, "pending") : undefined;
    const started = Date.now();
    const hash = await sender.send({ ...tx, gas, ...f, ...(nonce !== undefined ? { nonce } : {}) });
    sent.push(hash);
    const indices = rows.map((r) => r.index);
    ledger = await save(markSent(ledger, indices, hash, explorerTxUrl(network, hash), nonce));
    onEvent?.({ type: "sent", hash, rows: indices });
    if (nonce === undefined) {
      const known = await nonceOf(chain, hash, input.wait ?? sleep);
      if (known !== undefined) ledger = await save({ ...ledger, rows: ledger.rows.map((r) => (indices.includes(r.index) ? { ...r, nonce: known } : r)) });
    }
    const receipt = await chain.waitForReceipt(hash);
    const latencyMs = Date.now() - started;
    assertReceiptFrom(receipt, account);
    // The wallet can cancel or speed up a transaction: viem then returns the replacement's receipt.
    const replacedBy = receipt.transactionHash.toLowerCase() !== hash.toLowerCase() ? receipt.transactionHash : null;
    const rec = reconcileReceipt(receipt, { account, expected: expectedRows(ledger, ledger.rows.filter((r) => indices.includes(r.index))) });
    ledger = await save(applyReconciliation(ledger, rec, (h) => explorerTxUrl(network, h)));
    onEvent?.({ type: "confirmed", hash: receipt.transactionHash, rows: indices, paid: rec.rows.filter((r) => r.ok).length, latencyMs });
    if (replacedBy) {
      const unpaid = indices.filter((i) => ledger.rows.find((r) => r.index === i)?.status === "sent");
      if (unpaid.length > 0) {
        ledger = await save(markUnsent(ledger, unpaid, `transaction ${hash} was replaced by ${replacedBy} in the wallet; not paid`));
        throw new Error(`transaction ${hash} was cancelled or replaced in the wallet by ${replacedBy}: ${unpaid.length} row(s) were not paid and went back to the queue. Stopping; resume when ready.`);
      }
      onEvent?.({ type: "info", message: `transaction ${hash} was replaced by ${replacedBy} (sped up); every row reconciled` });
    }
    if (rec.status !== "success") throw new Error(`transaction ${hash} reverted; rows went back to the queue. Investigate before resuming.`);
    if (rec.missing.length > 0) throw new Error(`transaction ${hash} succeeded without Memo events for ${rec.missing.length} row(s); they went back to the queue. Investigate before resuming.`);
    if (rec.rows.some((r) => !r.ok)) throw new Error(`transaction ${hash} has rows that do not reconcile; see the ledger before resuming`);
  }
  return { ledger, sent };
}

/** Rebuilds paid rows from chain history alone: Memo events sent by `account`
 * (paged), their receipts, and per-frame reconciliation. */
export async function rebuildFromHistory(input: { chain: ChainPort; account: Address; fromBlock: bigint; toBlock?: bigint; batchId?: BatchId }): Promise<ReconciledRow[]> {
  const { chain } = input;
  const account = getAddress(input.account);
  const toBlock = input.toBlock ?? (await chain.getLatestBlock()).number;
  const logs = await getLogsPaged(chain.memoLogs(account), input.fromBlock, toBlock);
  const hashes = [...new Set(logs.map((l) => l.transactionHash as Hex))];
  const out: ReconciledRow[] = [];
  for (const hash of hashes) {
    const receipt = await chain.getTransactionReceipt(hash);
    if (!receipt) continue;
    const rec = reconcileReceipt(receipt, { account });
    for (const row of rec.rows) {
      if (input.batchId && !(row.memo.ok && row.memo.batchId === input.batchId)) continue;
      out.push(row);
    }
  }
  return out;
}

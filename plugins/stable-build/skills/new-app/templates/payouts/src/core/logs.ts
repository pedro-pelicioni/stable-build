import { decodeEventLog, pad, toEventSelector, type Address, type Hex, type Log } from "viem";
import { memoAbi } from "../config/abis";
import { ADDRESSES } from "../config/networks";
import { RPC_BLOCK_NOT_READY, RPC_RANGE_TOO_LARGE, isRateLimited, rpcErrorCode, sleep } from "./rpc-errors";

/**
 * eth_getLogs on Arc's public endpoints rejects ranges above 10,000 blocks with
 * -32012 and asks clients to page in chunks of at most 9,999 blocks. The
 * load-balanced primary endpoint can answer -32014 for blocks near the head;
 * those requests are retried after a short backoff.
 * Source: https://docs.arc.io/arc/references/rpc-endpoints
 */
export const MAX_BLOCKS_PER_QUERY = 9_999n;

export type FetchLogs = (fromBlock: bigint, toBlock: bigint) => Promise<Log[]>;

export interface PagingOptions {
  /** Blocks per request, inclusive. Clamped to 1..9,999. */
  maxBlocks?: bigint;
  /** Retries per page for -32014 and HTTP 429. */
  maxRetries?: number;
  baseDelayMs?: number;
  wait?: (ms: number) => Promise<void>;
  onPage?: (page: { fromBlock: bigint; toBlock: bigint; logs: number }) => void;
  signal?: AbortSignal;
}

/** Pages [fromBlock, toBlock] in windows of at most 9,999 blocks.
 * -32012: halve the window. -32014 or 429: back off and retry the same window. */
export async function getLogsPaged(fetchLogs: FetchLogs, fromBlock: bigint, toBlock: bigint, opts: PagingOptions = {}): Promise<Log[]> {
  if (toBlock < fromBlock) return [];
  let span = opts.maxBlocks ?? MAX_BLOCKS_PER_QUERY;
  if (span > MAX_BLOCKS_PER_QUERY) span = MAX_BLOCKS_PER_QUERY;
  if (span < 1n) span = 1n;
  const maxRetries = opts.maxRetries ?? 6;
  const base = opts.baseDelayMs ?? 250;
  const wait = opts.wait ?? sleep;
  const out: Log[] = [];
  let start = fromBlock;
  let retries = 0;
  while (start <= toBlock) {
    if (opts.signal?.aborted) throw new Error("aborted");
    const end = start + span - 1n > toBlock ? toBlock : start + span - 1n;
    try {
      const logs = await fetchLogs(start, end);
      out.push(...logs);
      opts.onPage?.({ fromBlock: start, toBlock: end, logs: logs.length });
      start = end + 1n;
      retries = 0;
    } catch (err) {
      const code = rpcErrorCode(err);
      if (code === RPC_RANGE_TOO_LARGE && end > start) {
        span = (end - start + 1n) / 2n;
        if (span < 1n) span = 1n;
        continue;
      }
      if ((code === RPC_BLOCK_NOT_READY || isRateLimited(err)) && retries < maxRetries) {
        await wait(base * 2 ** retries);
        retries++;
        continue;
      }
      throw err;
    }
  }
  return out;
}

export const MEMO_EVENT_TOPIC = toEventSelector("Memo(address,address,bytes32,bytes32,bytes,uint256)");
export const BEFORE_MEMO_EVENT_TOPIC = toEventSelector("BeforeMemo(uint256)");

/** Minimal JSON-RPC surface used for log queries (a viem PublicClient fits). */
export interface LogsClient {
  request(args: { method: "eth_getLogs"; params: [unknown] }): Promise<unknown>;
}

/** eth_getLogs for Memo events sent by `sender`, one window per call. */
export function memoLogsFetcher(client: LogsClient, sender: Address): FetchLogs {
  return async (fromBlock, toBlock) => {
    const result = await client.request({
      method: "eth_getLogs",
      params: [
        {
          address: ADDRESSES.MEMO,
          topics: [MEMO_EVENT_TOPIC, pad(sender.toLowerCase() as Hex, { size: 32 })],
          fromBlock: `0x${fromBlock.toString(16)}`,
          toBlock: `0x${toBlock.toString(16)}`,
        },
      ],
    });
    return normalizeLogs(result as RawLog[]);
  };
}

export interface MemoLog {
  txHash: Hex;
  blockNumber: bigint;
  logIndex: number;
  sender: Address;
  target: Address;
  callDataHash: Hex;
  memoId: Hex;
  memo: Hex;
  memoIndex: bigint;
}

export function decodeMemoLog(log: Log): MemoLog {
  const ev = decodeEventLog({ abi: memoAbi, eventName: "Memo", data: log.data, topics: log.topics as [Hex, ...Hex[]] });
  return {
    txHash: log.transactionHash as Hex,
    blockNumber: log.blockNumber as bigint,
    logIndex: Number(log.logIndex),
    sender: ev.args.sender,
    target: ev.args.target,
    callDataHash: ev.args.callDataHash,
    memoId: ev.args.memoId,
    memo: ev.args.memo,
    memoIndex: ev.args.memoIndex,
  };
}

/** Raw JSON-RPC log (hex quantities), as returned by eth_getLogs and receipts. */
export interface RawLog {
  address: Hex;
  topics: Hex[];
  data: Hex;
  blockNumber: Hex | null;
  blockHash: Hex | null;
  transactionHash: Hex | null;
  transactionIndex: Hex | null;
  logIndex: Hex | null;
  removed?: boolean;
}

export function normalizeLogs(raw: RawLog[]): Log[] {
  return raw.map((l) => ({
    address: l.address,
    topics: l.topics as [Hex, ...Hex[]],
    data: l.data,
    blockNumber: l.blockNumber === null ? null : BigInt(l.blockNumber),
    blockHash: l.blockHash,
    transactionHash: l.transactionHash,
    transactionIndex: l.transactionIndex === null ? null : Number(l.transactionIndex),
    logIndex: l.logIndex === null ? null : Number(l.logIndex),
    removed: Boolean(l.removed),
  })) as Log[];
}

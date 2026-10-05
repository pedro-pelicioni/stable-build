import {
  createPublicClient,
  http,
  type Account,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from "viem";
import { POLLING_INTERVAL_MS, type NetworkConfig } from "../config/networks";
import { memoLogsFetcher, type FetchLogs, type LogsClient } from "./logs";
import { withArcRetry } from "./rpc-errors";

/** Everything the payout engine reads from the chain. Tests replace it with a fake. */
export interface ChainPort {
  chainId(): Promise<number>;
  getCode(address: Address): Promise<Hex | undefined>;
  getBalance(address: Address): Promise<bigint>;
  getLatestBlock(): Promise<{ number: bigint; gasLimit: bigint; baseFeePerGas: bigint | null }>;
  /** eth_call; throws on revert. */
  call(tx: { from: Address; to: Address; data: Hex }): Promise<Hex | undefined>;
  estimateGas(tx: { from: Address; to: Address; data: Hex }): Promise<bigint>;
  getTransactionReceipt(hash: Hex): Promise<TransactionReceipt | null>;
  waitForReceipt(hash: Hex, timeoutMs?: number): Promise<TransactionReceipt>;
  getTransaction(hash: Hex): Promise<{ nonce: number; blockNumber: bigint | null } | null>;
  /** Nonce count; "pending" includes transactions in the mempool. */
  getTransactionCount(address: Address, blockTag?: "latest" | "pending"): Promise<number>;
  /** One eth_getLogs window of Memo events sent by `sender`. Paging is done by the caller. */
  memoLogs(sender: Address): FetchLogs;
}

export interface TxRequest {
  to: Address;
  data: Hex;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  /** Set only when the sender signs with this nonce (controlsNonce). */
  nonce?: number;
}

/** Signs and broadcasts. Browser wallets use eth_sendTransaction (never wallet_sendCalls). */
export interface SenderPort {
  account: Address;
  /** True when send() signs with the nonce it is given (a local key). Browser wallets pick their own. */
  controlsNonce?: boolean;
  send(tx: TxRequest): Promise<Hex>;
}

export function createReader(network: NetworkConfig): PublicClient {
  return createPublicClient({
    chain: network.chain,
    // viem retries HTTP 429 with backoff and honours Retry-After.
    transport: http(network.rpcUrl, { retryCount: 4, retryDelay: 250 }),
    pollingInterval: POLLING_INTERVAL_MS,
  });
}

/** Minimum gap between eth_getLogs calls. Arc's public testnet RPC answers bursts of history pages
 * with HTTP 429 / -32005 (observed 2026-10-04 at about 5 requests per second; the limit is not
 * documented: UNVERIFIED); spacing them keeps long history scans moving. */
export const LOGS_MIN_INTERVAL_MS = 250;

function paced(fetchLogs: FetchLogs, clock: { last: number }): FetchLogs {
  return async (from, to) => {
    const gap = clock.last + LOGS_MIN_INTERVAL_MS - Date.now();
    if (gap > 0) await new Promise((resolve) => setTimeout(resolve, gap));
    clock.last = Date.now();
    return fetchLogs(from, to);
  };
}

export function readerPort(client: PublicClient): ChainPort {
  const r = <T>(fn: () => Promise<T>) => withArcRetry(fn);
  const logsClock = { last: 0 };
  return {
    chainId: () => r(() => client.getChainId()),
    getCode: (address) => r(() => client.getCode({ address })),
    getBalance: (address) => r(() => client.getBalance({ address })),
    getLatestBlock: async () => {
      const b = await r(() => client.getBlock({ blockTag: "latest" }));
      return { number: b.number, gasLimit: b.gasLimit, baseFeePerGas: b.baseFeePerGas ?? null };
    },
    // -32014 and 429 are retried here; reverts and other errors reach the caller unchanged.
    call: async (tx) => (await r(() => client.call({ account: tx.from, to: tx.to, data: tx.data }))).data,
    estimateGas: (tx) => r(() => client.estimateGas({ account: tx.from, to: tx.to, data: tx.data })),
    getTransactionReceipt: async (hash) => {
      try {
        return await r(() => client.getTransactionReceipt({ hash }));
      } catch (err) {
        if ((err as { name?: string }).name === "TransactionReceiptNotFoundError") return null;
        throw err;
      }
    },
    waitForReceipt: (hash, timeoutMs = 120_000) =>
      client.waitForTransactionReceipt({ hash, pollingInterval: POLLING_INTERVAL_MS, timeout: timeoutMs }),
    getTransaction: async (hash) => {
      try {
        const tx = await r(() => client.getTransaction({ hash }));
        return { nonce: tx.nonce, blockNumber: tx.blockNumber ?? null };
      } catch (err) {
        if ((err as { name?: string }).name === "TransactionNotFoundError") return null;
        throw err;
      }
    },
    getTransactionCount: (address, blockTag = "latest") => r(() => client.getTransactionCount({ address, blockTag })),
    memoLogs: (sender) => paced(memoLogsFetcher(client as unknown as LogsClient, sender) as (from: bigint, to: bigint) => Promise<Log[]>, logsClock),
  };
}

/** Sender backed by a viem WalletClient: a local account (CLI) or an injected
 * browser wallet (EIP-1193). Uses sendTransaction, a single EOA transaction. */
export function walletSender(wallet: WalletClient, account: Account | Address, network: NetworkConfig): SenderPort {
  const address = typeof account === "string" ? account : account.address;
  const local = typeof account !== "string" && account.type === "local";
  return {
    account: address,
    controlsNonce: local,
    send: (tx) =>
      wallet.sendTransaction({
        account,
        chain: network.chain,
        to: tx.to,
        data: tx.data,
        gas: tx.gas,
        maxFeePerGas: tx.maxFeePerGas,
        maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
        ...(local && tx.nonce !== undefined ? { nonce: tx.nonce } : {}),
      }),
  };
}

import { decodeErrorResult, type Hex } from "viem";
import { memoAbi } from "../config/abis";

/** JSON-RPC error codes documented for Arc's public endpoints.
 * Source: https://docs.arc.io/arc/references/rpc-endpoints */
export const RPC_RANGE_TOO_LARGE = -32012; // eth_getLogs range above 10,000 blocks
export const RPC_BLOCK_NOT_READY = -32014; // load-balanced backend has not imported the block yet

/** Walks an error and its `cause` chain (viem nests errors several levels deep). */
export function* errorChain(err: unknown): Generator<Record<string, unknown>> {
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    yield current as Record<string, unknown>;
    current = (current as { cause?: unknown }).cause;
  }
}

export function rpcErrorCode(err: unknown): number | undefined {
  for (const e of errorChain(err)) {
    if (typeof e.code === "number") return e.code;
  }
  return undefined;
}

export function httpStatus(err: unknown): number | undefined {
  for (const e of errorChain(err)) {
    if (typeof e.status === "number") return e.status;
  }
  return undefined;
}

/** HTTP 429, or JSON-RPC -32005 ("rate limit exceeded"; viem: "Request exceeds defined limit"),
 * which Arc's public testnet RPC returns together with HTTP 429. */
export const RPC_LIMIT_EXCEEDED = -32005;

export function isRateLimited(err: unknown): boolean {
  const code = rpcErrorCode(err);
  return httpStatus(err) === 429 || code === 429 || code === RPC_LIMIT_EXCEEDED;
}

export function errorMessage(err: unknown): string {
  for (const e of errorChain(err)) {
    if (typeof e.shortMessage === "string" && e.shortMessage) return e.shortMessage;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

function findRevertData(err: unknown): Hex | undefined {
  for (const e of errorChain(err)) {
    const d = e.data;
    if (typeof d === "string" && /^0x[0-9a-fA-F]*$/.test(d) && d.length >= 10) return d as Hex;
    if (d && typeof d === "object" && typeof (d as { data?: unknown }).data === "string") {
      const inner = (d as { data: string }).data;
      if (/^0x[0-9a-fA-F]*$/.test(inner) && inner.length >= 10) return inner as Hex;
    }
  }
  return undefined;
}

/** Human-readable revert reason. Unwraps Memo's MemoFailed(bytes) and Error(string). */
export function decodeRevertData(data: Hex, depth = 0): string {
  if (depth > 3) return data;
  try {
    const decoded = decodeErrorResult({ abi: memoAbi, data });
    if (decoded.errorName === "MemoFailed") {
      const inner = decoded.args?.[0] as Hex | undefined;
      return `MemoFailed: ${inner && inner.length >= 10 ? decodeRevertData(inner, depth + 1) : "no reason"}`;
    }
    if (decoded.errorName === "Error") return String(decoded.args?.[0]);
    return `${decoded.errorName}(${(decoded.args ?? []).map(String).join(", ")})`;
  } catch {
    return `unknown revert ${data.slice(0, 10)}`;
  }
}

/**
 * True when the node executed the call and it reverted (revert data, or an execution-reverted error).
 * HTTP failures, timeouts and rate limits are not reverts: the row may be fine, so it must not be
 * marked rejected for them.
 */
export function isRevertError(err: unknown): boolean {
  if (findRevertData(err)) return true;
  for (const e of errorChain(err)) {
    if (typeof e.status === "number") return false; // an HTTP-level failure
    if (e.name === "ExecutionRevertedError" || e.name === "ContractFunctionRevertedError") return true;
    if (e.code === 3) return true;
    const msg = typeof e.details === "string" ? e.details : typeof e.message === "string" ? e.message : "";
    if (/execution reverted/i.test(msg)) return true;
  }
  return false;
}

/** The RPC could not answer (HTTP error, timeout, rate limit, block not imported yet). It says
 * nothing about the request itself, so callers stop instead of drawing conclusions from it. */
export function isTransientRpcError(err: unknown): boolean {
  for (const e of errorChain(err)) {
    if (typeof e.status === "number") return true;
    if (e.name === "HttpRequestError" || e.name === "TimeoutError" || e.name === "WebSocketRequestError") return true;
    if (e.code === RPC_BLOCK_NOT_READY || e.code === 429 || e.code === RPC_LIMIT_EXCEEDED) return true;
    const msg = typeof e.message === "string" ? e.message : "";
    if (/timed? ?out|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|network error/i.test(msg)) return true;
  }
  return false;
}

/** A revert caused by the payer's balance, not by the row: never a reason to reject the row. */
export function isBalanceRevert(reason: string): boolean {
  return /exceeds balance|insufficient (?:funds|balance)/i.test(reason);
}

export class InsufficientBalanceError extends Error {
  constructor(reason: string) {
    super(`the account balance no longer covers this batch (${reason}); top up and resume`);
    this.name = "InsufficientBalanceError";
  }
}

export function revertReason(err: unknown): string {
  const data = findRevertData(err);
  if (data) return decodeRevertData(data);
  return errorMessage(err);
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Retries a call that failed with -32014 (block not yet imported) or HTTP 429. */
export async function withArcRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; baseDelayMs?: number; wait?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 6;
  const base = opts.baseDelayMs ?? 250;
  const wait = opts.wait ?? sleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const retryable = rpcErrorCode(err) === RPC_BLOCK_NOT_READY || isRateLimited(err);
      if (!retryable || attempt >= attempts - 1) throw err;
      const jitter = Math.floor(Math.random() * base);
      await wait(base * 2 ** attempt + jitter);
    }
  }
}

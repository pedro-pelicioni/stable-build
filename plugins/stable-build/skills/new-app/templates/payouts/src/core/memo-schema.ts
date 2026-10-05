import { bytesToHex, encodePacked, hexToBytes, keccak256, type Hex } from "viem";

/**
 * Memo schema v1 (see docs/memo-schema.md and docs/memo-schema.v1.json).
 *
 *   memoId    = keccak256(abi.encodePacked(bytes16 batchId, uint32 rowIndex))
 *   memoBytes = UTF-8 JSON, at most 256 bytes:
 *               {"v":1,"app":"sb-payouts","b":"<batchId hex, 32 chars>","i":<row>,"ref":"<ref>"}
 *
 * Memo bytes are public forever. Only opaque references go in them.
 * Memo contract reference: https://docs.arc.io/arc/concepts/transaction-memos
 */
export const MEMO_VERSION = 1;
export const MEMO_APP = "sb-payouts";
export const MAX_MEMO_BYTES = 256;

export type BatchId = Hex; // 0x + 32 hex chars (bytes16)

export interface MemoV1 {
  v: 1;
  app: typeof MEMO_APP;
  /** batchId without 0x, lowercase. */
  b: string;
  i: number;
  ref: string;
}

export type DecodedMemo =
  | { ok: true; memo: MemoV1; batchId: BatchId; raw: Hex }
  | { ok: false; reason: string; raw: Hex; text?: string };

const BATCH_ID_PATTERN = /^0x[0-9a-f]{32}$/;

export function isBatchId(value: unknown): value is BatchId {
  return typeof value === "string" && BATCH_ID_PATTERN.test(value);
}

/** 16 random bytes from the platform CSPRNG (browser or Node 22). */
export function newBatchId(): BatchId {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return bytesToHex(bytes) as BatchId;
}

export function memoIdFor(batchId: BatchId, rowIndex: number): Hex {
  if (!isBatchId(batchId)) throw new Error(`invalid batchId ${String(batchId)}`);
  if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex > 0xffffffff) throw new Error(`invalid row index ${rowIndex}`);
  return keccak256(encodePacked(["bytes16", "uint32"], [batchId, rowIndex]));
}

export function memoJson(batchId: BatchId, rowIndex: number, reference: string): string {
  if (!isBatchId(batchId)) throw new Error(`invalid batchId ${String(batchId)}`);
  // Fixed key order keeps the bytes deterministic for a given row.
  return JSON.stringify({ v: MEMO_VERSION, app: MEMO_APP, b: batchId.slice(2), i: rowIndex, ref: reference });
}

export function encodeMemo(batchId: BatchId, rowIndex: number, reference: string): Hex {
  const bytes = new TextEncoder().encode(memoJson(batchId, rowIndex, reference));
  if (bytes.length > MAX_MEMO_BYTES) throw new Error(`memo is ${bytes.length} bytes; the limit is ${MAX_MEMO_BYTES}`);
  return bytesToHex(bytes);
}

/** Decodes memo bytes. Anything that is not a well-formed v1 sb-payouts memo is
 * refused with a reason; the raw bytes are always kept. */
export function decodeMemo(raw: Hex): DecodedMemo {
  let bytes: Uint8Array;
  try {
    bytes = hexToBytes(raw);
  } catch {
    return { ok: false, reason: "memo is not hex", raw };
  }
  if (bytes.length > MAX_MEMO_BYTES) return { ok: false, reason: `memo is longer than ${MAX_MEMO_BYTES} bytes`, raw };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: "memo is not UTF-8", raw };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "memo is not JSON", raw, text };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ok: false, reason: "memo is not a JSON object", raw, text };
  const m = parsed as Record<string, unknown>;
  if (m.v !== MEMO_VERSION) return { ok: false, reason: `unsupported memo version ${JSON.stringify(m.v)}`, raw, text };
  if (m.app !== MEMO_APP) return { ok: false, reason: `memo belongs to another app (${JSON.stringify(m.app)})`, raw, text };
  if (typeof m.b !== "string" || !/^[0-9a-f]{32}$/.test(m.b)) return { ok: false, reason: "memo batch id is malformed", raw, text };
  if (typeof m.i !== "number" || !Number.isInteger(m.i) || m.i < 0 || m.i > 0xffffffff) return { ok: false, reason: "memo row index is malformed", raw, text };
  if (typeof m.ref !== "string" || m.ref.length === 0 || m.ref.length > 64) return { ok: false, reason: "memo reference is malformed", raw, text };
  const memo: MemoV1 = { v: 1, app: MEMO_APP, b: m.b, i: m.i, ref: m.ref };
  return { ok: true, memo, batchId: `0x${m.b}` as BatchId, raw };
}

/** True when an onchain memoId matches the batch id and row index inside the memo bytes. */
export function memoIdMatches(memoId: Hex, decoded: DecodedMemo): boolean {
  if (!decoded.ok) return false;
  return memoIdFor(decoded.batchId, decoded.memo.i).toLowerCase() === memoId.toLowerCase();
}

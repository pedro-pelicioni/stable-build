import { formatUnits, getAddress, parseUnits, type Address } from "viem";
import { ADDRESSES } from "../config/networks";

/** One validated payout row. `amount6` is in USDC ERC-20 base units (6 decimals). */
export interface PayoutRow {
  /** 0-based position among valid rows; becomes the memo row index. */
  index: number;
  /** 1-based line in the source file, for error messages. */
  line: number;
  recipient: Address;
  /** Normalized decimal string, e.g. "12.5". */
  amount: string;
  amount6: bigint;
  reference: string;
}

export interface CsvIssue {
  line: number;
  field?: "header" | "recipient" | "amount" | "reference" | "row";
  message: string;
}

export interface CsvParseResult {
  rows: PayoutRow[];
  errors: CsvIssue[];
  warnings: CsvIssue[];
  /** Sum of all valid rows, 6-decimal base units. */
  total6: bigint;
  count: number;
}

export const CSV_HEADER = ["recipient", "amount", "reference"] as const;
export const MAX_ROWS = 1000;
export const MAX_REFERENCE_LENGTH = 64;

// Opaque ids only: letters, digits and . _ : / # -. No spaces and no "@", so
// names and email addresses cannot end up in a public memo by accident.
const REFERENCE_PATTERN = /^[A-Za-z0-9._:/#-]+$/;
const AMOUNT_PATTERN = /^\d+(\.\d+)?$/;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const FORBIDDEN_RECIPIENTS = new Map<string, string>([
  [ZERO_ADDRESS, "the zero address"],
  [ADDRESSES.USDC.toLowerCase(), "the USDC contract"],
  [ADDRESSES.NATIVE_USDC_EMITTER.toLowerCase(), "the native USDC system emitter"],
  [ADDRESSES.MEMO.toLowerCase(), "the Memo contract"],
  [ADDRESSES.MULTICALL3FROM.toLowerCase(), "the Multicall3From contract"],
]);

/** Minimal RFC 4180 tokenizer: quoted fields, "" escapes, CRLF or LF. */
export function tokenizeCsv(text: string): { line: number; cells: string[] }[] {
  const out: { line: number; cells: string[] }[] = [];
  const src = text.replace(/^﻿/, "");
  let cells: string[] = [];
  let cell = "";
  let inQuotes = false;
  let line = 1;
  let rowLine = 1;
  const pushRow = () => {
    cells.push(cell);
    if (!(cells.length === 1 && cells[0].trim() === "")) out.push({ line: rowLine, cells });
    cells = [];
    cell = "";
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else {
        if (ch === "\n") line++;
        cell += ch;
      }
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      cells.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      pushRow();
      line++;
      rowLine = line;
    } else cell += ch;
  }
  if (cell !== "" || cells.length > 0) pushRow();
  return out;
}

export function validateRecipient(raw: string): { address?: Address; error?: string; warning?: string } {
  const value = raw.trim();
  if (!ADDRESS_PATTERN.test(value)) return { error: "not a 0x-prefixed 20-byte hex address" };
  const lower = value.toLowerCase();
  const forbidden = FORBIDDEN_RECIPIENTS.get(lower);
  if (forbidden) return { error: `recipient is ${forbidden}` };
  const checksummed = getAddress(lower);
  const body = value.slice(2);
  const mixedCase = body !== body.toLowerCase() && body !== body.toUpperCase();
  if (mixedCase && value !== checksummed) return { error: "EIP-55 checksum mismatch; copy the address again" };
  if (!mixedCase) return { address: checksummed, warning: "address has no checksum; double-check it" };
  return { address: checksummed };
}

export function validateAmount(raw: string): { amount6?: bigint; amount?: string; error?: string } {
  const value = raw.trim();
  if (!AMOUNT_PATTERN.test(value)) return { error: "amount must be a plain decimal such as 12.50" };
  const decimals = value.includes(".") ? value.split(".")[1].length : 0;
  if (decimals > 6) return { error: "USDC transfers carry at most 6 decimals" };
  const amount6 = parseUnits(value, 6);
  if (amount6 <= 0n) return { error: "amount must be greater than 0" };
  return { amount6, amount: formatUnits(amount6, 6) };
}

export function validateReference(raw: string): { reference?: string; error?: string } {
  const value = raw.trim();
  if (value.length === 0) return { error: "reference is required (an opaque id such as INV-0042)" };
  if (value.length > MAX_REFERENCE_LENGTH) return { error: `reference is longer than ${MAX_REFERENCE_LENGTH} characters` };
  if (!REFERENCE_PATTERN.test(value))
    return { error: "reference may only use letters, digits and . _ : / # - (memos are public: no names or emails)" };
  return { reference: value };
}

export function parsePayoutCsv(text: string, opts: { maxRows?: number } = {}): CsvParseResult {
  const maxRows = opts.maxRows ?? MAX_ROWS;
  const records = tokenizeCsv(text);
  const errors: CsvIssue[] = [];
  const warnings: CsvIssue[] = [];
  const rows: PayoutRow[] = [];
  if (records.length === 0) {
    errors.push({ line: 1, field: "header", message: "file is empty" });
    return { rows, errors, warnings, total6: 0n, count: 0 };
  }
  const header = records[0].cells.map((c) => c.trim().toLowerCase());
  const dupes = [...new Set(header.filter((h, i) => h !== "" && header.indexOf(h) !== i))];
  if (dupes.length > 0) {
    errors.push({ line: records[0].line, field: "header", message: `duplicate column ${dupes.join(", ")}; each column name may appear once` });
    return { rows, errors, warnings, total6: 0n, count: 0 };
  }
  const col = Object.fromEntries(CSV_HEADER.map((name) => [name, header.indexOf(name)])) as Record<
    (typeof CSV_HEADER)[number],
    number
  >;
  const missing = CSV_HEADER.filter((name) => col[name] < 0);
  if (missing.length > 0) {
    errors.push({ line: records[0].line, field: "header", message: `header must include ${CSV_HEADER.join(",")}; missing ${missing.join(",")}` });
    return { rows, errors, warnings, total6: 0n, count: 0 };
  }
  const extra = header.filter((h) => !(CSV_HEADER as readonly string[]).includes(h));
  if (extra.length > 0)
    warnings.push({ line: records[0].line, field: "header", message: `ignored columns: ${extra.join(", ")} (never sent onchain)` });

  const seenRefs = new Map<string, number>();
  const seenPairs = new Map<string, number>();
  const body = records.slice(1);
  if (body.length > maxRows) {
    errors.push({ line: body[maxRows].line, field: "row", message: `more than ${maxRows} rows; split the file` });
    return { rows, errors, warnings, total6: 0n, count: 0 };
  }
  for (const record of body) {
    const { line, cells } = record;
    if (cells.length < header.length) {
      errors.push({ line, field: "row", message: `expected ${header.length} columns, found ${cells.length}` });
      continue;
    }
    // More cells than the header shifts every later column: an unquoted "1,000" or "12,34" would pay
    // the wrong amount. Only empty trailing cells are tolerated.
    if (cells.slice(header.length).some((c) => c.trim() !== "")) {
      errors.push({
        line,
        field: "row",
        message: `expected ${header.length} columns, found ${cells.length}: a comma inside an amount (1,000 or 12,34) splits it into two columns; write plain decimals such as 1000 or 12.34`,
      });
      continue;
    }
    const r = validateRecipient(cells[col.recipient] ?? "");
    const a = validateAmount(cells[col.amount] ?? "");
    const ref = validateReference(cells[col.reference] ?? "");
    if (r.error) errors.push({ line, field: "recipient", message: r.error });
    if (r.warning) warnings.push({ line, field: "recipient", message: r.warning });
    if (a.error) errors.push({ line, field: "amount", message: a.error });
    if (ref.error) errors.push({ line, field: "reference", message: ref.error });
    if (!r.address || a.amount6 === undefined || !ref.reference) continue;
    const refKey = ref.reference.toLowerCase();
    const firstRef = seenRefs.get(refKey);
    if (firstRef !== undefined) {
      errors.push({ line, field: "reference", message: `duplicate reference (first seen on line ${firstRef})` });
      continue;
    }
    seenRefs.set(refKey, line);
    const pairKey = `${r.address.toLowerCase()}:${a.amount6}`;
    const firstPair = seenPairs.get(pairKey);
    if (firstPair !== undefined)
      warnings.push({ line, field: "row", message: `same recipient and amount as line ${firstPair}; check for a duplicate payment` });
    else seenPairs.set(pairKey, line);
    rows.push({ index: rows.length, line, recipient: r.address, amount: a.amount!, amount6: a.amount6, reference: ref.reference });
  }
  if (rows.length === 0 && errors.length === 0) errors.push({ line: 1, field: "row", message: "no payout rows" });
  const total6 = rows.reduce((sum, row) => sum + row.amount6, 0n);
  return { rows, errors, warnings, total6, count: rows.length };
}

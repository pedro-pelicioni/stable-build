import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { concat, hexToString, keccak256, numberToHex, stringToHex, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { decodeMemoLog } from "../src/core/logs";
import { normalizeLogs, type RawLog } from "../src/core/logs";
import { MAX_MEMO_BYTES, decodeMemo, encodeMemo, isBatchId, memoIdFor, memoIdMatches, memoJson, newBatchId } from "../src/core/memo-schema";
import { fixturePath } from "./helpers";

const BATCH = "0x0123456789abcdef0123456789abcdef" as const;
const schema = JSON.parse(readFileSync(fileURLToPath(new URL("../docs/memo-schema.v1.json", import.meta.url)), "utf8"));

describe("memo schema v1", () => {
  it("round-trips", () => {
    const raw = encodeMemo(BATCH, 7, "INV-0042");
    expect(hexToString(raw)).toBe('{"v":1,"app":"sb-payouts","b":"0123456789abcdef0123456789abcdef","i":7,"ref":"INV-0042"}');
    const d = decodeMemo(raw);
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.memo).toEqual({ v: 1, app: "sb-payouts", b: BATCH.slice(2), i: 7, ref: "INV-0042" });
      expect(d.batchId).toBe(BATCH);
      expect(d.raw).toBe(raw);
    }
    expect(memoIdMatches(memoIdFor(BATCH, 7), d)).toBe(true);
    expect(memoIdMatches(memoIdFor(BATCH, 8), d)).toBe(false);
  });

  it("memoId is keccak256(abi.encodePacked(bytes16 batchId, uint32 row))", () => {
    const manual = keccak256(concat([BATCH, numberToHex(7, { size: 4 })]));
    expect(memoIdFor(BATCH, 7)).toBe(manual);
    expect(memoIdFor(BATCH, 7)).toBe(memoIdFor(BATCH, 7));
    expect(memoIdFor(BATCH, 7)).not.toBe(memoIdFor(BATCH, 6));
    expect(() => memoIdFor("0x1234" as Hex, 0)).toThrow(/batchId/);
    expect(() => memoIdFor(BATCH, -1)).toThrow(/row index/);
  });

  it("worst case stays under 256 bytes", () => {
    const raw = encodeMemo(BATCH, 0xffffffff, "R".repeat(64));
    expect((raw.length - 2) / 2).toBeLessThanOrEqual(MAX_MEMO_BYTES);
  });

  it("matches docs/memo-schema.v1.json keys", () => {
    const obj = JSON.parse(memoJson(BATCH, 1, "X-1"));
    expect(Object.keys(obj)).toEqual(schema.required);
    expect(obj.v).toBe(schema.properties.v.const);
    expect(obj.app).toBe(schema.properties.app.const);
    expect(new RegExp(schema.properties.b.pattern).test(obj.b)).toBe(true);
  });

  it.each([
    ["version 2", stringToHex('{"v":2,"app":"sb-payouts","b":"0123456789abcdef0123456789abcdef","i":0,"ref":"A"}'), /unsupported memo version 2/],
    ["another app", stringToHex('{"v":1,"app":"other","b":"0123456789abcdef0123456789abcdef","i":0,"ref":"A"}'), /another app/],
    ["plain text", stringToHex("order=2026-0001"), /not JSON/],
    ["invalid UTF-8", "0xff" as Hex, /not UTF-8/],
    ["array", stringToHex("[1]"), /not a JSON object/],
    ["bad batch id", stringToHex('{"v":1,"app":"sb-payouts","b":"xyz","i":0,"ref":"A"}'), /batch id/],
    ["too long", stringToHex("x".repeat(257)), /longer than 256/],
  ])("refuses %s and keeps the raw bytes", (_n, raw, reason) => {
    const d = decodeMemo(raw);
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.reason).toMatch(reason);
      expect(d.raw).toBe(raw);
    }
  });

  it("refuses the versioned memo of another app found on testnet", () => {
    const { logs } = JSON.parse(readFileSync(fixturePath("memo-logs-sender-427c.json"), "utf8")) as { logs: RawLog[] };
    const m = decodeMemoLog(normalizeLogs(logs)[0]);
    const d = decodeMemo(m.memo);
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.reason).toMatch(/another app/);
      expect(d.text).toMatch(/^\{"v":1,/);
    }
  });

  it("creates random 16-byte batch ids", () => {
    const a = newBatchId();
    const b = newBatchId();
    expect(isBatchId(a)).toBe(true);
    expect(a).not.toBe(b);
  });
});

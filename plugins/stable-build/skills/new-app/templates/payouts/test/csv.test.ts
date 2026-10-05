import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MAX_ROWS, parsePayoutCsv, tokenizeCsv } from "../src/core/csv";

const sample = readFileSync(fileURLToPath(new URL("../sample/payroll.csv", import.meta.url)), "utf8");
const A = "0x0Bcf6849b35cEA52FDfcCFD41166CE5dc4c51cE1";
const B = "0x3B4bad9E49AFA53d8439C1858e5F8E3D391205f0";
const csv = (...lines: string[]) => ["recipient,amount,reference", ...lines].join("\n");

describe("csv", () => {
  it("parses the sample file", () => {
    const r = parsePayoutCsv(sample);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.count).toBe(3);
    expect(r.total6).toBe(60_000n);
    expect(r.rows.map((x) => x.index)).toEqual([0, 1, 2]);
    expect(r.rows[0]).toMatchObject({ recipient: A, amount: "0.01", amount6: 10_000n, reference: "PAY-2026-10-001", line: 2 });
  });

  it("handles BOM, CRLF, quotes and blank lines", () => {
    const text = `﻿recipient,amount,reference\r\n"${A}","1.5","INV-1"\r\n\r\n${B},2,"INV-2"\r\n`;
    const r = parsePayoutCsv(text);
    expect(r.errors).toEqual([]);
    expect(r.rows.map((x) => [x.recipient, x.amount6, x.reference])).toEqual([
      [A, 1_500_000n, "INV-1"],
      [B, 2_000_000n, "INV-2"],
    ]);
    expect(tokenizeCsv('a,"b,""c"""\n')).toEqual([{ line: 1, cells: ["a", 'b,"c"'] }]);
  });

  it("accepts columns in any order and warns about extra columns", () => {
    const r = parsePayoutCsv(`reference,recipient,amount,name\nINV-1,${A},3,Alice`);
    expect(r.errors).toEqual([]);
    expect(r.rows[0].amount6).toBe(3_000_000n);
    expect(r.warnings[0].message).toMatch(/ignored columns: name/);
  });

  it.each([
    ["bad checksum", `${A.replace("0x0B", "0x0b")},1,R1`, "recipient", /checksum/],
    ["zero address", "0x0000000000000000000000000000000000000000,1,R1", "recipient", /zero address/],
    ["USDC contract", "0x3600000000000000000000000000000000000000,1,R1", "recipient", /USDC contract/],
    ["Memo contract", "0x5294E9927c3306DcBaDb03fe70b92e01cCede505,1,R1", "recipient", /Memo contract/],
    ["short address", "0x1234,1,R1", "recipient", /20-byte/],
    ["7 decimals", `${A},0.0000001,R1`, "amount", /6 decimals/],
    ["zero amount", `${A},0,R1`, "amount", /greater than 0/],
    ["negative amount", `${A},-1,R1`, "amount", /plain decimal/],
    ["exponent", `${A},1e3,R1`, "amount", /plain decimal/],
    ["thousands separator", `${A},"1,000",R1`, "amount", /plain decimal/],
    ["empty reference", `${A},1,`, "reference", /required/],
    ["long reference", `${A},1,${"X".repeat(65)}`, "reference", /longer than 64/],
    ["email in reference", `${A},1,alice@example.com`, "reference", /no names or emails/],
    ["space in reference", `${A},1,Alice Smith`, "reference", /no names or emails/],
  ])("rejects %s", (_name, line, field, message) => {
    const r = parsePayoutCsv(csv(line));
    expect(r.rows).toEqual([]);
    expect(r.errors[0]).toMatchObject({ line: 2, field });
    expect(r.errors[0].message).toMatch(message);
  });

  it("rejects duplicate references (case-insensitive) and warns on duplicate payments", () => {
    const r = parsePayoutCsv(csv(`${A},1,INV-1`, `${B},1,inv-1`, `${A},1,INV-3`));
    expect(r.errors).toEqual([{ line: 3, field: "reference", message: "duplicate reference (first seen on line 2)" }]);
    expect(r.warnings.some((w) => w.line === 4 && /duplicate payment/.test(w.message))).toBe(true);
  });

  it("warns when an address carries no checksum", () => {
    const r = parsePayoutCsv(csv(`${A.toLowerCase()},1,R1`));
    expect(r.errors).toEqual([]);
    expect(r.rows[0].recipient).toBe(A);
    expect(r.warnings[0].message).toMatch(/no checksum/);
  });

  it("requires the header and caps the row count", () => {
    expect(parsePayoutCsv("to,value\n").errors[0].field).toBe("header");
    expect(parsePayoutCsv("").errors[0].message).toMatch(/empty/);
    const many = csv(...Array.from({ length: MAX_ROWS + 1 }, (_, i) => `${A},1,R${i}`));
    expect(parsePayoutCsv(many).errors[0].message).toMatch(/more than 1000 rows/);
  });
});

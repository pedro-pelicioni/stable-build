import { describe, expect, it } from "vitest";
import { parsePayoutCsv } from "../src/core/csv";

// Rows with more cells than the header shift every later column (review finding: an unquoted
// thousands separator or decimal comma paid the wrong amount with the wrong reference).
const A = "0x0Bcf6849b35cEA52FDfcCFD41166CE5dc4c51cE1";

describe("csv column count", () => {
  it.each([
    ["thousands separator", `recipient,amount,reference\n${A},1,000,INV-1`],
    ["decimal comma", `recipient,amount,reference\n${A},12,34,INV-2`],
    ["reordered header", `recipient,reference,amount\n${A},INV-1,1,000`],
  ])("refuses a row with more cells than the header (%s)", (_name, text) => {
    const r = parsePayoutCsv(text);
    expect(r.rows).toEqual([]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ line: 2, field: "row" });
    expect(r.errors[0].message).toMatch(/expected 3 columns, found 4/);
  });

  it("tolerates empty trailing cells", () => {
    const r = parsePayoutCsv(`recipient,amount,reference\n${A},1000,INV-1,,\n`);
    expect(r.errors).toEqual([]);
    expect(r.rows[0]).toMatchObject({ amount6: 1_000_000_000n, reference: "INV-1" });
  });

  it("refuses a header that names a column twice", () => {
    const r = parsePayoutCsv(`recipient,amount,reference,amount\n${A},1,INV-1,1000\n`);
    expect(r.rows).toEqual([]);
    expect(r.errors[0]).toMatchObject({ field: "header" });
    expect(r.errors[0].message).toMatch(/duplicate column amount/);
  });
});

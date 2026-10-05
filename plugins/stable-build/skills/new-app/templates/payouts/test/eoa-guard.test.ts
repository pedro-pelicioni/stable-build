import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import { EoaGuardError, assertChain, assertEoa, assertReceiptFrom, classifyCode } from "../src/core/eoa-guard";
import { addr, fixtureReceipt, loadFixture } from "./helpers";

const delegated = ("0xef0100" + "ab".repeat(20)) as Hex;

describe("EOA guard", () => {
  it("classifies account code", () => {
    expect(classifyCode("0x")).toBe("eoa");
    expect(classifyCode(undefined)).toBe("eoa");
    expect(classifyCode(delegated)).toBe("eip7702-delegated");
    expect(classifyCode("0x6080604052")).toBe("contract");
  });

  it("refuses EIP-7702 delegated accounts and contracts", async () => {
    await expect(assertEoa(async () => "0x", addr("eoa"))).resolves.toBeUndefined();
    await expect(assertEoa(async () => delegated, addr("eoa"))).rejects.toThrow(/EIP-7702/);
    await expect(assertEoa(async () => "0x6080604052", addr("wallet"))).rejects.toThrow(/contract account/);
    await expect(assertEoa(async () => delegated, addr("eoa"))).rejects.toBeInstanceOf(EoaGuardError);
  });

  it("the recorded senders were plain EOAs", () => {
    for (const f of ["receipt-batch-2rows.json", "receipt-batch-13rows.json", "receipt-batch-2rows-other-eoa.json"])
      expect(loadFixture(f).source.senderCodeAtFetch).toBe("0x");
  });

  it("checks receipt.from after sending", () => {
    const receipt = fixtureReceipt("receipt-batch-2rows.json");
    expect(() => assertReceiptFrom(receipt, "0x427C62eDCae20DDc8c5e875De39D4E4845491458")).not.toThrow();
    expect(() => assertReceiptFrom(receipt, addr("someone else"))).toThrow(/expected/);
  });

  it("checks the connected chain", async () => {
    await expect(assertChain(async () => 5042002, 5042002)).resolves.toBeUndefined();
    await expect(assertChain(async () => 5042, 5042002)).rejects.toThrow(/5042002/);
  });
});

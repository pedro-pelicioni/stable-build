import { parseGwei } from "viem";
import { describe, expect, it } from "vitest";
import { getNetwork, MAINNET_CONFIRMATION } from "../src/config/networks";
import { assertChain, assertFeeMatch, assertSendable, FeeMismatch, feesFor, GateError, parseCapUsdc, WrongChain } from "../src/core/guard";

const mainnet = getNetwork("mainnet");
const testnet = getNetwork("testnet");

const tx = {
  value: 0n,
  maxFeePerGas: parseGwei("20"),
};

describe("mainnet guard", () => {
  it("refuses mainnet without the exact phrase", () => {
    expect(() => assertSendable(mainnet, tx, 10_000n, { confirmation: "send real usdc", capUsdc: "1" })).toThrow(GateError);
    expect(() => assertSendable(mainnet, tx, 10_000n, { confirmation: "send real usdc", capUsdc: "1" })).toThrow(MAINNET_CONFIRMATION);
    expect(() => assertSendable(mainnet, tx, 10_000n, { confirmation: MAINNET_CONFIRMATION })).toThrow(/cap/);
  });

  it("refuses a fee above the cap and allows one inside it", () => {
    expect(() => assertSendable(mainnet, tx, 60_000n, { confirmation: MAINNET_CONFIRMATION, capUsdc: "0.05" })).toThrow(/above the cap/);
    expect(() => assertSendable(mainnet, tx, 30_000n, { confirmation: MAINNET_CONFIRMATION, capUsdc: "0.05" })).not.toThrow();
    expect(parseCapUsdc("0.05")).toBe(50_000n);
  });

  it("does not ask for the phrase on testnet", () => {
    expect(() => assertSendable(testnet, tx, 10_000n)).not.toThrow();
  });

  it("refuses native value and a fee below 20 gwei on every network", () => {
    expect(() => assertSendable(testnet, { value: 1n, maxFeePerGas: tx.maxFeePerGas }, 10_000n)).toThrow(/native value/);
    expect(() => assertSendable(testnet, { value: 0n, maxFeePerGas: feesFor(parseGwei("5")).maxFeePerGas - 1n }, 10_000n)).toThrow(/20 gwei/);
  });

  it("keeps maxFeePerGas at or above 20 gwei", () => {
    expect(feesFor(null).maxFeePerGas).toBe(parseGwei("20"));
    expect(feesFor(parseGwei("5")).maxFeePerGas).toBe(parseGwei("20"));
    expect(feesFor(parseGwei("20")).maxFeePerGas).toBe(parseGwei("40"));
    expect(feesFor(parseGwei("30")).maxFeePerGas).toBe(parseGwei("60"));
  });
});

describe("chain and fee", () => {
  it("rejects a wallet on the wrong chain", () => {
    expect(() => assertChain(1, 5042002)).toThrow(WrongChain);
    expect(() => assertChain(5042, 5042002)).toThrow(/5042/);
    expect(() => assertChain(5042002, 5042002)).not.toThrow();
    expect(() => assertChain(5042, 5042)).not.toThrow();
  });

  it("names FeeMismatch when the signed fee is not the stored fee", () => {
    expect(() => assertFeeMatch(30_000n, 10_000n)).toThrow(FeeMismatch);
    try {
      assertFeeMatch(30_000n, 10_000n);
    } catch (err) {
      expect(err).toBeInstanceOf(FeeMismatch);
      expect((err as FeeMismatch).signedFee).toBe(30_000n);
      expect((err as FeeMismatch).storedFee).toBe(10_000n);
    }
    expect(() => assertFeeMatch(0n, 0n)).not.toThrow();
    expect(() => assertFeeMatch(10_000n, 10_000n)).not.toThrow();
  });
});

import { encodeErrorResult, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { registryAbi } from "../src/config/abis";
import { getNetwork } from "../src/config/networks";
import { DecimalsError, formatErc20Usdc, formatGasCeiling } from "../src/core/units";
import { ReviewError, derivePhase, reviewPayload } from "../src/core/review";
import { buildApproveTx } from "../src/core/tx";
import { fakeReader } from "./fake-reader";
import { REGISTRY, signedPayload } from "./payload-fixture";

const testnet = getNetwork("testnet");
const account = "0x3333333333333333333333333333333333333333" as Address;

function allowanceRevert(): Error {
  const err = new Error("execution reverted");
  return Object.assign(err, { data: "0x08c379a0" });
}

describe("decimals", () => {
  it("formats 6-decimal base units and refuses any other decimals() view", () => {
    expect(formatErc20Usdc(10_000n)).toBe("0.01");
    expect(formatErc20Usdc(30_000n)).toBe("0.03");
    expect(formatErc20Usdc(10_000n)).not.toBe(formatErc20Usdc(10_000n * 10n ** 12n));
    expect(() => {
      throw new DecimalsError(18);
    }).toThrow(DecimalsError);
    expect(new DecimalsError(18).decimals).toBe(18);
  });

  it("shows a gas ceiling in 18-decimal units, separate from the fee", () => {
    const ceiling = formatGasCeiling(50_000n, 20_000_000_000n);
    expect(ceiling).toBe("0.001");
    expect(formatErc20Usdc(10_000n)).toBe("0.01");
  });
});

describe("review", () => {
  it("simulates approve and register with value 0 and does not send", async () => {
    const { reader, calls } = fakeReader({
      fee: 10_000n,
      call(tx) {
        if (tx.to === REGISTRY) throw allowanceRevert();
        return "0x0000000000000000000000000000000000000000000000000000000000000001";
      },
    });
    const review = await reviewPayload({
      json: signedPayload(),
      network: testnet,
      registry: REGISTRY,
      reader,
      account,
    });
    expect(review.simulation.canApprove).toBe(true);
    expect(review.simulation.canRegister).toBe(false);
    expect(review.approveTx?.value).toBe(0n);
    expect(review.approveTx?.maxFeePerGas).toBeGreaterThanOrEqual(20_000_000_000n);
    expect(calls).not.toContain("wait");
    expect(calls).toContain("call");
    expect(calls).toContain("estimateGas");
    expect(calls).not.toContain("getBalance");
  });

  it("throws FeeMismatch when the registry fee differs from the payload", async () => {
    const { reader } = fakeReader({ fee: 30_000n });
    await expect(reviewPayload({
      json: signedPayload({ fee: 10_000n }),
      network: testnet,
      registry: REGISTRY,
      reader,
      account,
    })).rejects.toBeInstanceOf(ReviewError);
    await expect(reviewPayload({
      json: signedPayload({ fee: 10_000n }),
      network: testnet,
      registry: REGISTRY,
      reader,
      account,
    })).rejects.toThrow(/FeeMismatch/);
  });

  it("throws WrongChain when the RPC is not the configured chain", async () => {
    const { reader, calls } = fakeReader({ chainId: 1 });
    await expect(reviewPayload({
      json: signedPayload(),
      network: testnet,
      registry: REGISTRY,
      reader,
      account,
    })).rejects.toThrow(/WrongChain/);
    expect(calls).toEqual(["chainId"]);
  });

  it("throws when decimals() is not 6", async () => {
    const { reader } = fakeReader({ decimals: 18 });
    await expect(reviewPayload({
      json: signedPayload(),
      network: testnet,
      registry: REGISTRY,
      reader,
      account,
    })).rejects.toThrow(/6/);
  });

  it("blocks on a registry error and does not offer approve", async () => {
    const data = encodeErrorResult({ abi: registryAbi, errorName: "NoCode", args: [account] });
    const { reader } = fakeReader({
      call() {
        throw Object.assign(new Error("execution reverted"), { data });
      },
    });
    const review = await reviewPayload({
      json: signedPayload(),
      network: testnet,
      registry: REGISTRY,
      reader,
      account,
    });
    expect(review.blocked).toMatch(/NoCode/);
    expect(review.approveTx).toBeNull();
    expect(review.registerTx).toBeNull();
  });

  it("offers register when the call succeeds, and the approve amount is the 6-decimal fee", async () => {
    const json = signedPayload();
    const { reader } = fakeReader({ fee: 10_000n });
    const review = await reviewPayload({ json, network: testnet, registry: REGISTRY, reader, account });
    expect(review.simulation.canRegister).toBe(true);
    expect(review.registerTx?.value).toBe(0n);
    expect(review.registerTx?.data.toLowerCase()).toBe(String((json as { register: { data: Hex } }).register.data).toLowerCase());
    const built = buildApproveTx(review.payload, review.storedFee, null);
    expect(built.value).toBe(0n);
    expect(built.data.toLowerCase()).toContain(REGISTRY.slice(2).toLowerCase());
  });
});

describe("phase", () => {
  const base = {
    account,
    chainOk: true,
    payloadReady: true,
    reviewed: true,
    blocked: null,
    canApprove: false,
    canRegister: false,
    registered: false,
  };

  it("follows connect, payload, approve, register, done", () => {
    expect(derivePhase({ ...base, account: null, chainOk: false, payloadReady: false, reviewed: false })).toBe("connect");
    expect(derivePhase({ ...base, chainOk: false })).toBe("connect");
    expect(derivePhase({ ...base, payloadReady: false, reviewed: false })).toBe("payload");
    expect(derivePhase({ ...base, reviewed: false })).toBe("payload");
    expect(derivePhase({ ...base, canApprove: true })).toBe("approve");
    expect(derivePhase({ ...base, canRegister: true })).toBe("register");
    expect(derivePhase({ ...base, blocked: "FeeMismatch: no", canApprove: true })).toBe("blocked");
    expect(derivePhase({ ...base, registered: true, canRegister: true })).toBe("done");
  });
});

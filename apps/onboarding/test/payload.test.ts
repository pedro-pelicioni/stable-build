import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { hashRegistration, parsePayload, PayloadError } from "../src/core/payload";
import { PROJECT, REGISTRY, signedPayload } from "./payload-fixture";

const VECTOR = {
  verifyingContract: getAddress("0x1111111111111111111111111111111111111111"),
  domainChainId: 5042n,
  project: getAddress("0x2222222222222222222222222222222222222222"),
  chainId: 5042n,
  reportHash: "0x340907c179c73fb7f781f584c06d57ca2f32b14aa013ff9de0d51c872982eefe" as const,
  gates: 16383n,
  expiry: 1893456000n,
  nonce: 1n,
  fee: 10000n,
  digest: "0xa5975850b69b10b0cf92ad2b4fca8c34c8a06a953c28cf315c32e6b0c9fe43df",
  signature: "0x057e2aab4f2bae671cc6f40e4ce3678e6dec4322c55d1e66e970eab78f7bc6de0bfcc1a7f8ee2073d0b1f22b49703c927273a5abf96815e3f0cb6b0a6f4f3f1d1b",
  verifier: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
};

describe("payload", () => {
  it("rebuilds the shared EIP-712 vector digest", () => {
    expect(hashRegistration(VECTOR)).toBe(VECTOR.digest);
  });

  it("accepts a payload from go-live-sign and keeps the fee in 6-decimal base units", async () => {
    const json = signedPayload();
    const parsed = await parsePayload(json, { chainId: 5042002, registry: REGISTRY });
    expect(parsed.fee).toBe(10_000n);
    expect(parsed.usdcDecimals).toBe(6);
    expect(parsed.nativeValue).toBe("0");
    expect(parsed.register.value).toBe("0");
    expect(parsed.approve?.value).toBe("0");
    expect(parsed.approve?.to).toBe(getAddress("0x3600000000000000000000000000000000000000"));
    expect(parsed.message.project).toBe(PROJECT);
    expect(parsed.verifier).toBe(getAddress(VECTOR.verifier));
  });

  it("rejects an unsigned payload", async () => {
    const json = signedPayload() as Record<string, unknown>;
    json.signed = false;
    await expect(parsePayload(json, { chainId: 5042002, registry: REGISTRY })).rejects.toThrow(PayloadError);
    await expect(parsePayload(json, { chainId: 5042002, registry: REGISTRY })).rejects.toMatchObject({ code: "unsigned" });
  });

  it("rejects 18 decimals and native value", async () => {
    const decimals = signedPayload() as { usdcDecimals: number };
    decimals.usdcDecimals = 18;
    await expect(parsePayload(decimals, { chainId: 5042002, registry: REGISTRY })).rejects.toThrow(/6/);

    const native = signedPayload() as { nativeValue: string };
    native.nativeValue = "1";
    await expect(parsePayload(native, { chainId: 5042002, registry: REGISTRY })).rejects.toThrow(/nativeValue/);
  });

  it("rejects a payload for a different chain", async () => {
    const json = signedPayload({ chainId: 5042n });
    await expect(parsePayload(json, { chainId: 5042002, registry: REGISTRY })).rejects.toThrow(/5042/);
  });

  it("rejects a fee above 10 USDC and calldata that does not match the signed fee", async () => {
    const high = signedPayload({ fee: 10_000_001n }) as { blocked?: string[] };
    expect(high.blocked?.length).toBeGreaterThan(0);
    await expect(parsePayload(high, { chainId: 5042002, registry: REGISTRY })).rejects.toThrow(/not signed|above/);

    const tampered = signedPayload() as { fee: string; message: { fee: string }; digest: string };
    tampered.fee = "20000";
    tampered.message.fee = "20000";
    tampered.digest = "0x" + "11".repeat(32);
    await expect(parsePayload(tampered, { chainId: 5042002, registry: REGISTRY })).rejects.toThrow(/digest|approve/);
  });

  it("rejects approve calldata that sends native value", async () => {
    const json = signedPayload() as { approve: { value: string } };
    json.approve.value = "1";
    await expect(parsePayload(json, { chainId: 5042002, registry: REGISTRY })).rejects.toThrow(/value/);
  });
});

import { describe, expect, it } from "vitest";
import { leakMessage, leakedViteKeys, looksLikePrivateKey } from "../src/config/env-guard";
import { resolveNetworkName } from "../src/config/networks";

const KEY = `0x${"ab".repeat(32)}`;

describe("env guard", () => {
  it("recognises the private-key shape with or without 0x", () => {
    expect(looksLikePrivateKey(KEY)).toBe(true);
    expect(looksLikePrivateKey("ab".repeat(32))).toBe(true);
    expect(looksLikePrivateKey(` ${KEY} `)).toBe(true);
    expect(looksLikePrivateKey(`0x${"ab".repeat(20)}`)).toBe(false); // an address
    expect(looksLikePrivateKey("https://rpc.testnet.arc.io")).toBe(false);
    expect(looksLikePrivateKey(undefined)).toBe(false);
  });

  it("lists only VITE_* names that hold a key", () => {
    expect(leakedViteKeys({ VITE_DEPLOYER_KEY: KEY, VITE_NETWORK: "testnet", PAYOUT_PRIVATE_KEY: KEY })).toEqual(["VITE_DEPLOYER_KEY"]);
    expect(leakMessage(["VITE_A"])).toMatch(/VITE_A looks like a private key/);
  });

  it("resolves the network name to testnet unless it is exactly mainnet", () => {
    expect(resolveNetworkName("mainnet")).toBe("mainnet");
    for (const v of ["Mainnet", "testnet", "", undefined, null, "main"]) expect(resolveNetworkName(v)).toBe("testnet");
  });
});

import { describe, expect, it } from "vitest";
import { getNetwork, resolveNetworkName } from "../src/config/networks";
import { leakMessage, leakedViteKeys, looksLikePrivateKey } from "../src/config/env-guard";
import { handleChat } from "../api/chat";
import { MAINNET_CONFIRMATION } from "../src/config/networks";
import { scriptedReply } from "../src/core/guide";
import { TOOL_NAMES, isToolName, runTool } from "../src/core/tools";
import { fakeReader } from "./fake-reader";
import { REGISTRY, signedPayload } from "./payload-fixture";

const KEY = `0x${"ab".repeat(32)}`;
const account = "0x3333333333333333333333333333333333333333";

describe("env guard", () => {
  it("recognises a 32-byte key and ignores addresses and RPC URLs", () => {
    expect(looksLikePrivateKey(KEY)).toBe(true);
    expect(looksLikePrivateKey("ab".repeat(32))).toBe(true);
    expect(looksLikePrivateKey(` ${KEY} `)).toBe(true);
    expect(looksLikePrivateKey(`0x${"ab".repeat(20)}`)).toBe(false);
    expect(looksLikePrivateKey("https://rpc.testnet.arc.io")).toBe(false);
    expect(looksLikePrivateKey(undefined)).toBe(false);
  });

  it("lists only VITE_* names that hold a key", () => {
    expect(leakedViteKeys({ VITE_DEPLOYER_KEY: KEY, VITE_NETWORK: "testnet", LLM_API_KEY: KEY })).toEqual(["VITE_DEPLOYER_KEY"]);
    expect(leakMessage(["VITE_A"])).toMatch(/VITE_A looks like a private key/);
  });

  it("resolves the network name to testnet unless it is exactly mainnet", () => {
    expect(resolveNetworkName("mainnet")).toBe("mainnet");
    for (const value of ["Mainnet", "testnet", "", undefined, null, "main"]) expect(resolveNetworkName(value)).toBe("testnet");
  });
});

describe("tools", () => {
  it("exposes only read and prepare tools", () => {
    expect([...TOOL_NAMES]).toEqual([
      "get_balance",
      "explain_step",
      "simulate_tx",
      "build_approve_tx",
      "build_register_tx",
      "get_registry_badge",
    ]);
    for (const name of TOOL_NAMES) expect(name).not.toMatch(/sign|send|broadcast/i);
    expect(isToolName("eth_sendTransaction")).toBe(false);
  });

  it("returns a 6-decimal balance and never a native balance", async () => {
    const { reader, calls } = fakeReader({ balance: 1_500_000n });
    const result = await runTool("get_balance", {}, { network: "testnet", account, registry: REGISTRY, payloadJson: null }, reader);
    expect(result.proposal).toBeNull();
    expect(result.content).toContain("1.5");
    expect(result.content).toContain('"decimals":6');
    expect(calls).toContain("balanceOf");
    expect(calls).not.toContain("getBalance");
  });

  it("returns FeeMismatch from build_approve_tx and does not propose a transaction", async () => {
    const { reader } = fakeReader({ fee: 30_000n });
    const result = await runTool(
      "build_approve_tx",
      {},
      { network: "testnet", account, registry: REGISTRY, payloadJson: signedPayload({ fee: 10_000n }) },
      reader,
    );
    expect(result.proposal).toBeNull();
    expect(result.content).toMatch(/FeeMismatch/);
  });

  it("builds an unsigned register transaction with value 0", async () => {
    const { reader, calls } = fakeReader({ fee: 10_000n });
    const result = await runTool(
      "build_register_tx",
      {},
      { network: "testnet", account, registry: REGISTRY, payloadJson: signedPayload() },
      reader,
    );
    expect(result.proposal?.value).toBe("0");
    expect(result.proposal?.kind).toBe("register");
    expect(BigInt(result.proposal?.maxFeePerGas ?? "0")).toBeGreaterThanOrEqual(20_000_000_000n);
    expect(calls).not.toContain("wait");
  });

  it("reports a wrong chain instead of reading a balance", async () => {
    const { reader, calls } = fakeReader({ chainId: 1 });
    const result = await runTool("get_balance", {}, { network: "testnet", account, registry: REGISTRY, payloadJson: null }, reader);
    expect(result.content).toMatch(/WrongChain/);
    expect(calls).toEqual(["chainId"]);
  });

  it("rejects an unknown tool", async () => {
    const { reader } = fakeReader();
    const result = await runTool("eth_sendTransaction", {}, { network: "testnet", account, registry: null, payloadJson: null }, reader);
    expect(result.proposal).toBeNull();
    expect(result.content).toMatch(/unknown tool/);
  });
});

describe("chat api", () => {
  it("stays disabled without a key, so the app can run fully static", async () => {
    const { reader } = fakeReader();
    const res = await handleChat({ messages: [{ role: "user", content: "hello" }] }, { env: {}, reader });
    expect(res.status).toBe(503);
    expect(res.body.fallback).toBe(true);
  });

  it("returns the model's text and an unsigned proposal, and ignores a sign tool", async () => {
    const { reader } = fakeReader({ fee: 10_000n });
    let round = 0;
    const fetchImpl = async () => {
      round += 1;
      const body = round === 1
        ? {
            choices: [{
              message: {
                content: "",
                tool_calls: [
                  { id: "c1", type: "function", function: { name: "build_register_tx", arguments: "{}" } },
                  { id: "c2", type: "function", function: { name: "eth_sendTransaction", arguments: "{\"to\":\"0x1\"}" } },
                ],
              },
            }],
          }
        : { choices: [{ message: { content: "Sign register in your wallet.", tool_calls: [] } }] };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    };
    const res = await handleChat(
      {
        messages: [{ role: "user", content: "register" }],
        context: { network: "testnet", account, registry: REGISTRY, payload: signedPayload() },
      },
      { env: { LLM_PROVIDER: "openai", LLM_API_KEY: "sk-test", LLM_MODEL: "test-model" }, reader, fetchImpl: fetchImpl as typeof fetch },
    );
    expect(res.status).toBe(200);
    expect(res.body.text).toBe("Sign register in your wallet.");
    const proposals = res.body.proposals as Array<{ value: string; kind: string }>;
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.value).toBe("0");
    expect(proposals[0]?.kind).toBe("register");
  });
});

describe("scripted guide", () => {
  it("records the mainnet phrase and does not claim a transaction was sent", () => {
    const mainnet = getNetwork("mainnet");
    const reply = scriptedReply({ phase: "approve", text: MAINNET_CONFIRMATION, network: mainnet, fee: 30_000n, blockReason: null });
    expect(reply).toMatch(/Recorded/);
    expect(reply).not.toMatch(/sent|broadcast/i);
    const step = scriptedReply({ phase: "connect", text: "what now", network: getNetwork("testnet"), fee: null, blockReason: null });
    expect(step).toMatch(/wallet/i);
  });
});

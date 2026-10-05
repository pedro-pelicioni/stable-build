import { readFileSync } from "node:fs";
import { createPublicClient, http, type Log } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_BLOCKS_PER_QUERY, decodeMemoLog, getLogsPaged, memoLogsFetcher, normalizeLogs, type LogsClient, type RawLog } from "../src/core/logs";
import { rpcErrorCode, withArcRetry } from "../src/core/rpc-errors";
import { fixturePath } from "./helpers";

const rpcError = (code: number, message = "rpc error") => Object.assign(new Error(message), { code });
const http429 = () => Object.assign(new Error("HTTP request failed"), { status: 429 });
const noWait = async () => {};

describe("getLogsPaged", () => {
  it("pages in windows of at most 9,999 blocks with no gaps or overlaps", async () => {
    const windows: [bigint, bigint][] = [];
    const start = 100n;
    const end = start + 25_000n;
    await getLogsPaged(async (f, t) => (windows.push([f, t]), []), start, end, { wait: noWait });
    expect(MAX_BLOCKS_PER_QUERY).toBe(9_999n);
    expect(windows[0]).toEqual([100n, 10_098n]);
    for (const [f, t] of windows) expect(t - f + 1n).toBeLessThanOrEqual(9_999n);
    for (let i = 1; i < windows.length; i++) expect(windows[i][0]).toBe(windows[i - 1][1] + 1n);
    expect(windows.at(-1)![1]).toBe(end);
  });

  it("halves the window on -32012", async () => {
    const windows: [bigint, bigint][] = [];
    const fetchLogs = async (f: bigint, t: bigint) => {
      if (t - f + 1n > 3_000n) throw rpcError(-32012, "requested range too large");
      windows.push([f, t]);
      return [];
    };
    const start = 0n;
    const end = start + 20_000n;
    await getLogsPaged(fetchLogs, start, end, { wait: noWait });
    expect(windows.every(([f, t]) => t - f + 1n <= 3_000n)).toBe(true);
    expect(windows[0][0]).toBe(start);
    expect(windows.at(-1)![1]).toBe(end);
    for (let i = 1; i < windows.length; i++) expect(windows[i][0]).toBe(windows[i - 1][1] + 1n);
  });

  it("backs off and retries on -32014 and HTTP 429", async () => {
    const waits: number[] = [];
    let n = 0;
    const fetchLogs = async () => {
      n++;
      if (n === 1) throw rpcError(-32014, "block not found");
      if (n === 2) throw http429();
      return [] as Log[];
    };
    await getLogsPaged(fetchLogs, 1n, 10n, { wait: async (ms) => void waits.push(ms), baseDelayMs: 100 });
    expect(n).toBe(3);
    expect(waits).toEqual([100, 200]);
  });

  it("retries -32005 (Arc testnet's rate-limit answer; viem: Request exceeds defined limit)", async () => {
    let n = 0;
    const fetchLogs = async () => {
      if (++n < 3) throw rpcError(-32005, "Request exceeds defined limit.");
      return [] as Log[];
    };
    await getLogsPaged(fetchLogs, 1n, 10n, { wait: noWait });
    expect(n).toBe(3);
  });

  it("gives up after maxRetries and rethrows other errors at once", async () => {
    await expect(getLogsPaged(async () => Promise.reject(http429()), 1n, 2n, { wait: noWait, maxRetries: 2 })).rejects.toMatchObject({ status: 429 });
    let calls = 0;
    await expect(
      getLogsPaged(
        async () => {
          calls++;
          throw rpcError(-32000, "boom");
        },
        1n,
        2n,
        { wait: noWait },
      ),
    ).rejects.toThrow("boom");
    expect(calls).toBe(1);
  });

  it("returns nothing for an empty range", async () => {
    expect(await getLogsPaged(async () => [], 10n, 9n)).toEqual([]);
  });
});

describe("viem error codes through a mocked RPC", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("surfaces -32012/-32014 codes and HTTP 429 from viem's http transport", async () => {
    const { logs } = JSON.parse(readFileSync(fixturePath("memo-logs-sender-427c.json"), "utf8")) as { logs: RawLog[] };
    const seen: { from: number; to: number }[] = [];
    let call = 0;
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      const { fromBlock, toBlock } = body.params[0];
      const from = Number(fromBlock);
      const to = Number(toBlock);
      call++;
      const json = (payload: unknown, status = 200) =>
        new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
      if (call === 1) return json({ jsonrpc: "2.0", id: body.id, error: { code: -32014, message: "header not found" } });
      if (call === 2) return new Response("rate limited", { status: 429 });
      if (to - from + 1 > 100) return json({ jsonrpc: "2.0", id: body.id, error: { code: -32012, message: "requested range too large" } });
      seen.push({ from, to });
      return json({ jsonrpc: "2.0", id: body.id, result: logs.filter((l) => Number(l.blockNumber) >= from && Number(l.blockNumber) <= to) });
    });
    const client = createPublicClient({ transport: http("https://rpc.example.invalid", { retryCount: 0 }) });
    const fetcher = memoLogsFetcher(client as unknown as LogsClient, "0x427C62eDCae20DDc8c5e875De39D4E4845491458");
    const start = 65396900n;
    const out = await getLogsPaged(fetcher, start, start + 200n, { wait: noWait });
    expect(out).toHaveLength(17);
    expect(new Set(out.map((l) => l.transactionHash)).size).toBe(3);
    expect(seen.every((w) => w.to - w.from + 1 <= 100)).toBe(true);
    const memo = decodeMemoLog(out[0]);
    expect(memo.sender).toBe("0x427C62eDCae20DDc8c5e875De39D4E4845491458");
  });

  it("rpcErrorCode reads the code from a viem RpcRequestError", async () => {
    vi.stubGlobal("fetch", async (_u: string, init: { body: string }) =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(init.body).id, error: { code: -32012, message: "requested range too large" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = createPublicClient({ transport: http("https://rpc.example.invalid", { retryCount: 0 }) });
    const err = await client.request({ method: "eth_blockNumber" }).catch((e) => e);
    expect(rpcErrorCode(err)).toBe(-32012);
  });

  it("withArcRetry retries -32014 then succeeds", async () => {
    let n = 0;
    const v = await withArcRetry(
      async () => {
        if (n++ < 2) throw rpcError(-32014);
        return "ok";
      },
      { wait: noWait },
    );
    expect(v).toBe("ok");
    await expect(withArcRetry(async () => Promise.reject(rpcError(-32000, "nope")), { wait: noWait })).rejects.toThrow("nope");
  });

  it("normalizes raw logs", () => {
    const { logs } = JSON.parse(readFileSync(fixturePath("memo-logs-sender-427c.json"), "utf8")) as { logs: RawLog[] };
    const [first] = normalizeLogs(logs);
    expect(typeof first.blockNumber).toBe("bigint");
    expect(typeof first.logIndex).toBe("number");
  });
});

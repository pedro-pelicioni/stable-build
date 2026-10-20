import type { IncomingMessage, ServerResponse } from "node:http";
import { getAddress, isAddress, type Address } from "viem";
import { createReader } from "../src/chain/reader";
import type { Reader } from "../src/chain/reader";
import { leakedViteKeys, leakMessage } from "../src/config/env-guard";
import { getNetwork } from "../src/config/networks";
import {
  isToolName,
  networkFromContext,
  rpcFor,
  runTool,
  SYSTEM_PROMPT,
  toolDefinitions,
  type ToolContext,
  type ToolProposal,
} from "../src/core/tools";

const BODY_LIMIT = 65_536;
const MAX_MESSAGES = 20;
const MAX_CONTENT = 4_000;
const MAX_ROUNDS = 4;

export interface ChatDeps {
  env: Record<string, string | undefined>;
  reader: Reader;
  fetchImpl?: typeof fetch;
}

interface InMessage {
  role: "user" | "assistant";
  content: string;
}

interface ModelCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

interface ModelTurn {
  text: string;
  calls: ModelCall[];
}

type TranscriptItem =
  | { role: "user" | "assistant"; content: string }
  | { role: "assistant-call"; content: string; calls: ModelCall[] }
  | { role: "tool"; id: string; name: string; content: string };

export async function handleChat(body: unknown, deps: ChatDeps): Promise<{ status: number; body: Record<string, unknown> }> {
  const leaked = leakedViteKeys(deps.env);
  if (leaked.length) return { status: 500, body: { error: leakMessage(leaked), fallback: true } };

  const parsed = parseBody(body);
  if (!parsed.ok) return { status: parsed.status, body: { error: parsed.error, fallback: true } };

  const provider = (deps.env.LLM_PROVIDER || "openai").trim().toLowerCase();
  if (provider !== "openai" && provider !== "anthropic") {
    return { status: 400, body: { error: "LLM_PROVIDER must be openai or anthropic", fallback: true } };
  }
  const apiKey = deps.env.LLM_API_KEY?.trim() ?? "";
  const model = deps.env.LLM_MODEL?.trim() ?? "";
  if (!apiKey || !model) {
    return { status: 503, body: { error: "LLM_API_KEY and LLM_MODEL are not set; the scripted guide is the assistant", fallback: true } };
  }

  const ctx = parsed.context;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const base = (deps.env.LLM_BASE_URL || (provider === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1")).trim();
  const transcript: TranscriptItem[] = parsed.messages.map((m) => ({ role: m.role, content: m.content }));
  const proposals: ToolProposal[] = [];
  let text = "";

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const turn = await complete({ provider, base, apiKey, model, transcript, fetchImpl });
      text = turn.text || text;
      if (turn.calls.length === 0) break;
      transcript.push({ role: "assistant-call", content: turn.text, calls: turn.calls });
      for (const call of turn.calls) {
        const result = await runTool(call.name, call.arguments, ctx, deps.reader);
        if (result.proposal && result.proposal.value === "0") proposals.push(result.proposal);
        transcript.push({ role: "tool", id: call.id, name: call.name, content: result.content });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "the model request failed";
    return { status: 502, body: { error: message, fallback: true } };
  }

  if (!text && proposals.length) text = "Review the unsigned transaction. Your wallet is the only signer.";
  return { status: 200, body: { text, proposals } };
}

function parseBody(body: unknown): { ok: true; messages: InMessage[]; context: ToolContext } | { ok: false; status: number; error: string } {
  if (!body || typeof body !== "object") return { ok: false, status: 400, error: "JSON body required" };
  const root = body as { messages?: unknown; context?: unknown };
  if (!Array.isArray(root.messages)) return { ok: false, status: 400, error: "messages must be an array" };
  if (root.messages.length > MAX_MESSAGES) return { ok: false, status: 400, error: "too many messages" };
  const messages: InMessage[] = [];
  for (const item of root.messages) {
    if (!item || typeof item !== "object") return { ok: false, status: 400, error: "each message must be an object" };
    const rec = item as { role?: unknown; content?: unknown };
    if (rec.role !== "user" && rec.role !== "assistant") return { ok: false, status: 400, error: "message role must be user or assistant" };
    if (typeof rec.content !== "string" || rec.content.length > MAX_CONTENT) return { ok: false, status: 400, error: "message content is missing or too long" };
    messages.push({ role: rec.role, content: rec.content });
  }
  const context = root.context && typeof root.context === "object" ? (root.context as Record<string, unknown>) : {};
  const network = networkFromContext(context.network);
  const account = typeof context.account === "string" && isAddress(context.account) ? getAddress(context.account) : null;
  const registry = typeof context.registry === "string" && isAddress(context.registry) ? getAddress(context.registry) : null;
  return { ok: true, messages, context: { network, account, registry, payloadJson: context.payload ?? null } };
}

async function complete(args: {
  provider: "openai" | "anthropic";
  base: string;
  apiKey: string;
  model: string;
  transcript: TranscriptItem[];
  fetchImpl: typeof fetch;
}): Promise<ModelTurn> {
  if (args.provider === "anthropic") return completeAnthropic(args);
  return completeOpenAI(args);
}

function endpoint(base: string, path: string): string {
  const b = base.replace(/\/+$/, "");
  const p = path.replace(/^\/+/, "");
  if (b.endsWith("/v1") && p.startsWith("v1/")) return `${b}/${p.slice(3)}`;
  return `${b}/${p}`;
}

async function completeOpenAI(args: {
  base: string;
  apiKey: string;
  model: string;
  transcript: TranscriptItem[];
  fetchImpl: typeof fetch;
}): Promise<ModelTurn> {
  const messages: Record<string, unknown>[] = [{ role: "system", content: SYSTEM_PROMPT }];
  for (const item of args.transcript) {
    if (item.role === "user" || item.role === "assistant") messages.push({ role: item.role, content: item.content });
    else if (item.role === "assistant-call") {
      messages.push({
        role: "assistant",
        content: item.content || null,
        tool_calls: item.calls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.arguments) },
        })),
      });
    } else if (item.role === "tool") {
      messages.push({ role: "tool", tool_call_id: item.id, content: item.content });
    }
  }
  const res = await args.fetchImpl(endpoint(args.base, "chat/completions"), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${args.apiKey}` },
    body: JSON.stringify({
      model: args.model,
      messages,
      tools: toolDefinitions().map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
    }),
  });
  if (!res.ok) throw new Error(`model HTTP ${res.status}`);
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> } }>;
  };
  const message = json.choices?.[0]?.message;
  const calls = (message?.tool_calls ?? []).map((c, i) => ({
    id: c.id || `call_${i}`,
    name: c.function?.name || "",
    arguments: parseArgs(c.function?.arguments),
  }));
  return { text: message?.content?.trim() || "", calls: calls.filter((c) => isToolName(c.name) || c.name !== "") };
}

async function completeAnthropic(args: {
  base: string;
  apiKey: string;
  model: string;
  transcript: TranscriptItem[];
  fetchImpl: typeof fetch;
}): Promise<ModelTurn> {
  const messages: Record<string, unknown>[] = [];
  for (const item of args.transcript) {
    if (item.role === "user") messages.push({ role: "user", content: item.content });
    else if (item.role === "assistant") messages.push({ role: "assistant", content: item.content });
    else if (item.role === "assistant-call") {
      const content: Record<string, unknown>[] = [];
      if (item.content) content.push({ type: "text", text: item.content });
      for (const c of item.calls) content.push({ type: "tool_use", id: c.id, name: c.name, input: c.arguments });
      messages.push({ role: "assistant", content });
    } else if (item.role === "tool") {
      messages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: item.id, content: item.content }],
      });
    }
  }
  const res = await args.fetchImpl(endpoint(args.base, "v1/messages"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": args.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: args.model,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: toolDefinitions().map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
      messages,
    }),
  });
  if (!res.ok) throw new Error(`model HTTP ${res.status}`);
  const json = (await res.json()) as { content?: Array<{ type?: string; text?: string; id?: string; name?: string; input?: unknown }> };
  const blocks = json.content ?? [];
  const text = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n").trim();
  const calls = blocks
    .filter((b) => b.type === "tool_use")
    .map((b, i) => ({
      id: b.id || `tool_${i}`,
      name: b.name || "",
      arguments: b.input && typeof b.input === "object" && !Array.isArray(b.input) ? (b.input as Record<string, unknown>) : {},
    }));
  return { text, calls };
}

function parseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function readBody(req: IncomingMessage): Promise<unknown> {
  const preset = (req as IncomingMessage & { body?: unknown }).body;
  if (preset && typeof preset === "object") return Promise.resolve(preset);
  if (typeof preset === "string") {
    try {
      return Promise.resolve(JSON.parse(preset));
    } catch {
      return Promise.reject(Object.assign(new Error("invalid JSON"), { status: 400 }));
    }
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer | string) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += buf.length;
      if (size > BODY_LIMIT) {
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error("invalid JSON"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function writeJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

/** Node handler for Vercel (`api/chat`) and for `vite dev`. */
export default async function nodeHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== "POST") {
    writeJson(res, 405, { error: "POST only", fallback: true });
    return;
  }
  try {
    const body = await readBody(req);
    const network = networkFromContext(body && typeof body === "object" ? (body as { context?: { network?: unknown } }).context?.network : null);
    const reader = createReader(getNetwork(network, rpcFor(network, process.env)));
    const result = await handleChat(body, { env: process.env, reader });
    writeJson(res, result.status, result.body);
  } catch (err) {
    const status = err && typeof err === "object" && "status" in err && typeof (err as { status: unknown }).status === "number" ? (err as { status: number }).status : 400;
    const message = err instanceof Error ? err.message : "bad request";
    writeJson(res, status, { error: message, fallback: true });
  }
}

export type { Address };

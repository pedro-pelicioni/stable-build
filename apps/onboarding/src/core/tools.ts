import { getAddress, isAddress, type Address, type Hex } from "viem";
import type { BadgeView, Reader } from "../chain/reader";
import { publicRpc, resolveNetworkName, type NetworkName } from "../config/networks";
import { explainStep, STEPS } from "./guide";
import { assertChain, FeeMismatch } from "./guard";
import { PayloadError, parsePayload, type ValidPayload } from "./payload";
import { formatErc20Usdc } from "./units";
import { buildApproveTx, buildRegisterTx, type BuiltTx } from "./tx";
import { simulateRegistration } from "./simulate";

/** Tools the model may call. Every one reads or prepares. None of them signs or broadcasts. */
export const TOOL_NAMES = [
  "get_balance",
  "explain_step",
  "simulate_tx",
  "build_approve_tx",
  "build_register_tx",
  "get_registry_badge",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export function isToolName(name: string): name is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(name);
}

export interface ToolContext {
  network: NetworkName;
  account: Address | null;
  registry: Address | null;
  payloadJson: unknown | null;
}

export interface ToolProposal {
  kind: "approve" | "register";
  to: Address;
  data: Hex;
  value: "0";
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
}

export interface ToolResult {
  content: string;
  proposal: ToolProposal | null;
}

const SCHEMAS: Record<ToolName, { description: string; parameters: Record<string, unknown> }> = {
  get_balance: {
    description: "Read the ERC-20 USDC balance (6 decimals) of an address. Does not read the native balance.",
    parameters: { type: "object", properties: { address: { type: "string" } }, additionalProperties: false },
  },
  explain_step: {
    description: "Explain one onboarding step: connect, switch, balance, payload, simulate, approve, register, badge.",
    parameters: {
      type: "object",
      properties: { step: { type: "string", enum: [...STEPS] } },
      required: ["step"],
      additionalProperties: false,
    },
  },
  simulate_tx: {
    description: "eth_call and estimateGas for the approve or register transaction already in the signed payload. Does not sign.",
    parameters: {
      type: "object",
      properties: { kind: { type: "string", enum: ["approve", "register"] } },
      required: ["kind"],
      additionalProperties: false,
    },
  },
  build_approve_tx: {
    description: "Build an unsigned approve of the exact signed fee. Value is 0. Fails with FeeMismatch when the registry fee differs.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  build_register_tx: {
    description: "Build an unsigned register() transaction from the signed payload. Value is 0. Does not sign.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  get_registry_badge: {
    description: "Read badgeOf for a project address.",
    parameters: { type: "object", properties: { project: { type: "string" } }, additionalProperties: false },
  },
};

export function toolDefinitions(): Array<{ name: ToolName; description: string; parameters: Record<string, unknown> }> {
  return TOOL_NAMES.map((name) => ({ name, ...SCHEMAS[name] }));
}

export const SYSTEM_PROMPT = [
  "You help a person register a project on GoLiveRegistry on Arc.",
  "You never sign, never ask for a private key, and never tell them to attach native value.",
  "Transaction value is always 0. The fee is an ERC-20 amount with 6 decimals.",
  "You may only call the provided tools. Unsigned transactions come only from build_approve_tx and build_register_tx.",
  "Explain the next step in plain language.",
].join(" ");

function json(value: unknown): string {
  return JSON.stringify(value);
}

function proposalFrom(tx: BuiltTx): ToolProposal {
  return {
    kind: tx.kind,
    to: tx.to,
    data: tx.data,
    value: "0",
    maxFeePerGas: tx.maxFeePerGas.toString(),
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas.toString(),
  };
}

async function loadPayload(ctx: ToolContext): Promise<ValidPayload> {
  if (!ctx.registry) throw new PayloadError("registry", "registry address is not set");
  if (ctx.payloadJson == null) throw new PayloadError("payload", "no signed payload is attached");
  return parsePayload(ctx.payloadJson, { chainId: expectedChain(ctx.network), registry: ctx.registry });
}

function expectedChain(network: NetworkName): number {
  return network === "mainnet" ? 5042 : 5042002;
}

async function assertReaderChain(ctx: ToolContext, reader: Reader): Promise<void> {
  assertChain(await reader.chainId(), expectedChain(ctx.network));
}

function accountOf(ctx: ToolContext, requested: unknown): Address {
  const raw = typeof requested === "string" && requested ? requested : ctx.account;
  if (typeof raw !== "string" || !isAddress(raw)) throw new PayloadError("account", "no wallet address");
  return getAddress(raw);
}

export async function runTool(name: string, args: Record<string, unknown>, ctx: ToolContext, reader: Reader): Promise<ToolResult> {
  if (!isToolName(name)) {
    return { content: json({ error: `unknown tool ${name}` }), proposal: null };
  }
  try {
    switch (name) {
      case "get_balance": {
        await assertReaderChain(ctx, reader);
        const account = accountOf(ctx, args.address);
        const decimals = await reader.decimals();
        const balance = await reader.balanceOf(account);
        return {
          content: json({ address: account, balance: balance.toString(), formatted: formatErc20Usdc(balance), decimals }),
          proposal: null,
        };
      }
      case "explain_step": {
        const text = explainStep(String(args.step ?? ""));
        if (!text) return { content: json({ error: "unknown step" }), proposal: null };
        return { content: json({ step: args.step, text }), proposal: null };
      }
      case "simulate_tx": {
        await assertReaderChain(ctx, reader);
        const payload = await loadPayload(ctx);
        const from = accountOf(ctx, null);
        const storedFee = await reader.fee(ctx.registry as Address);
        if (payload.fee !== storedFee) throw new FeeMismatch(payload.fee, storedFee);
        const simulation = await simulateRegistration(reader, payload, from);
        const kind = args.kind === "approve" ? "approve" : args.kind === "register" ? "register" : null;
        if (!kind) return { content: json({ error: "kind must be approve or register" }), proposal: null };
        const outcome = kind === "approve" ? simulation.approve : simulation.register;
        return { content: json({ kind, note: simulation.note, outcome }), proposal: null };
      }
      case "build_approve_tx": {
        await assertReaderChain(ctx, reader);
        const payload = await loadPayload(ctx);
        const storedFee = await reader.fee(ctx.registry as Address);
        const base = await reader.baseFeePerGas();
        const tx = buildApproveTx(payload, storedFee, base);
        return { content: json({ proposal: proposalFrom(tx), note: "unsigned; the wallet must sign" }), proposal: proposalFrom(tx) };
      }
      case "build_register_tx": {
        await assertReaderChain(ctx, reader);
        const payload = await loadPayload(ctx);
        const storedFee = await reader.fee(ctx.registry as Address);
        const base = await reader.baseFeePerGas();
        const tx = buildRegisterTx(payload, storedFee, base);
        return { content: json({ proposal: proposalFrom(tx), note: "unsigned; the wallet must sign" }), proposal: proposalFrom(tx) };
      }
      case "get_registry_badge": {
        await assertReaderChain(ctx, reader);
        if (!ctx.registry) throw new PayloadError("registry", "registry address is not set");
        let project: Address;
        if (typeof args.project === "string" && isAddress(args.project)) project = getAddress(args.project);
        else project = (await loadPayload(ctx)).message.project;
        const badge: BadgeView = await reader.badgeOf(ctx.registry, project);
        return {
          content: json({
            project: badge.project,
            listed: badge.listed,
            gates: badge.gates,
            registrant: badge.registrant,
            registeredAt: badge.registeredAt.toString(),
            reportHash: badge.reportHash,
            expiry: badge.expiry.toString(),
            nonce: badge.nonce.toString(),
          }),
          proposal: null,
        };
      }
      default:
        return { content: json({ error: "unreachable" }), proposal: null };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: json({ error: message }), proposal: null };
  }
}

export function networkFromContext(value: unknown): NetworkName {
  return resolveNetworkName(typeof value === "string" ? value : null);
}

export function rpcFor(network: NetworkName, env: Record<string, string | undefined>): string {
  const override = env.ARC_RPC_URL?.trim();
  return override || publicRpc(network);
}

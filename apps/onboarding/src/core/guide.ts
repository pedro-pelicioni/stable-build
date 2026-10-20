import { MAINNET_CONFIRMATION, type NetworkConfig } from "../config/networks";
import type { Phase } from "./review";
import { formatErc20Usdc } from "./units";

export const ASSISTANT_NAME = "Onboarding";

export const STEPS = ["connect", "switch", "balance", "payload", "simulate", "approve", "register", "badge"] as const;
export type GuideStep = (typeof STEPS)[number];

const EXPLAIN: Record<GuideStep, string> = {
  connect: "Connect an injected wallet (MetaMask, Rabby, or another EIP-1193 wallet). You sign every transaction. This app never sees the key.",
  switch: "The wallet has to be on the Arc chain this build is configured for. Testnet is chain 5042002. Mainnet is chain 5042.",
  balance: "The balance shown is USDC from the ERC-20 interface at 0x3600…0000, 6 decimals. The native view of that same balance uses 18 decimals and is not added to this number.",
  payload: "Use + to attach the JSON from go-live-sign.mjs. The verifier signs that file on the developer's machine. The verifier key is not part of this app.",
  simulate: "Before any signature, the app runs eth_call and estimateGas. A registry error stops the flow. An allowance error means approve comes first.",
  approve: "approve() sets the exact signed fee on the USDC ERC-20 for the registry. The transaction value is 0.",
  register: "register() checks the EIP-712 signature, checks that the project has code, and pulls the fee with transferFrom. The transaction value is 0.",
  badge: "After the receipt, badgeOf is read back. The event line links the transaction on the explorer.",
};

export function explainStep(step: string): string | null {
  if (!isStep(step)) return null;
  return EXPLAIN[step];
}

function isStep(step: string): step is GuideStep {
  return (STEPS as readonly string[]).includes(step);
}

export function welcomeText(network: NetworkConfig): string {
  return [
    "This is stable-build onboarding. It walks a wallet through register() on GoLiveRegistry.",
    "You sign in your own wallet. Nothing here signs for you.",
    "",
    `This build is on ${network.label} (chain ${network.chainId}).`,
    "1. Connect a wallet.",
    "2. Switch to that chain.",
    "3. Attach the signed go-live payload with +.",
    "4. Approve the exact fee, then register.",
  ].join("\n");
}

export function balanceText(baseUnits: bigint): string {
  return `USDC balance: ${formatErc20Usdc(baseUnits)} (ERC-20, 6 decimals). Attach the signed payload with +.`;
}

export function feeLine(fee: bigint): string {
  return `${formatErc20Usdc(fee)} USDC`;
}

export function simulationEvent(fee: bigint): string {
  return `Simulation passed (fee ${feeLine(fee)})`;
}

export function mainnetPrompt(fee: bigint): string {
  return `Mainnet: type ${MAINNET_CONFIRMATION} and set a fee cap at or above ${feeLine(fee)} before any transaction.`;
}

/** Deterministic reply for a composer message when /api/chat is off or unavailable. */
export function scriptedReply(input: {
  phase: Phase;
  text: string;
  network: NetworkConfig;
  fee: bigint | null;
  blockReason: string | null;
}): string {
  const text = input.text.trim();
  if (input.phase === "blocked" && input.blockReason) return input.blockReason;
  if (input.network.name === "mainnet" && text === MAINNET_CONFIRMATION) {
    return input.fee == null
      ? `Recorded. Attach a signed payload, then set a fee cap, before any transaction.`
      : `Recorded. Set a fee cap at or above ${feeLine(input.fee)}, then use the approve or register button.`;
  }
  if (/^\d+(\.\d{1,6})?$/.test(text) && input.network.name === "mainnet") {
    return `Fee cap set to ${text} USDC. It must cover the signed fee.`;
  }
  switch (input.phase) {
    case "connect":
      return explainStep("connect") ?? "";
    case "payload":
      return explainStep("payload") ?? "";
    case "approve":
      return input.network.name === "mainnet" && input.fee != null
        ? `${explainStep("approve")}\n\n${mainnetPrompt(input.fee)}`
        : explainStep("approve") ?? "";
    case "register":
      return input.network.name === "mainnet" && input.fee != null
        ? `${explainStep("register")}\n\n${mainnetPrompt(input.fee)}`
        : explainStep("register") ?? "";
    case "done":
      return explainStep("badge") ?? "";
    default:
      return explainStep("simulate") ?? "";
  }
}

import type { Address, Hex } from "viem";
import type { ValidPayload } from "../core/payload";

export type Message =
  | { id: string; kind: "assistant" | "user"; text: string; actions?: Action[] }
  | { id: string; kind: "event"; text: string; href?: string; hrefLabel?: string };

export interface Action {
  id: "connect" | "approve" | "register";
  label: string;
}

export interface Session {
  id: string;
  name: string;
  messages: Message[];
  seen: number;
  payloadJson: unknown | null;
  payload: ValidPayload | null;
  confirmation: string;
  feeCap: string;
  approveHash: Hex | null;
  registerHash: Hex | null;
  account: Address | null;
}

const STORAGE_KEY = "stable-build.onboarding.sessions.v1";

export function previewOf(session: Session): string {
  const last = [...session.messages].reverse().find((m) => m.kind !== "event");
  if (!last) return "New onboarding";
  const line = last.text.split("\n").find((l) => l.trim()) ?? "New onboarding";
  return line.length > 72 ? `${line.slice(0, 69)}…` : line;
}

export function isUnread(session: Session, activeId: string): boolean {
  return session.id !== activeId && session.messages.length > session.seen;
}

export function markSeen(session: Session): Session {
  return { ...session, seen: session.messages.length };
}

let seq = 0;
export function nextId(prefix: string): string {
  seq += 1;
  const rand = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(seq);
  return `${prefix}-${rand}`;
}

export function emptySession(name: string, welcome: string): Session {
  return {
    id: nextId("s"),
    name,
    messages: [{ id: nextId("m"), kind: "assistant", text: welcome, actions: [{ id: "connect", label: "Connect wallet" }] }],
    seen: 0,
    payloadJson: null,
    payload: null,
    confirmation: "",
    feeCap: "",
    approveHash: null,
    registerHash: null,
    account: null,
  };
}

interface Stored {
  activeId: string;
  sessions: Session[];
}

export function loadSessions(welcome: string): { activeId: string; sessions: Session[] } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) throw new Error("empty");
    const parsed = JSON.parse(raw) as Stored;
    if (!Array.isArray(parsed.sessions) || parsed.sessions.length === 0) throw new Error("empty");
    return { activeId: parsed.activeId, sessions: parsed.sessions };
  } catch {
    const session = emptySession("Onboarding", welcome);
    return { activeId: session.id, sessions: [{ ...session, seen: session.messages.length }] };
  }
}

export function saveSessions(activeId: string, sessions: Session[]): void {
  try {
    const stored: Stored = {
      activeId,
      sessions: sessions.map((s) => ({
        ...s,
        // The validated payload is rebuilt from payloadJson. Drop the derived object so the file stays small.
        payload: null,
      })),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // A full disk or a private-mode quota miss keeps the session in memory.
  }
}

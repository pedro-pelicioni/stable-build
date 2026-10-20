import { useEffect, useMemo, useRef, useState } from "react";
import { BaseError, type Address, type WalletClient } from "viem";
import { createReader, type Reader } from "./chain/reader";
import {
  FAUCET_URL,
  MAINNET_CONFIRMATION,
  explorerTxUrl,
  getNetwork,
  resolveNetworkName,
} from "./config/networks";
import { ASSISTANT_NAME, balanceText, mainnetPrompt, scriptedReply, simulationEvent, welcomeText } from "./core/guide";
import { GateError } from "./core/guard";
import { derivePhase, readBadge, registryAddress, reviewPayload, type Phase, type Review } from "./core/review";
import { gateTx, sameCall, type BuiltTx } from "./core/tx";
import { formatErc20Usdc } from "./core/units";
import type { ToolProposal } from "./core/tools";
import {
  emptySession,
  isUnread,
  loadSessions,
  markSeen,
  nextId,
  previewOf,
  saveSessions,
  type Action,
  type Message,
  type Session,
} from "./ui/sessions";
import { connectWallet, sendPrepared } from "./ui/wallet";

// Only named VITE_* properties are read. Iterating the whole env object would inline every VITE_* value.
const network = getNetwork(resolveNetworkName(import.meta.env.VITE_NETWORK), import.meta.env.VITE_RPC_URL || undefined);
const registry = registryAddress(import.meta.env.VITE_REGISTRY_ADDRESS);
const chatEnabled = import.meta.env.VITE_CHAT_ENABLED === "true";
const isMainnet = network.name === "mainnet";

function errorText(err: unknown): string {
  if (err instanceof GateError) return err.message;
  if (err instanceof BaseError) return err.shortMessage || err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function avatarHue(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 33 + seed.charCodeAt(i)) >>> 0;
  return h % 360;
}

function Avatar({ seed }: { seed: string }) {
  return <span className="avatar" style={{ background: `hsl(${avatarHue(seed)} 42% 46%)` }} aria-hidden="true" />;
}

function welcome(): string {
  const base = welcomeText(network);
  return registry ? base : `${base}\n\nSet VITE_REGISTRY_ADDRESS before a payload can be checked.`;
}

export function App() {
  const reader = useMemo<Reader>(() => createReader(network), []);
  const initial = useMemo(() => loadSessions(welcome()), []);
  const [sessions, setSessions] = useState<Session[]>(initial.sessions);
  const [activeId, setActiveId] = useState(initial.activeId);
  const [wallet, setWallet] = useState<WalletClient | null>(null);
  const [account, setAccount] = useState<Address | null>(null);
  const [chainOk, setChainOk] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [unseen, setUnseen] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const seenLen = useRef(0);
  const activeIdRef = useRef(activeId);
  const sessionsRef = useRef(sessions);
  const reviewRef = useRef(review);
  const accountRef = useRef(account);
  const walletRef = useRef(wallet);
  activeIdRef.current = activeId;
  sessionsRef.current = sessions;
  reviewRef.current = review;
  accountRef.current = account;
  walletRef.current = wallet;

  const session = sessions.find((s) => s.id === activeId) ?? sessions[0];
  const phase: Phase = derivePhase({
    account,
    chainOk,
    payloadReady: Boolean(session?.payloadJson),
    reviewed: review !== null,
    blocked: review?.blocked ?? null,
    canApprove: Boolean(review?.simulation.canApprove),
    canRegister: Boolean(review?.simulation.canRegister),
    registered: Boolean(session?.registerHash),
  });

  useEffect(() => {
    saveSessions(activeId, sessions);
  }, [activeId, sessions]);

  useEffect(() => {
    const id = activeId;
    const who = accountRef.current;
    const current = sessionsRef.current.find((s) => s.id === id);
    if (!who || !chainOk || !registry || !current?.payloadJson || current.registerHash) return;
    let cancel = false;
    reviewPayload({ json: current.payloadJson, network, registry, reader, account: who })
      .then((next) => {
        if (!cancel && activeIdRef.current === id) setReview(next);
      })
      .catch(() => {});
    return () => {
      cancel = true;
    };
  }, [activeId, chainOk, reader]);

  useEffect(() => {
    const el = scroller.current;
    const len = session?.messages.length ?? 0;
    const delta = len - seenLen.current;
    seenLen.current = len;
    if (!el || delta <= 0) return;
    if (stick.current) el.scrollTop = el.scrollHeight;
    else setUnseen((n) => n + delta);
  }, [session?.messages.length]);

  function patch(id: string, fn: (s: Session) => Session) {
    setSessions((prev) => prev.map((s) => (s.id === id ? fn(s) : s)));
  }

  function push(id: string, message: Message) {
    patch(id, (s) => ({ ...s, messages: [...s.messages, message] }));
  }

  function select(id: string) {
    setActiveId(id);
    setSessions((prev) => prev.map((s) => (s.id === id ? markSeen(s) : s)));
    setReview(null);
    setUnseen(0);
    stick.current = true;
  }

  function addSession() {
    const created = emptySession(sessions.length === 0 ? "Onboarding" : `Onboarding ${sessions.length + 1}`, welcome());
    setSessions((prev) => [...prev.map((s) => (s.id === activeId ? { ...s, seen: s.messages.length } : s)), { ...created, seen: created.messages.length }]);
    setActiveId(created.id);
    setReview(null);
  }

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      push(activeIdRef.current, { id: nextId("m"), kind: "assistant", text: errorText(err) });
    } finally {
      setBusy(false);
    }
  }

  async function refreshReview(id: string, json: unknown, who: Address) {
    if (!registry) throw new Error("Set VITE_REGISTRY_ADDRESS to the GoLiveRegistry for this network.");
    const next = await reviewPayload({ json, network, registry, reader, account: who });
    if (activeIdRef.current === id) setReview(next);
    const lines: Message[] = [];
    if (next.blocked) {
      lines.push({ id: nextId("m"), kind: "assistant", text: next.blocked });
    } else if (next.simulation.canRegister || next.simulation.canApprove) {
      lines.push({ id: nextId("m"), kind: "event", text: simulationEvent(next.payload.fee) });
      const actions: Action[] = next.simulation.canRegister
        ? [{ id: "register", label: "Sign register" }]
        : [{ id: "approve", label: "Sign approve" }];
      const extra = isMainnet ? `\n\n${mainnetPrompt(next.payload.fee)}` : "";
      lines.push({ id: nextId("m"), kind: "assistant", text: `${next.simulation.note}.${extra}`, actions });
    }
    patch(id, (s) => ({ ...s, payload: next.payload, messages: [...s.messages, ...lines] }));
    return next;
  }

  function onConnect() {
    const id = activeIdRef.current;
    return run(async () => {
      const connected = await connectWallet(network);
      setWallet(connected.wallet);
      setAccount(connected.account);
      setChainOk(true);
      walletRef.current = connected.wallet;
      accountRef.current = connected.account;
      patch(id, (s) => ({ ...s, account: connected.account }));
      push(id, { id: nextId("m"), kind: "event", text: "Wallet connected" });
      push(id, { id: nextId("m"), kind: "event", text: `Network switched to ${network.label}` });
      const decimals = await reader.decimals();
      const balance = await reader.balanceOf(connected.account);
      const faucet = network.name === "testnet" && balance === 0n ? `\n\nTestnet USDC is available from ${FAUCET_URL}.` : "";
      push(id, { id: nextId("m"), kind: "assistant", text: `${balanceText(balance)} Decimals checked: ${decimals}.${faucet}` });
      const current = sessionsRef.current.find((s) => s.id === id);
      if (current?.payloadJson) await refreshReview(id, current.payloadJson, connected.account);
    });
  }

  function onFile(file: File) {
    const id = activeIdRef.current;
    return run(async () => {
      const text = await file.text();
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error("That file is not JSON.");
      }
      push(id, { id: nextId("m"), kind: "user", text: `Attached ${file.name}` });
      patch(id, (s) => ({
        ...s,
        payloadJson: json,
        name: s.name.startsWith("Onboarding") ? file.name.replace(/\.json$/i, "") : s.name,
      }));
      const who = accountRef.current;
      if (!who || !chainOk) {
        push(id, { id: nextId("m"), kind: "assistant", text: "Payload stored. Connect the wallet on the configured chain to check the fee and simulate." });
        return;
      }
      await refreshReview(id, json, who);
    });
  }

  async function sign(kind: "approve" | "register") {
    const id = activeIdRef.current;
    const current = sessionsRef.current.find((s) => s.id === id);
    const live = reviewRef.current;
    const who = accountRef.current;
    const signer = walletRef.current;
    if (!current || !live || !who || !signer) throw new Error("Connect the wallet before signing.");
    const built: BuiltTx | null = kind === "approve" ? live.approveTx : live.registerTx;
    if (!built) throw new Error(live.blocked ?? "That transaction is not ready.");
    const tx = gateTx(network, built, live.payload.fee, { confirmation: current.confirmation, capUsdc: current.feeCap });
    push(id, { id: nextId("m"), kind: "assistant", text: `Confirm ${kind} in your wallet. Value is 0.` });
    const hash = await sendPrepared(signer, who, tx);
    const href = explorerTxUrl(network, hash);
    if (kind === "approve") {
      push(id, { id: nextId("m"), kind: "event", text: "Approve sent", href, hrefLabel: "view on explorer" });
      patch(id, (s) => ({ ...s, approveHash: hash }));
      await reader.wait(hash);
      const next = await refreshReview(id, current.payloadJson, who);
      if (!next.simulation.canRegister) throw new Error(next.blocked ?? "register() is not ready after approve");
      return;
    }
    push(id, { id: nextId("m"), kind: "event", text: "Registered ✓", href, hrefLabel: "view on explorer" });
    patch(id, (s) => ({ ...s, registerHash: hash }));
    await reader.wait(hash);
    if (registry) {
      const badge = await readBadge(reader, registry, live.payload.message.project);
      const when = badge.registeredAt === 0n ? "not listed yet" : new Date(Number(badge.registeredAt) * 1000).toISOString();
      push(id, {
        id: nextId("m"),
        kind: "assistant",
        text: badge.listed
          ? `Badge for ${short(badge.project)}. Gates ${badge.gates}. Registrant ${short(badge.registrant)}. Recorded ${when}.`
          : "The receipt is in, and badgeOf does not list this project yet. Check the transaction on the explorer.",
      });
    }
  }

  function onSend() {
    const text = draft.trim();
    if (!text || !session) return;
    const id = session.id;
    setDraft("");
    push(id, { id: nextId("m"), kind: "user", text });
    if (text === MAINNET_CONFIRMATION) patch(id, (s) => ({ ...s, confirmation: text }));
    if (isMainnet && /^\d+(\.\d{1,6})?$/.test(text)) patch(id, (s) => ({ ...s, feeCap: text }));
    return run(async () => {
      if (chatEnabled) {
        const answered = await askModel(id, text);
        if (answered) return;
      }
      const live = reviewRef.current;
      push(id, {
        id: nextId("m"),
        kind: "assistant",
        text: scriptedReply({
          phase,
          text,
          network,
          fee: live?.payload.fee ?? null,
          blockReason: live?.blocked ?? null,
        }),
      });
    });
  }

  async function askModel(id: string, text: string): Promise<boolean> {
    const current = sessionsRef.current.find((s) => s.id === id);
    if (!current) return false;
    const history = current.messages
      .filter((m): m is Extract<Message, { kind: "assistant" | "user" }> => m.kind === "assistant" || m.kind === "user")
      .slice(-12)
      .map((m) => ({ role: m.kind === "user" ? "user" as const : "assistant" as const, content: m.text }));
    history.push({ role: "user", content: text });
    let res: Response;
    try {
      res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: history,
          context: {
            network: network.name,
            account,
            registry,
            payload: current.payloadJson,
          },
        }),
      });
    } catch {
      return false;
    }
    if (!res.ok) return false;
    const body = (await res.json()) as { text?: string; proposals?: ToolProposal[]; fallback?: boolean };
    if (body.fallback) return false;
    const live = reviewRef.current;
    const actions: Action[] = [];
    for (const proposal of body.proposals ?? []) {
      const local = proposal.kind === "approve" ? live?.approveTx : live?.registerTx;
      if (local && sameCall(local, proposal)) actions.push({ id: proposal.kind, label: proposal.kind === "approve" ? "Sign approve" : "Sign register" });
    }
    push(id, { id: nextId("m"), kind: "assistant", text: body.text || "No reply.", actions: actions.length ? actions : undefined });
    return true;
  }

  const shown = sessions.filter((s) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return s.name.toLowerCase().includes(q) || previewOf(s).toLowerCase().includes(q);
  });

  if (!session) return null;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-top">
          <button type="button" className="icon" aria-label="Search sessions" aria-pressed={searchOpen} onClick={() => setSearchOpen((v) => !v)}>
            <SearchIcon />
          </button>
          <button type="button" className="icon" aria-label="New session" onClick={addSession}>
            <PlusIcon />
          </button>
        </div>
        {searchOpen && (
          <input
            className="search"
            placeholder="Search"
            value={query}
            aria-label="Filter sessions"
            onChange={(e) => setQuery(e.target.value)}
          />
        )}
        <ul className="sessions">
          {shown.map((s) => (
            <li key={s.id}>
              <button type="button" className={s.id === session.id ? "session selected" : "session"} onClick={() => select(s.id)}>
                <Avatar seed={s.name} />
                <span className="session-text">
                  <strong>{s.name}</strong>
                  <span>{previewOf(s)}</span>
                </span>
                {isUnread(s, session.id) && <span className="dot" aria-label="Unread" />}
              </button>
            </li>
          ))}
        </ul>
        <footer className="sidebar-foot">
          <Avatar seed={account ?? "wallet"} />
          {account ? (
            <div className="who">
              <span>{short(account)}</span>
              <span className={isMainnet ? "net-badge mainnet" : "net-badge"}>{isMainnet ? "Mainnet" : "Testnet"}</span>
              {review && <span className="muted">{formatErc20Usdc(review.balance)} USDC</span>}
            </div>
          ) : (
            <button type="button" className="pill" onClick={onConnect} disabled={busy}>
              Connect wallet
            </button>
          )}
        </footer>
      </aside>
      <main className="panel">
        <header className="head">
          <h1>{ASSISTANT_NAME}</h1>
          <span className={isMainnet ? "net-badge mainnet" : "net-badge"}>{isMainnet ? "Mainnet" : "Testnet"}</span>
        </header>
        <div className="transcript-wrap">
          {unseen > 0 && (
            <button
              type="button"
              className="jump"
              onClick={() => {
                stick.current = true;
                setUnseen(0);
                const el = scroller.current;
                if (el) el.scrollTop = el.scrollHeight;
              }}
            >
              {unseen} new {unseen === 1 ? "message" : "messages"} ↑
            </button>
          )}
          <div
            className="transcript"
            ref={scroller}
            onScroll={() => {
              const el = scroller.current;
              if (!el) return;
              const near = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
              stick.current = near;
              if (near) setUnseen(0);
            }}
          >
            {session.messages.map((m) =>
              m.kind === "event" ? (
                <p key={m.id} className="event">
                  {m.text}
                  {m.href && (
                    <>
                      {" "}
                      <a href={m.href} target="_blank" rel="noreferrer">
                        {m.hrefLabel ?? "view on explorer"}
                      </a>
                    </>
                  )}
                </p>
              ) : (
                <div key={m.id} className={m.kind === "user" ? "bubble user" : "bubble assistant"}>
                  {m.text.split("\n").map((line, i) => (
                    <p key={i}>{line || "\u00a0"}</p>
                  ))}
                  {m.kind === "assistant" && m.actions && m.actions.length > 0 && (
                    <div className="actions">
                      {m.actions.map((a) => (
                        <button
                          key={a.id}
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            const kind = a.id;
                            if (kind === "connect") void onConnect();
                            if (kind === "approve" || kind === "register") void run(() => sign(kind));
                          }}
                        >
                          {a.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ),
            )}
          </div>
        </div>
        {isMainnet && (phase === "approve" || phase === "register") && (
          <div className="gate">
            <label>
              Type {MAINNET_CONFIRMATION}
              <input
                value={session.confirmation}
                autoComplete="off"
                onChange={(e) => patch(session.id, (s) => ({ ...s, confirmation: e.target.value }))}
              />
            </label>
            <label>
              Fee cap (USDC)
              <input
                value={session.feeCap}
                inputMode="decimal"
                placeholder="0.05"
                onChange={(e) => patch(session.id, (s) => ({ ...s, feeCap: e.target.value }))}
              />
            </label>
          </div>
        )}
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            void onSend();
          }}
        >
          <button type="button" className="icon plus" aria-label="Attach go-live payload" onClick={() => fileRef.current?.click()}>
            <PlusIcon />
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void onFile(file);
            }}
          />
          <input
            className="draft"
            placeholder="Message"
            value={draft}
            aria-label="Message"
            onChange={(e) => setDraft(e.target.value)}
          />
          <button type="submit" className="send" aria-label="Send" disabled={busy || draft.trim() === ""}>
            <SendIcon />
          </button>
        </form>
      </main>
    </div>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <circle cx="11" cy="11" r="6" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M16 16l4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path d="M12 19V6M6.5 11.5 12 6l5.5 5.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

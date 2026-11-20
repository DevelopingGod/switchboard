"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import { ArrowDown, MessageSquare } from "lucide-react";
import { Composer, type ComposerSend } from "@/components/kit/Composer";
import { EmptyState } from "@/components/kit/EmptyState";
import { useToast } from "@/components/kit/Toast";
import { sendFeedback, stopReply } from "@/app/chat/actions";
import { dayKey, localDay } from "@/lib/thread-groups";
import { readSse } from "@/lib/sse";
import { THREAD_UPDATED, notifyThreadsChanged } from "@/lib/thread-events";
import { PENDING_KEY, type PendingMessage } from "@/lib/pending";
import { useMedia } from "@/lib/use-media";
import type { ChatStreamBody, ChatThread, RouteInfo, TargetsResponse, ThreadResponse } from "@/lib/router-types";
import { t } from "@/i18n/strings";
import { tChat } from "@/i18n/chat";
import { MessageItem, type Live, type UiMessage } from "./MessageItem";
import { TargetPicker } from "./TargetPicker";
import { StaticHeader, ThreadHeader } from "./ThreadHeader";

// M3a: shown only in long threads; its own chunk with its strings.
const SummaryNote = dynamic(() => import("./PrivacyNotes").then((m) => m.SummaryNote), { ssr: false });

const newLive = (): Live => ({ thinking: "", thinkStart: null, thinkEnd: null, label: null, note: null });

/** A send failure whose message is already plain language. */
class SendError extends Error {}

/** "Today" / "Yesterday" / "Tue 10 Nov" between messages from different days. */
function DateSeparator({ iso }: { iso: string }) {
  const k = dayKey(iso);
  return (
    <li className="date-sep">
      <span>{k.kind === "date" ? k.text : tChat(`chat.${k.kind}`)}</span>
    </li>
  );
}

/** Shown when the newest message is more than a screen below; an IntersectionObserver, no scroll handler. */
function useAwayFromLatest(sentinel: React.RefObject<HTMLDivElement | null>) {
  const [away, setAway] = React.useState(false);
  React.useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setAway(!e.isIntersecting), { rootMargin: `0px 0px ${window.innerHeight}px 0px` });
    io.observe(el);
    return () => io.disconnect();
  }, [sentinel]);
  return away;
}

export function ChatScreen({
  current,
  privateDefault = false,
}: {
  current: ThreadResponse | null;
  /** Settings → Privacy: new chats start with Private on. */
  privateDefault?: boolean;
}) {
  const { push } = useToast();
  const phone = useMedia("(max-width: 639px)");
  const [thread, setThread] = React.useState<ChatThread | null>(current?.thread ?? null);
  const [messages, setMessages] = React.useState<UiMessage[]>(current?.messages ?? []);
  const [text, setText] = React.useState("");
  const [target, setTarget] = React.useState("auto");
  const [privateOn, setPrivateOn] = React.useState(current ? current.thread.private : privateDefault);
  const [autonomy, setAutonomy] = React.useState(1);
  const [temperature, setTemperature] = React.useState(0.7);
  const [targets, setTargets] = React.useState<TargetsResponse | null>(null);
  const [streaming, setStreaming] = React.useState(false);
  const [sendError, setSendError] = React.useState<string | null>(null);
  const abort = React.useRef<AbortController | null>(null);
  const requestId = React.useRef<number | null>(null);
  const threadRef = React.useRef<ChatThread | null>(current?.thread ?? null);
  const tempTouched = React.useRef(false);

  React.useEffect(() => {
    threadRef.current = thread;
  }, [thread]);
  // A thread started in place (the URL is rewritten with replaceState) keeps this component mounted when
  // "New chat" goes back to /chat: the server tree is the same "new" one, so nothing remounts. Reset by hand.
  const openedId = useSearchParams().get("t");
  React.useEffect(() => {
    if (openedId || !threadRef.current) return;
    abort.current?.abort();
    threadRef.current = null;
    requestId.current = null;
    setThread(null);
    setMessages([]);
    setText("");
    setSendError(null);
    setStreaming(false);
    setPrivateOn(privateDefault);
  }, [openedId, privateDefault]);
  React.useEffect(() => () => abort.current?.abort(), []);
  // The sidebar renamed or pinned the open chat: keep the header in step.
  React.useEffect(() => {
    const onUpdated = (e: Event) => {
      const patch = (e as CustomEvent<Partial<ChatThread> & { id: string }>).detail;
      if (patch && patch.id === threadRef.current?.id) {
        const next = { ...threadRef.current!, ...patch };
        threadRef.current = next;
        setThread(next);
      }
    };
    window.addEventListener(THREAD_UPDATED, onUpdated);
    return () => window.removeEventListener(THREAD_UPDATED, onUpdated);
  }, []);
  // Warm the "Why this?" popover chunk once the page is idle, so the first chip click always opens it
  // (until it loads, the chip is a static stand-in).
  React.useEffect(() => {
    const load = () => void import("./WhyPopoverImpl");
    const id = window.requestIdleCallback?.(load, { timeout: 2000 }) ?? window.setTimeout(load, 500);
    return () => (window.cancelIdleCallback ? window.cancelIdleCallback(id) : window.clearTimeout(id));
  }, []);

  // Open at the newest message; while a reply streams, follow it if the reader is near the bottom.
  const lastIdForScroll = messages.at(-1)?.id;
  const lastLen = messages.at(-1)?.content.length ?? 0;
  const nearBottom = () => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 160;
  React.useEffect(() => {
    const toEnd = () => window.scrollTo({ top: document.documentElement.scrollHeight });
    toEnd();
    // Lazy chunks (Markdown, code highlighting) change message heights above the newest one a moment later.
    // Stay at the end until the reader scrolls, so nothing visibly jumps (a layout shift) as they arrive.
    const main = document.getElementById("main");
    if (!main || typeof ResizeObserver === "undefined") return;
    let pinned = true;
    const ro = new ResizeObserver(() => pinned && toEnd());
    ro.observe(main);
    const unpin = () => {
      pinned = false;
    };
    const inputs = ["wheel", "touchstart", "keydown", "pointerdown"] as const;
    inputs.forEach((e) => window.addEventListener(e, unpin, { passive: true, once: true }));
    const stop = window.setTimeout(() => {
      pinned = false;
      ro.disconnect();
    }, 2500);
    return () => {
      ro.disconnect();
      window.clearTimeout(stop);
      inputs.forEach((e) => window.removeEventListener(e, unpin));
    };
  }, [lastIdForScroll]);
  React.useEffect(() => {
    if (streaming && nearBottom()) window.scrollTo({ top: document.documentElement.scrollHeight });
  }, [lastLen, streaming]);

  const patchMsg = React.useCallback((id: number, fn: (m: UiMessage) => UiMessage) => {
    setMessages((ms) => ms.map((m) => (m.id === id ? fn(m) : m)));
  }, []);

  const run = React.useCallback(
    async (body: ChatStreamBody, tempUserId: number | null) => {
      setStreaming(true);
      setSendError(null);
      const ctrl = new AbortController();
      abort.current = ctrl;
      let replyId = -1;
      try {
        const res = await fetch("/api/chat/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        if (!res.ok) {
          // The proxy returns the router's plain sentence (`error`); never show a raw status.
          const j = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new SendError(j?.error ?? tChat("chat.sendFailedGeneric"));
        }
        await readSse(res, (e) => {
          const d = JSON.parse(e.data) as Record<string, unknown>;
          switch (e.event) {
            case "start": {
              replyId = d.message_id as number;
              requestId.current = d.request_id as number;
              const tid = d.thread_id as string;
              const stub: UiMessage = {
                id: replyId,
                role: "assistant",
                content: "",
                status: "streaming",
                private: !!d.private,
                feedback: null,
                route: null,
                created_at: new Date().toISOString(),
                live: newLive(),
              };
              // A pasted secret (M3a): show the stored, masked text instead of what was typed.
              const masked = typeof d.user_text === "string" ? { content: d.user_text, secret: d.secret as UiMessage["secret"] } : {};
              const userId = d.user_message_id as number;
              setMessages((ms) => [
                ...ms.map((m) => (m.id === tempUserId || (tempUserId === null && m.id === userId) ? { ...m, id: userId, ...masked } : m)),
                stub,
              ]);
              if (d.private) setPrivateOn(true);
              const now = new Date().toISOString();
              const known = threadRef.current?.id === tid;
              const th: ChatThread = known
                ? { ...threadRef.current!, private: threadRef.current!.private || !!d.private, updated_at: now }
                : { id: tid, title: String(d.title ?? ""), title_source: "words", private: !!d.private, pinned: false, created_at: now, updated_at: now };
              threadRef.current = th;
              setThread(th);
              if (!known) window.history.replaceState(null, "", `/chat?t=${tid}`);
              notifyThreadsChanged(); // the sidebar's recents pick up the new or touched chat
              break;
            }
            case "route":
              patchMsg(replyId, (m) => ({ ...m, live: { ...(m.live ?? newLive()), label: d.label as string, note: m.live?.note ?? null } }));
              break;
            case "fallback":
              patchMsg(replyId, (m) => ({
                ...m,
                live: { ...newLive(), note: { label: d.label as string, reason: d.reason as string, next: (d.next as string) ?? null } },
              }));
              break;
            case "thinking":
              patchMsg(replyId, (m) => {
                const l = m.live ?? newLive();
                return { ...m, live: { ...l, thinking: l.thinking + (d.text as string), thinkStart: l.thinkStart ?? Date.now() } };
              });
              break;
            case "delta":
              patchMsg(replyId, (m) => {
                const l = m.live ?? newLive();
                return { ...m, content: m.content + (d.text as string), live: { ...l, thinkEnd: l.thinkStart && !l.thinkEnd ? Date.now() : l.thinkEnd } };
              });
              break;
            case "done":
              patchMsg(replyId, (m) => ({
                ...m,
                content: (d.content as string) ?? m.content,
                status: d.status as UiMessage["status"],
                route: (d.route as RouteInfo) ?? null,
                live: m.live ? { ...m.live, thinkEnd: m.live.thinkEnd ?? (m.live.thinkStart ? Date.now() : null) } : undefined,
              }));
              break;
            case "summary": {
              const summary = d.summary as ChatThread["summary"];
              setThread((th) => (th && th.id === d.thread_id ? { ...th, summary } : th));
              const cur = threadRef.current;
              if (cur && cur.id === d.thread_id) threadRef.current = { ...cur, summary };
              break;
            }
            case "title": {
              const title = d.title as string;
              setThread((th) => (th && th.id === d.thread_id ? { ...th, title } : th));
              window.dispatchEvent(new CustomEvent(THREAD_UPDATED, { detail: { id: d.thread_id, title } }));
              break;
            }
          }
        });
      } catch (e) {
        if (ctrl.signal.aborted) {
          patchMsg(replyId, (m) => (m.status === "streaming" ? { ...m, status: "stopped" } : m));
        } else {
          const reason = e instanceof Error ? e.message : String(e);
          if (replyId < 0) setSendError(e instanceof SendError ? e.message : tChat("chat.sendFailedGeneric"));
          else patchMsg(replyId, (m) => ({ ...m, status: "error", route: m.route ?? ({ error: reason } as RouteInfo) }));
        }
      } finally {
        setStreaming(false);
        abort.current = null;
        requestId.current = null;
      }
    },
    [patchMsg],
  );

  const options = React.useCallback(
    (priv: boolean, autonomyLevel: number, temp: number): Omit<ChatStreamBody, "mode"> => ({
      target,
      private: priv,
      autonomy: autonomyLevel,
      temperature: tempTouched.current ? temp : null,
    }),
    [target],
  );

  const send = React.useCallback(
    (msg: ComposerSend) => {
      const tempId = -Date.now();
      setMessages((ms) => [
        ...ms,
        { id: tempId, role: "user", content: msg.text, status: "done", private: msg.private, feedback: null, route: null, created_at: new Date().toISOString() },
      ]);
      setText("");
      void run(
        { mode: "send", thread_id: threadRef.current?.id ?? null, text: msg.text, ...options(msg.private, msg.autonomy, msg.temperature), ...(msg.think ? { think: true } : {}) },
        tempId,
      );
    },
    [run, options],
  );

  // A message handed over from Home (composer or quick-start chip) is sent once, on arrival.
  const sentPending = React.useRef(false);
  React.useEffect(() => {
    if (current) return;
    // Deferred (and guarded inside the timer) so StrictMode's mount/unmount/mount sends it once.
    const timer = setTimeout(() => {
      if (sentPending.current) return;
      let msg: PendingMessage | null = null;
      try {
        const raw = sessionStorage.getItem(PENDING_KEY);
        sessionStorage.removeItem(PENDING_KEY);
        msg = raw ? (JSON.parse(raw) as PendingMessage) : null;
      } catch {
        msg = null;
      }
      if (!msg?.text) return;
      sentPending.current = true;
      setPrivateOn(msg.private);
      setAutonomy(msg.autonomy);
      send({ text: msg.text, private: msg.private, autonomy: msg.autonomy, temperature: msg.temperature, think: msg.think });
    }, 0);
    return () => clearTimeout(timer);
  }, [current, send]);

  const stop = () => {
    const id = requestId.current;
    abort.current?.abort();
    if (id) void stopReply(id);
  };

  // ⌘. / Ctrl+. (lib/shortcuts.ts) stops the reply from anywhere on the page.
  React.useEffect(() => {
    const onStop = () => {
      const id = requestId.current;
      if (!abort.current) return;
      abort.current.abort();
      if (id) void stopReply(id);
    };
    window.addEventListener("sb:stop", onStop);
    return () => window.removeEventListener("sb:stop", onStop);
  }, []);

  const regenerate = () => {
    const th = threadRef.current;
    if (!th) return;
    setMessages((ms) => (ms.at(-1)?.role === "assistant" ? ms.slice(0, -1) : ms));
    void run({ mode: "regenerate", thread_id: th.id, ...options(privateOn, autonomy, temperature) }, null);
  };

  // M3a: the last reply stayed local because it looked sensitive; the person says it isn't.
  const cloudOverride = () => {
    const th = threadRef.current;
    if (!th) return;
    setPrivateOn(false);
    const open = { ...th, private: false, private_source: null };
    threadRef.current = open;
    setThread(open);
    window.dispatchEvent(new CustomEvent(THREAD_UPDATED, { detail: open }));
    setMessages((ms) => (ms.at(-1)?.role === "assistant" ? ms.slice(0, -1) : ms));
    void run({ mode: "regenerate", thread_id: th.id, ...options(false, autonomy, temperature), cloud_override: true }, null);
  };

  const edit = (newText: string) => {
    const th = threadRef.current;
    if (!th) return;
    setMessages((ms) => {
      const i = ms.findLastIndex((m) => m.role === "user");
      return i < 0 ? ms : [...ms.slice(0, i), { ...ms[i], content: newText }];
    });
    void run({ mode: "edit", thread_id: th.id, text: newText, ...options(privateOn, autonomy, temperature) }, null);
  };

  const feedback = async (id: number, value: "up" | "down" | null) => {
    const before = messages.find((m) => m.id === id)?.feedback ?? null;
    patchMsg(id, (m) => ({ ...m, feedback: value }));
    const r = await sendFeedback(id, value);
    if (!r.ok) {
      patchMsg(id, (m) => ({ ...m, feedback: before }));
      push({ tone: "error", title: r.error });
    } else if (value) push({ tone: "success", title: tChat("chat.feedbackSaved") });
  };

  const sentinel = React.useRef<HTMLDivElement>(null);
  const away = useAwayFromLatest(sentinel);
  const toLatest = () =>
    window.scrollTo({
      top: document.documentElement.scrollHeight,
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.dataset.motion === "reduce" ? "auto" : "smooth",
    });

  const lastId = messages.at(-1)?.id;
  const lastUserId = [...messages].reverse().find((m) => m.role === "user")?.id;
  const threadPrivate = thread?.private ?? false;

  return (
    <div className="mx-auto max-w-[88rem]">
      <section aria-labelledby="chat-title" className="mx-auto grid w-full max-w-[760px] min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-4">
        <ThreadHeader
          thread={thread}
          fallback={<StaticHeader title={thread?.title || tChat("chat.title")} privateThread={threadPrivate} />}
          onRenamed={(th) => {
            setThread(th);
            window.dispatchEvent(new CustomEvent(THREAD_UPDATED, { detail: th }));
          }}
        />

        {messages.length === 0 ? (
          <EmptyState title={tChat("chat.emptyTitle")} body={tChat("chat.emptyBody")} icon={<MessageSquare aria-hidden className="size-6" />} />
        ) : (
          <ol className="grid grid-cols-[minmax(0,1fr)] gap-4" aria-label={tChat("chat.title")}>
            {messages.map((m, i) => (
              <React.Fragment key={m.id}>
                {(i === 0 || localDay(messages[i - 1].created_at) !== localDay(m.created_at)) && <DateSeparator iso={m.created_at} />}
                <li className="grid grid-cols-[minmax(0,1fr)]" aria-live={m.status === "streaming" ? "polite" : undefined}>
                  <MessageItem
                    m={m}
                    last={m.id === lastId || (m.role === "user" && m.id === lastUserId)}
                    busy={streaming}
                    actions={{ onRegenerate: regenerate, onEdit: edit, onFeedback: feedback, onCloudOverride: cloudOverride }}
                  />
                </li>
                {thread?.summary && thread.summary.upto_message_id === m.id && (
                  <li className="grid grid-cols-[minmax(0,1fr)]">
                    <SummaryNote s={thread.summary} />
                  </li>
                )}
              </React.Fragment>
            ))}
          </ol>
        )}
        <div ref={sentinel} aria-hidden className="h-px" />

        <div className="chat-composer relative sticky bottom-3 z-10">
          {away && messages.length > 0 && (
            <button
              type="button"
              onClick={toLatest}
              className="surface-strong absolute -top-12 left-1/2 inline-flex min-h-9 -translate-x-1/2 items-center gap-1.5 rounded-chip px-3.5 text-[0.8125rem] font-semibold shadow-[var(--shadow-pop)] animate-[pop_var(--d-base)_var(--ease)] hover:bg-pill-active"
            >
              <ArrowDown aria-hidden className="size-4" /> {tChat("chat.scrollLatest")}
            </button>
          )}
        <Composer
          compact
          phoneReadOnly={t("home.readOnlyNote")}
          state={phone ? "disabled" : sendError ? "error" : "default"}
          disabledReason={t("home.readOnlyNote")}
          errorMessage={sendError ?? undefined}
          value={text}
          onValueChange={setText}
          onSend={send}
          streaming={streaming}
          onStop={stop}
          privateOn={privateOn || threadPrivate}
          onPrivateChange={(on) => !threadPrivate && setPrivateOn(on)}
          autonomy={autonomy}
          onAutonomyChange={setAutonomy}
          temperature={temperature}
          onTemperatureChange={(v) => {
            tempTouched.current = true;
            setTemperature(v);
          }}
          targetSlot={
            <TargetPicker
              value={target}
              onChange={setTarget}
              privateOn={privateOn || threadPrivate}
              disabled={phone}
              targets={targets}
              onTargets={setTargets}
            />
          }
        />
        </div>
        {/* Room the "Why this?" popover can claim below the last reply (WhyPopoverImpl). */}
        <div id="chat-spacer" aria-hidden className="h-0" />
      </section>
    </div>
  );
}

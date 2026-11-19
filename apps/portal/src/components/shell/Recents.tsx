"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Lock, MoreHorizontal, Pencil, Pin, PinOff, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/kit/Toast";
import { deleteThread, pinThread, renameThread } from "@/app/chat/actions";
import { groupThreads } from "@/lib/thread-groups";
import { THREADS_CHANGED, THREAD_UPDATED, notifyThreadsChanged } from "@/lib/thread-events";
import type { ChatThread, ThreadPage } from "@/lib/router-types";
import { cn } from "@/lib/cn";
import { tChat } from "@/i18n/chat";
import { tShell } from "@/i18n/shell";

export interface ThreadActions {
  onRename: (id: string, title: string) => Promise<boolean>;
  onPin: (id: string, pinned: boolean) => void;
  onDelete: (id: string) => void;
}

const title = (th: ChatThread) => th.title || tChat("chat.untitled");
const ROW = "[data-thread-row]";

/** Menu for one row: Rename, Pin/Unpin, Delete. Arrow keys move, Esc closes and returns focus. */
function RowMenu({ th, onClose, onRename, onPin, onDelete, up }: {
  th: ChatThread;
  onClose: (refocus: boolean) => void;
  onRename: () => void;
  onPin: () => void;
  onDelete: () => void;
  up: boolean;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    ref.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    const away = (e: PointerEvent) => !ref.current?.parentElement?.contains(e.target as Node) && onClose(false);
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [onClose]);
  const onKey = (e: React.KeyboardEvent) => {
    const items = [...(ref.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      items[e.key === "Home" ? 0 : items.length - 1]?.focus();
    } else if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      onClose(true);
    }
  };
  const item = "flex min-h-9 w-full items-center gap-2 rounded-control px-2.5 text-left text-sm hover:bg-accent-soft focus-visible:bg-accent-soft";
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={tChat("chat.sidebar.more", { title: title(th) })}
      onKeyDown={onKey}
      className={cn(
        "surface-strong absolute right-1 z-30 grid w-44 gap-0.5 bg-(--surface-solid) p-1 shadow-[var(--shadow-pop)] animate-[pop_var(--d-fast)_var(--ease)]",
        up ? "bottom-full mb-1" : "top-full mt-1",
      )}
    >
      <button type="button" role="menuitem" tabIndex={-1} className={item} onClick={onRename}>
        <Pencil aria-hidden className="size-4" /> {tChat("chat.rename")}
      </button>
      <button type="button" role="menuitem" tabIndex={-1} className={item} onClick={onPin}>
        {th.pinned ? <PinOff aria-hidden className="size-4" /> : <Pin aria-hidden className="size-4" />}
        {th.pinned ? tChat("chat.sidebar.unpin") : tChat("chat.sidebar.pin")}
      </button>
      <button type="button" role="menuitem" tabIndex={-1} className={cn(item, "text-err")} onClick={onDelete}>
        <Trash2 aria-hidden className="size-4" /> {tChat("chat.delete")}
      </button>
    </div>
  );
}

type Mode = { id: string; kind: "menu" | "rename" | "delete"; up?: boolean } | null;

function Row({ th, current, focusable, mode, setMode, actions }: {
  th: ChatThread;
  current: boolean;
  focusable: boolean;
  mode: Mode;
  setMode: (m: Mode) => void;
  actions: ThreadActions;
}) {
  const menuBtn = React.useRef<HTMLButtonElement>(null);
  const [draft, setDraft] = React.useState(th.title);
  const mine = mode?.id === th.id ? mode : null;
  const label = title(th);

  const openMenu = () => {
    const r = menuBtn.current!.getBoundingClientRect();
    const box = menuBtn.current!.closest("[data-thread-scroll]")?.getBoundingClientRect();
    setMode({ id: th.id, kind: "menu", up: !!box && r.bottom + 140 > box.bottom });
  };
  const closeMenu = React.useCallback(
    (refocus: boolean) => {
      setMode(null);
      if (refocus) menuBtn.current?.focus();
    },
    [setMode],
  );

  if (mine?.kind === "rename") {
    return (
      <form
        className="flex items-center gap-1.5 px-1 py-0.5"
        onSubmit={async (e) => {
          e.preventDefault();
          if (draft.trim() && (await actions.onRename(th.id, draft.trim()))) setMode(null);
        }}
      >
        <label htmlFor={`rn-${th.id}`} className="sr-only">
          {tChat("chat.renameLabel")}
        </label>
        <input
          id={`rn-${th.id}`}
          autoFocus
          value={draft}
          maxLength={80}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && (e.preventDefault(), setMode(null))}
          className="min-w-0 flex-1 rounded-control border border-hairline bg-glass-strong px-2 py-1.5 text-sm"
        />
        <Button type="submit" size="sm">{tChat("chat.save")}</Button>
      </form>
    );
  }
  if (mine?.kind === "delete") {
    return (
      <div role="group" aria-label={tChat("chat.sidebar.deleteTitle", { title: label })} className="grid gap-1.5 rounded-control border border-err p-2 text-sm">
        <p className="truncate font-semibold" data-tip-truncated>
          {tChat("chat.sidebar.deleteTitle", { title: label })}
        </p>
        <span className="flex gap-1.5">
          <Button type="button" size="sm" variant="danger" autoFocus onClick={() => (setMode(null), actions.onDelete(th.id))}>
            {tChat("chat.deleteYes")}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setMode(null)}>
            {tChat("chat.cancel")}
          </Button>
        </span>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "group/row relative flex min-h-9 items-center rounded-control",
        current ? "bg-pill-active" : "hover:bg-pill-active",
      )}
    >
      <Link
        href={`/chat?t=${th.id}`}
        data-thread-row
        data-id={th.id}
        tabIndex={focusable ? 0 : -1}
        aria-current={current ? "page" : undefined}
        onKeyDown={(e) => {
          if (e.key === "F2") {
            e.preventDefault();
            setDraft(th.title);
            setMode({ id: th.id, kind: "rename" });
          } else if (e.key === "Delete") {
            e.preventDefault();
            setMode({ id: th.id, kind: "delete" });
          }
        }}
        className={cn("flex min-w-0 flex-1 items-center gap-2 rounded-control py-1.5 pr-9 pl-2.5 text-sm", current && "font-semibold")}
      >
        {th.private && (
          <>
            <Lock aria-hidden className="size-3.5 shrink-0 text-accent-strong" />
            <span className="sr-only">{tChat("chat.privateBadge")}: </span>
          </>
        )}
        <span className="min-w-0 truncate" data-tip-truncated>
          {label}
        </span>
      </Link>
      <button
        ref={menuBtn}
        type="button"
        aria-label={tChat("chat.sidebar.more", { title: label })}
        aria-haspopup="menu"
        aria-expanded={mine?.kind === "menu"}
        tabIndex={focusable ? 0 : -1}
        onClick={() => (mine?.kind === "menu" ? closeMenu(false) : openMenu())}
        className={cn(
          "row-more absolute right-1 grid size-7 place-items-center rounded-full text-ink-muted hover:bg-accent-soft hover:text-ink",
          mine?.kind === "menu" && "is-open",
        )}
      >
        <MoreHorizontal aria-hidden className="size-4" />
      </button>
      {mine?.kind === "menu" && (
        <RowMenu
          th={th}
          up={!!mine.up}
          onClose={closeMenu}
          onRename={() => (setDraft(th.title), setMode({ id: th.id, kind: "rename" }))}
          onPin={() => (setMode(null), actions.onPin(th.id, !th.pinned))}
          onDelete={() => setMode({ id: th.id, kind: "delete" })}
        />
      )}
    </div>
  );
}


const PAGE = 30;
const SEARCH_DELAY_MS = 250;

type Fetched = { ok: true; page: ThreadPage } | { ok: false };

async function fetchPage(params: { limit?: number; cursor?: string | null; q?: string }, signal?: AbortSignal): Promise<Fetched> {
  const qs = new URLSearchParams({ limit: String(params.limit ?? PAGE) });
  if (params.cursor) qs.set("cursor", params.cursor);
  if (params.q) qs.set("q", params.q);
  try {
    const r = await fetch(`/api/threads?${qs}`, { cache: "no-store", signal });
    const j = (await r.json()) as { ok: boolean; data?: ThreadPage };
    return j.ok && j.data ? { ok: true, page: j.data } : { ok: false };
  } catch {
    return { ok: false };
  }
}

/** The sidebar's recent chats (M3b): global, paginated, searchable on the server, grouped Pinned /
 * Today / Yesterday / Previous 7 days / Older. One tab stop with ↑/↓/Home/End; F2 renames, Delete asks
 * to delete. Loads after the page is idle (its own chunk) and refreshes on `sb:threads-changed`. */
export default function Recents({ query }: { query: string }) {
  const router = useRouter();
  const { push } = useToast();
  const current = useSearchParams().get("t");
  const [threads, setThreads] = React.useState<ChatThread[]>([]);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [state, setState] = React.useState<"loading" | "ready" | "failed">("loading");
  const [more, setMore] = React.useState(false);
  const [searching, setSearching] = React.useState("");
  const [mode, setMode] = React.useState<Mode>(null);
  const [focusId, setFocusId] = React.useState<string | null>(null);
  const loaded = React.useRef(0);
  React.useEffect(() => {
    loaded.current = threads.length;
  }, [threads.length]);

  // Debounced server-side search: it covers every chat, not only the ones loaded.
  React.useEffect(() => {
    const id = window.setTimeout(() => setSearching(query.trim()), query.trim() ? SEARCH_DELAY_MS : 0);
    return () => window.clearTimeout(id);
  }, [query]);

  const load = React.useCallback(
    async (signal?: AbortSignal) => {
      const keep = Math.min(100, Math.max(PAGE, loaded.current)); // refresh what is on screen, bounded
      const r = await fetchPage({ limit: searching ? PAGE : keep, q: searching }, signal);
      if (signal?.aborted) return;
      if (!r.ok) return setState("failed");
      setThreads([...r.page.pinned, ...r.page.threads]);
      setCursor(r.page.next_cursor);
      setState("ready");
    },
    [searching],
  );

  React.useEffect(() => {
    const ctl = new AbortController();
    void load(ctl.signal);
    return () => ctl.abort();
  }, [load]);

  React.useEffect(() => {
    const refresh = () => void load();
    const patch = (e: Event) => {
      const th = (e as CustomEvent<ChatThread>).detail;
      if (th) setThreads((list) => list.map((x) => (x.id === th.id ? { ...x, ...th } : x)));
    };
    window.addEventListener(THREADS_CHANGED, refresh);
    window.addEventListener(THREAD_UPDATED, patch);
    return () => {
      window.removeEventListener(THREADS_CHANGED, refresh);
      window.removeEventListener(THREAD_UPDATED, patch);
    };
  }, [load]);

  const showMore = async () => {
    if (!cursor || more) return;
    setMore(true);
    const r = await fetchPage({ cursor, q: searching });
    setMore(false);
    if (!r.ok) return push({ tone: "error", title: tShell("sidebar.failed") });
    setThreads((list) => [...list, ...r.page.threads.filter((n) => !list.some((x) => x.id === n.id))]);
    setCursor(r.page.next_cursor);
  };

  const actions: ThreadActions = {
    onRename: async (id, name) => {
      const r = await renameThread(id, name);
      if (!r.ok) {
        push({ tone: "error", title: r.error });
        return false;
      }
      setThreads((list) => list.map((x) => (x.id === id ? r.data : x)));
      window.dispatchEvent(new CustomEvent(THREAD_UPDATED, { detail: r.data }));
      return true;
    },
    onPin: async (id, pinned) => {
      setThreads((list) => list.map((x) => (x.id === id ? { ...x, pinned } : x)));
      const r = await pinThread(id, pinned);
      if (!r.ok) push({ tone: "error", title: r.error });
      void load();
    },
    onDelete: async (id) => {
      setThreads((list) => list.filter((x) => x.id !== id));
      const r = await deleteThread(id);
      if (!r.ok) {
        push({ tone: "error", title: r.error });
        void load();
        return;
      }
      push({ tone: "success", title: tChat("chat.deleted") });
      if (id === current) router.push("/chat");
      notifyThreadsChanged();
    },
  };

  const groups = groupThreads(threads);
  const ordered = groups.flatMap((g) => g.threads);
  const tabId = ordered.find((t) => t.id === focusId)?.id ?? ordered.find((t) => t.id === current)?.id ?? ordered[0]?.id;

  const onListKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    if (!(e.target as HTMLElement).matches(ROW)) return;
    const rows = [...e.currentTarget.querySelectorAll<HTMLElement>(ROW)];
    const i = rows.indexOf(e.target as HTMLElement);
    const next =
      e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : Math.min(rows.length - 1, Math.max(0, i + (e.key === "ArrowDown" ? 1 : -1)));
    e.preventDefault();
    rows[next]?.focus();
    setFocusId(rows[next]?.dataset.id ?? null);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {state === "loading" ? (
        <div aria-hidden className="grid gap-1.5 px-1">
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className="shimmer h-8 rounded-control" />
          ))}
        </div>
      ) : state === "failed" ? (
        <div role="status" className="grid gap-1.5 px-1 text-sm text-ink-muted">
          <p>{tShell("sidebar.failed")}</p>
          <Button type="button" size="sm" variant="glass" onClick={() => void load()}>
            {tShell("sidebar.retry")}
          </Button>
        </div>
      ) : groups.length === 0 ? (
        <p role="status" className="px-1 text-sm text-ink-muted">
          {searching ? tChat("chat.sidebar.noMatch", { query: searching }) : tChat("chat.noThreads")}
        </p>
      ) : (
        <div data-thread-scroll onKeyDown={onListKey} className="recents-scroll -mx-1 min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-1 pb-1">
          {groups.map((g) => (
            <section key={g.id} aria-labelledby={`tg-${g.id}`} className="grid grid-cols-[minmax(0,1fr)] gap-0.5 pb-3 last:pb-0">
              <h3 id={`tg-${g.id}`} className="label px-2.5 pt-1 pb-1 text-[0.625rem]">
                {tChat(`chat.sidebar.groups.${g.id}`)}
              </h3>
              <ul className="grid grid-cols-[minmax(0,1fr)] gap-0.5">
                {g.threads.map((th) => (
                  <li key={th.id}>
                    <Row th={th} current={th.id === current} focusable={th.id === tabId} mode={mode} setMode={setMode} actions={actions} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {cursor && (
            <Button type="button" size="sm" variant="ghost" onClick={showMore} disabled={more} className="mt-1 w-full">
              {more ? tShell("sidebar.loading") : tShell("sidebar.showMore")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

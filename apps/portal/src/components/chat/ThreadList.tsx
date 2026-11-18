"use client";

import * as React from "react";
import Link from "next/link";
import { Lock, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Pin, PinOff, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getPrefs, setPrefs } from "@/lib/prefs";
import { filterThreads, groupThreads } from "@/lib/thread-groups";
import type { ChatThread } from "@/lib/router-types";
import { cn } from "@/lib/cn";
import { tChat } from "@/i18n/chat";

export interface ThreadActions {
  onNew: () => void;
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

/**
 * Thread sidebar (M1.5): search, Pinned / Today / Yesterday / Previous 7 days / Older, a row menu
 * (rename, pin, delete), private lock badge, single-line ellipsis with the full title on hover,
 * one tab stop with ↑/↓/Home/End (F2 renames, Delete asks to delete). Collapses to a rail with
 * mod+B (html[data-sidebar], set before paint); on phones it folds behind a "Chats" button.
 */
export function ThreadList({ threads, current, actions }: { threads: ChatThread[]; current: string | null; actions: ThreadActions }) {
  const [query, setQuery] = React.useState("");
  const [mode, setMode] = React.useState<Mode>(null);
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const [focusId, setFocusId] = React.useState<string | null>(null);
  const visible = filterThreads(threads, query);
  const groups = groupThreads(visible);
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

  const toggle = () => setPrefs({ sidebarCollapsed: !getPrefs().sidebarCollapsed });

  return (
    <nav aria-label={tChat("chat.threads")} className="chat-sidebar">
      {/* Collapsed rail (desktop, mod+B). */}
      <div className="sidebar-rail surface-strong flex-col items-center gap-2 rounded-panel p-2">
        <Button type="button" size="icon" variant="ghost" onClick={toggle} aria-label={tChat("chat.sidebar.expand")} data-tip={tChat("chat.sidebar.expand")} aria-keyshortcuts="Control+B Meta+B">
          <PanelLeftOpen aria-hidden className="size-4" />
        </Button>
        <Link
          href="/chat"
          onClick={actions.onNew}
          aria-label={tChat("chat.newChat")}
          data-tip={tChat("chat.newChat")}
          className="grid size-(--ctl) place-items-center rounded-full bg-accent text-on-accent"
        >
          <Plus aria-hidden className="size-4" />
        </Link>
      </div>

      <div className="sidebar-full surface-strong min-h-0 flex-col gap-3 rounded-panel p-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="label pl-1">{tChat("chat.threads")}</h2>
          <span className="flex items-center gap-1">
            <Link
              href="/chat"
              onClick={actions.onNew}
              className="inline-flex min-h-8 items-center gap-1.5 rounded-chip bg-accent px-3 text-[0.8125rem] font-semibold text-on-accent"
            >
              <Plus aria-hidden className="size-3.5" /> {tChat("chat.newChat")}
            </Link>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              onClick={toggle}
              aria-label={tChat("chat.sidebar.collapse")}
              data-tip={tChat("chat.sidebar.collapse")}
              aria-keyshortcuts="Control+B Meta+B"
              className="max-lg:hidden size-8 min-h-8"
            >
              <PanelLeftClose aria-hidden className="size-4" />
            </Button>
            <Button
              type="button"
              size="sm"
              variant="glass"
              aria-expanded={mobileOpen}
              aria-controls="thread-list-body"
              onClick={() => setMobileOpen(!mobileOpen)}
              className="lg:hidden"
            >
              {mobileOpen ? tChat("chat.sidebar.hideList") : tChat("chat.sidebar.showList", { count: threads.length })}
            </Button>
          </span>
        </div>

        <div id="thread-list-body" data-open={mobileOpen || undefined} className="sidebar-body min-h-0 flex-col gap-3">
          {threads.length > 0 && (
            <label className="relative block">
              <span className="sr-only">{tChat("chat.sidebar.search")}</span>
              <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-ink-muted" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={tChat("chat.sidebar.search")}
                className="w-full rounded-control border border-hairline bg-glass-strong py-2 pr-2 pl-8 text-sm placeholder:text-ink-muted"
              />
            </label>
          )}
          {threads.length === 0 ? (
            <p className="px-1 text-sm text-ink-muted">{tChat("chat.noThreads")}</p>
          ) : groups.length === 0 ? (
            <p role="status" className="px-1 text-sm text-ink-muted">
              {tChat("chat.sidebar.noMatch", { query })}
            </p>
          ) : (
            <div data-thread-scroll onKeyDown={onListKey} className="-mx-1 min-h-0 overflow-x-hidden overflow-y-auto px-1 pb-1">
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
            </div>
          )}
        </div>
      </div>
    </nav>
  );
}

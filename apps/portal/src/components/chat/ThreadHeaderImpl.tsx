"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Pencil, Trash2 } from "lucide-react";
import { useToast } from "@/components/kit/Toast";
import { Button } from "@/components/ui/button";
import { deleteThread, renameThread } from "@/app/chat/actions";
import type { ChatThread } from "@/lib/router-types";
import { tChat } from "@/i18n/chat";
import { StaticHeader } from "./ThreadHeader";

/** Thread title with rename and delete (inline confirm). Lazy chunk. */
export default function ThreadHeaderImpl({ thread, onRenamed }: { thread: ChatThread; onRenamed: (t: ChatThread) => void }) {
  const router = useRouter();
  const { push } = useToast();
  const [renaming, setRenaming] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);

  const onRename = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const title = String(new FormData(e.currentTarget).get("title") ?? "").trim();
    if (!title) return;
    const r = await renameThread(thread.id, title);
    if (!r.ok) return push({ tone: "error", title: r.error });
    onRenamed(r.data);
    setRenaming(false);
  };

  const onDelete = async () => {
    const r = await deleteThread(thread.id);
    if (!r.ok) return push({ tone: "error", title: r.error });
    push({ tone: "success", title: tChat("chat.deleted") });
    router.push("/chat");
    router.refresh();
  };

  if (renaming) {
    return (
      <header className="flex min-h-10 flex-wrap items-center gap-3">
        <form onSubmit={onRename} className="flex flex-1 flex-wrap items-center gap-2">
          <label htmlFor="chat-rename" className="sr-only">
            {tChat("chat.renameLabel")}
          </label>
          <input
            id="chat-rename"
            name="title"
            defaultValue={thread.title}
            maxLength={80}
            autoFocus
            className="surface-strong min-h-9 flex-1 rounded-control px-3 text-lg font-semibold"
          />
          <Button type="submit" size="sm">
            {tChat("chat.save")}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setRenaming(false)}>
            {tChat("chat.cancel")}
          </Button>
        </form>
      </header>
    );
  }

  return (
    <StaticHeader title={thread.title || tChat("chat.title")} privateThread={thread.private}>
      <span className="flex items-center gap-1">
        <Button type="button" size="icon" variant="ghost" aria-label={tChat("chat.rename")} data-tip={tChat("chat.rename")} onClick={() => setRenaming(true)}>
          <Pencil aria-hidden className="size-4" />
        </Button>
        {confirmDelete ? (
          <span className="flex items-center gap-1.5 text-sm" role="group" aria-label={tChat("chat.deleteConfirm")}>
            {tChat("chat.deleteConfirm")}
            <Button type="button" size="sm" variant="danger" onClick={onDelete}>
              {tChat("chat.deleteYes")}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
              {tChat("chat.cancel")}
            </Button>
          </span>
        ) : (
          <Button type="button" size="icon" variant="ghost" aria-label={tChat("chat.delete")} data-tip={tChat("chat.delete")} onClick={() => setConfirmDelete(true)}>
            <Trash2 aria-hidden className="size-4" />
          </Button>
        )}
      </span>
    </StaticHeader>
  );
}

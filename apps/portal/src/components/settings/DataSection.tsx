"use client";

import * as React from "react";
import { Download, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/kit/Toast";
import { clearChats } from "@/app/settings/actions";
import { tSet } from "@/i18n/settings";
import { Section } from "./Section";

const link =
  "inline-flex min-h-8 items-center gap-2 rounded-chip border border-hairline bg-glass-strong px-3.5 text-[0.8125rem] font-semibold hover:bg-pill-active";

export default function DataSection() {
  const { push } = useToast();
  const [priv, setPriv] = React.useState(false);
  const [files, setFiles] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const [word, setWord] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const q = (priv ? "&private=1" : "") + (files ? "&files=1" : "");
  const ok = word.trim().toLowerCase() === tSet("data.confirmWord");
  return (
    <Section id="data" title={tSet("section.data")} explain={tSet("data.explain")}>
      <div className="grid gap-3">
        <h3 className="text-sm font-semibold">{tSet("data.exportTitle")}</h3>
        <p className="text-sm text-ink-muted">{tSet("data.exportLead")}</p>
        <div className="flex flex-wrap items-center gap-2">
          <a href={`/api/export?format=json${q}`} download className={link}>
            <Download aria-hidden className="size-4" /> {tSet("data.json")}
          </a>
          <a href={`/api/export?format=md${q}`} download className={link}>
            <Download aria-hidden className="size-4" /> {tSet("data.md")}
          </a>
          <span className="flex items-center gap-2 pl-1 text-sm">
            <Switch checked={priv} onCheckedChange={setPriv} aria-labelledby="exp-priv" />
            <span id="exp-priv">{tSet("data.includePrivate")}</span>
          </span>
          <span className="flex items-center gap-2 pl-1 text-sm">
            <Switch checked={files} onCheckedChange={setFiles} aria-labelledby="exp-files" aria-describedby="exp-files-note" />
            <span id="exp-files">{tSet("data.includeFiles")}</span>
          </span>
        </div>
        <p id="exp-files-note" className="text-xs text-ink-muted">
          {tSet("data.filesNote")}
        </p>
      </div>
      <div className="grid gap-3 border-t border-hairline pt-4">
        <h3 className="text-sm font-semibold">{tSet("data.clearTitle")}</h3>
        <p className="text-sm text-ink-muted">{tSet("data.clearLead")}</p>
        <div>
          <Button size="sm" variant="danger" onClick={() => (setWord(""), setError(null), setOpen(true))}>
            <Trash2 aria-hidden className="size-4" /> {tSet("data.clear")}
          </Button>
        </div>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="w-[min(94vw,28rem)]">
          <DialogTitle className="font-display text-xl font-bold tracking-tight">{tSet("data.confirmTitle")}</DialogTitle>
          <DialogDescription className="text-sm text-ink-muted">{tSet("data.confirmBody")}</DialogDescription>
          <form
            className="grid gap-3"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!ok) return;
              setBusy(true);
              const r = await clearChats(word);
              setBusy(false);
              if (!r.ok) return setError(r.error);
              setOpen(false);
              push({ tone: "success", title: tSet("data.cleared") });
            }}
          >
            <label htmlFor="clear-word" className="text-sm font-semibold">
              {tSet("data.confirmLabel")}
            </label>
            <input
              id="clear-word"
              autoComplete="off"
              value={word}
              onChange={(e) => setWord(e.target.value)}
              className="min-h-(--ctl) rounded-control border border-hairline bg-glass-strong px-3"
            />
            {error && (
              <p role="alert" className="text-sm text-err">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
                {tSet("cancel")}
              </Button>
              <Button type="submit" size="sm" variant="danger" disabled={!ok} loading={busy}>
                {tSet("data.confirmYes")}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </Section>
  );
}

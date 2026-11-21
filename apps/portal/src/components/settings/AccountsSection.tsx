"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/kit/CopyButton";
import { StatusBadge } from "@/components/kit/StatusBadge";
import { useToast } from "@/components/kit/Toast";
import { addAccount, checkAccount, removeAccount } from "@/app/settings/actions";
import type { AccountRow, AccountsResponse } from "@/lib/router-types";
import { tSubs } from "@/i18n/subscriptions";
import { Section } from "./Section";

const NAME = /^[a-z0-9][a-z0-9-]{0,30}$/;
const input = "min-h-(--ctl) w-full rounded-control border border-hairline bg-glass-strong px-3";

function AccountItem({ cli, a }: { cli: string; a: AccountRow }) {
  const router = useRouter();
  const { push } = useToast();
  const ids = React.useId();
  const [busy, setBusy] = React.useState<null | "check" | "remove">(null);
  const [confirm, setConfirm] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const run = async (what: "check" | "remove") => {
    setBusy(what);
    setError(null);
    const r = what === "check" ? await checkAccount(cli, a.name) : await removeAccount(cli, a.name);
    setBusy(null);
    setConfirm(false);
    if (!r.ok) return setError(r.error);
    if (what === "remove") push({ tone: "success", title: tSubs("accounts.removed", { name: a.name }) });
    router.refresh();
  };
  const isDefault = a.name === "default";
  return (
    <li className="grid gap-2 rounded-control border border-hairline p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 font-semibold">
          {isDefault ? tSubs("accounts.defaultName") : a.name}
          {a.label ? <span className="font-normal text-ink-muted">{` · ${a.label}`}</span> : null}
          {a.plan_label ? <span className="font-normal text-ink-muted">{` · ${a.plan_label}`}</span> : null}
        </p>
        <StatusBadge
          status={a.logged_in ? "healthy" : a.logged_in === false ? "warning" : "offline"}
          label={a.logged_in ? tSubs("accounts.loggedIn") : a.logged_in === false ? tSubs("accounts.loggedOut") : tSubs("accounts.unknown")}
        />
      </div>
      {a.home && <p className="font-mono text-[0.8125rem] break-all text-ink-muted">{a.home}</p>}
      {a.logged_in === false && a.login_command && (
        <div className="grid gap-1">
          <p className="text-sm">{tSubs("accounts.loginNext")}</p>
          <code className="solid-panel block p-2 font-mono text-[0.75rem] whitespace-pre-wrap [overflow-wrap:anywhere]">{a.login_command}</code>
          <CopyButton text={a.login_command} className="w-fit" />
        </div>
      )}
      {confirm ? (
        <div role="alertdialog" aria-labelledby={`${ids}-c`} className="grid gap-2 text-sm">
          <p id={`${ids}-c`}>{tSubs("accounts.removeConfirm", { name: a.name })}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="danger" loading={busy === "remove"} onClick={() => run("remove")}>
              {tSubs("accounts.remove")}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setConfirm(false)}>
              {tSubs("accounts.keep")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="glass" loading={busy === "check"} onClick={() => run("check")}>
            <RefreshCw aria-hidden className="size-4" /> {tSubs("accounts.check")}
          </Button>
          {!isDefault && (
            <Button type="button" size="sm" variant="ghost" onClick={() => setConfirm(true)}>
              <Trash2 aria-hidden className="size-4" /> {tSubs("accounts.remove")}
            </Button>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-err">
          {error}
        </p>
      )}
    </li>
  );
}

/** Settings → Accounts (M6.5, ADR 0013): named accounts per subscription CLI, never rotated. */
export default function AccountsSection({ data }: { data: AccountsResponse }) {
  const router = useRouter();
  const { push } = useToast();
  const ids = React.useId();
  const [cli, setCli] = React.useState(data.clis[0]?.cli ?? "");
  const [name, setName] = React.useState("");
  const [label, setLabel] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [added, setAdded] = React.useState<{ name: string; command: string | null } | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!NAME.test(name)) return setError(tSubs("accounts.nameHelp"));
    setBusy(true);
    setError(null);
    const r = await addAccount(cli, name, label);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setAdded({ name, command: r.data.login_command });
    setName("");
    setLabel("");
    push({ tone: "success", title: tSubs("accounts.added", { name }) });
    router.refresh();
  };

  return (
    <Section id="accounts" title={tSubs("accounts.title")} explain={tSubs("accounts.never")}>
      <p className="text-sm text-ink-muted">{tSubs("accounts.intro")}</p>
      <p className="text-sm font-semibold">{tSubs("accounts.never")}</p>
      {data.clis.map((c) => (
        <section key={c.cli} aria-labelledby={`${ids}-${c.cli}`} className="grid gap-2">
          <h3 id={`${ids}-${c.cli}`} className="font-display text-lg font-bold tracking-tight">
            {c.label}
          </h3>
          <ul className="grid gap-2">
            {c.accounts.map((a) => (
              <AccountItem key={a.name} cli={c.cli} a={a} />
            ))}
          </ul>
        </section>
      ))}
      <form onSubmit={submit} noValidate className="grid items-end gap-2 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,1.2fr)_auto]">
        <label className="grid gap-1 text-sm font-semibold">
          {tSubs("accounts.cli")}
          <select className={input} value={cli} onChange={(e) => setCli(e.target.value)}>
            {data.clis.map((c) => (
              <option key={c.cli} value={c.cli}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm font-semibold">
          {tSubs("accounts.name")}
          <input className={input} value={name} maxLength={31} onChange={(e) => setName(e.target.value.toLowerCase())} placeholder="work" aria-describedby={`${ids}-nh`} />
        </label>
        <label className="grid gap-1 text-sm font-semibold">
          {tSubs("accounts.labelField")}
          <input className={input} value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} placeholder="Company Team seat" />
        </label>
        <Button type="submit" size="sm" loading={busy} disabled={!name}>
          <Plus aria-hidden className="size-4" /> {tSubs("accounts.add")}
        </Button>
      </form>
      <p id={`${ids}-nh`} className="text-[0.8125rem] text-ink-muted">
        {tSubs("accounts.nameHelp")}
      </p>
      {added?.command && (
        <div role="status" className="grid gap-1 rounded-control border border-hairline p-3 text-sm">
          <p>{tSubs("accounts.loginNext")}</p>
          <code className="solid-panel block p-2 font-mono text-[0.75rem] whitespace-pre-wrap [overflow-wrap:anywhere]">{added.command}</code>
          <CopyButton text={added.command} className="w-fit" />
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-err">
          {error}
        </p>
      )}
    </Section>
  );
}

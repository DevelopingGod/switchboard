"use client";

import * as React from "react";
import Link from "next/link";
import { ImagePlus, PenLine, Search, Sparkles, Wrench, type LucideIcon } from "lucide-react";
import { Composer } from "@/components/kit/Composer";
import { useToast } from "@/components/kit/Toast";
import { usePrefs } from "@/lib/prefs";
import { useMedia } from "@/lib/use-media";
import { t, type StringKey } from "@/i18n/strings";

const chips: { id: "linkedin" | "tests" | "image" | "research"; icon: LucideIcon }[] = [
  { id: "linkedin", icon: PenLine },
  { id: "tests", icon: Wrench },
  { id: "image", icon: ImagePlus },
  { id: "research", icon: Search },
];

export function HomeHero({ setupPending = false, serverName = "" }: { setupPending?: boolean; serverName?: string }) {
  const { name } = usePrefs();
  const phone = useMedia("(max-width: 639px)");
  const { push } = useToast();
  const [text, setText] = React.useState("");
  const input = React.useRef<HTMLTextAreaElement>(null);

  // Chips only fill the composer for now; they route to a model or agent in M2.
  const fill = (prompt: string) => {
    setText(prompt);
    const el = input.current;
    if (el) {
      el.focus();
      requestAnimationFrame(() => el.setSelectionRange(prompt.length, prompt.length));
    }
  };

  return (
    <div className="mx-auto grid max-w-4xl gap-10 pt-[6vh]">
      <h1 className="display">
        {t("home.greeting", { name: name || serverName || t("home.fallbackName") })}
        <br />
        <span className="text-ink-muted">{t("home.question")}</span>
      </h1>
      <div className="grid gap-4">
        <Composer
          state={phone ? "disabled" : "default"}
          disabledReason={t("home.readOnlyNote")}
          value={text}
          onValueChange={setText}
          inputRef={input}
          onSend={() => push({ tone: "info", title: t("composer.sending") })}
        />
        <ul aria-label={t("home.chips.label")} className="flex flex-wrap gap-2.5">
          {chips.map(({ id, icon: Icon }) => (
            <li key={id}>
              <button
                type="button"
                disabled={phone}
                onClick={() => fill(t(`home.chips.${id}.prompt` as StringKey))}
                className="glass inline-flex min-h-10 items-center gap-2 rounded-chip! px-4 text-sm font-semibold text-ink transition-transform duration-(--d-fast) hover:bg-pill-active active:scale-[0.97] disabled:pointer-events-none disabled:opacity-60"
              >
                <Icon aria-hidden className="size-4 text-accent-strong" />
                {t(`home.chips.${id}.label` as StringKey)}
              </button>
            </li>
          ))}
          {setupPending && (
            <li>
              <Link
                href="/welcome"
                className="inline-flex min-h-10 items-center gap-2 rounded-chip bg-accent px-4 text-sm font-semibold text-on-accent"
              >
                <Sparkles aria-hidden className="size-4" />
                {t("home.finishSetup")}
              </Link>
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}

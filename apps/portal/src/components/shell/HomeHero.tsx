"use client";

import * as React from "react";
import Link from "next/link";
import { ImagePlus, PenLine, Search, Sparkles, Wrench, type LucideIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { Composer } from "@/components/kit/Composer";
import { useToast } from "@/components/kit/Toast";
import { handOff, type PendingMessage } from "@/lib/pending";
import { usePrefs } from "@/lib/prefs";
import { useMedia } from "@/lib/use-media";
import { t, type StringKey } from "@/i18n/strings";

type ChipId = "linkedin" | "tests" | "image" | "research";
const chips: { id: ChipId; icon: LucideIcon }[] = [
  { id: "linkedin", icon: PenLine },
  { id: "tests", icon: Wrench },
  { id: "image", icon: ImagePlus },
  { id: "research", icon: Search },
];

export function HomeHero({ setupPending = false, serverName = "" }: { setupPending?: boolean; serverName?: string }) {
  const { name } = usePrefs();
  const phone = useMedia("(max-width: 639px)");
  const { push } = useToast();
  const router = useRouter();
  const [text, setText] = React.useState("");

  // Home hands the message to /chat, which sends it on arrival (routing, chip and cost show there).
  const go = (msg: PendingMessage) => {
    if (!handOff(msg)) return push({ tone: "error", title: t("composer.errorDefault") });
    router.push("/chat");
  };
  const chip = (id: ChipId) => go({ text: t(`home.chips.${id}.prompt` as StringKey), private: false, autonomy: 1, temperature: 0.7 });

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
          onSend={(m) => go(m)}
        />
        <ul aria-label={t("home.chips.label")} className="flex flex-wrap gap-2.5">
          {chips.map(({ id, icon: Icon }) => (
            <li key={id}>
              <button
                type="button"
                disabled={phone}
                onClick={() => chip(id)}
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

"use client";

import * as React from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { ImagePlus, PenLine, Search, Sparkles, Wrench, type LucideIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { Composer } from "@/components/kit/Composer";
import { useToast } from "@/components/kit/Toast";
import { handOff, type PendingMessage } from "@/lib/pending";
import { usePrefs } from "@/lib/prefs";
import { useMedia } from "@/lib/use-media";
import { t, type StringKey } from "@/i18n/strings";
import type { AttachmentInfo } from "@/lib/router-types";

// M2.5: attachment code loads only once a file is added on Home.
const HomeAttachments = dynamic(() => import("./HomeAttachments").then((m) => m.HomeAttachments), { ssr: false });

type ChipId = "linkedin" | "tests" | "image" | "research";
const chips: { id: ChipId; icon: LucideIcon }[] = [
  { id: "linkedin", icon: PenLine },
  { id: "tests", icon: Wrench },
  { id: "image", icon: ImagePlus },
  { id: "research", icon: Search },
];

export function HomeHero({
  setupPending = false,
  serverName = "",
  privateDefault = false,
}: {
  setupPending?: boolean;
  serverName?: string;
  /** Settings → Privacy → Private by default (M1.5); the composer starts with it, as on /chat. */
  privateDefault?: boolean;
}) {
  const { name } = usePrefs();
  const [priv, setPriv] = React.useState(privateDefault);
  const phone = useMedia("(max-width: 639px)");
  const { push } = useToast();
  const router = useRouter();
  const [text, setText] = React.useState("");
  const [queued, setQueued] = React.useState<File[]>([]);
  const [files, setFiles] = React.useState<{ ready: AttachmentInfo[]; uploading: boolean }>({ ready: [], uploading: false });
  const [attaching, setAttaching] = React.useState(false);
  const taken = React.useCallback(() => setQueued([]), []);

  // Home hands the message to /chat, which sends it on arrival (routing, chip and cost show there).
  const go = (msg: PendingMessage) => {
    if (!handOff(msg)) return push({ tone: "error", title: t("composer.errorDefault") });
    router.push("/chat");
  };
  const chip = (id: ChipId) => go({ text: t(`home.chips.${id}.prompt` as StringKey), private: priv, autonomy: 1, temperature: 0.7 });

  return (
    <div className="mx-auto grid max-w-4xl gap-10 pt-[6vh]">
      <h1 className="display">
        {t("home.greeting", { name: name || serverName || t("home.fallbackName") })}
        <br />
        <span className="text-ink-muted">{t("home.question")}</span>
      </h1>
      <div className="grid gap-4">
        <Composer
          phoneReadOnly={t("home.readOnlyNote")}
          state={phone ? "disabled" : "default"}
          disabledReason={t("home.readOnlyNote")}
          value={text}
          onValueChange={setText}
          privateOn={priv}
          onPrivateChange={setPriv}
          onSend={(m) => go({ ...m, attachments: files.ready })}
          onFiles={phone ? undefined : (f) => (setAttaching(true), setQueued((q) => [...q, ...f]))}
          attachSlot={attaching ? <HomeAttachments queued={queued} onTaken={taken} onState={setFiles} /> : null}
          hasFiles={files.ready.length > 0}
          filesBusy={files.uploading}
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

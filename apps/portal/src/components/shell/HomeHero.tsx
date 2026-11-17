"use client";

import { Composer } from "@/components/kit/Composer";
import { useToast } from "@/components/kit/Toast";
import { usePrefs } from "@/lib/prefs";
import { useMedia } from "@/lib/use-media";
import { t } from "@/i18n/strings";

export function HomeHero() {
  const { name } = usePrefs();
  const phone = useMedia("(max-width: 639px)");
  const { push } = useToast();
  return (
    <div className="mx-auto grid max-w-4xl gap-10 pt-[6vh]">
      <h1 className="display">
        {t("home.greeting", { name: name || t("home.fallbackName") })}
        <br />
        <span className="text-ink-muted">{t("home.question")}</span>
      </h1>
      <Composer
        state={phone ? "disabled" : "default"}
        disabledReason={t("home.readOnlyNote")}
        onSend={() => push({ tone: "info", title: t("composer.sending") })}
      />
    </div>
  );
}

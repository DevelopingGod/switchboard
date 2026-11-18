import type { Metadata } from "next";
import { ChatScreen } from "@/components/chat/ChatScreen";
import Link from "next/link";
import { PlugZap } from "lucide-react";
import { EmptyState } from "@/components/kit/EmptyState";
import { GlassPanel } from "@/components/kit/GlassPanel";
import { loadChat } from "@/lib/server/data";
import { t } from "@/i18n/strings";
import { tChat } from "@/i18n/chat";

export const metadata: Metadata = { title: t("screens.chat.title") };

export default async function Page({ searchParams }: { searchParams: Promise<{ t?: string }> }) {
  const { t: id } = await searchParams;
  const r = await loadChat(id);
  if (!r.ok) {
    return (
      <div className="mx-auto grid max-w-3xl gap-6">
        <h1 className="display">{tChat("chat.title")}</h1>
        <GlassPanel as="section" tone="strong">
          <EmptyState
            state="error"
            title={t("connections.routerDown")}
            body={`${r.error} ${t("connections.routerDownHint")}`}
            icon={<PlugZap aria-hidden className="size-6" />}
            action={
              <Link href="/chat" className="font-semibold text-accent-strong underline underline-offset-4">
                {t("connections.refresh")}
              </Link>
            }
          />
        </GlassPanel>
      </div>
    );
  }
  // Keyed by thread so switching chats starts fresh (and aborts a stream in flight).
  return <ChatScreen key={r.data.current?.thread.id ?? "new"} threads={r.data.threads} current={r.data.current} privateDefault={r.data.privateDefault} />;
}

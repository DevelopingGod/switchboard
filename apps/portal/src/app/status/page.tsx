import type { Metadata } from "next";
import { StatusScreen } from "@/components/status/StatusScreen";
import { loadComponents } from "@/lib/server/data";
import { tStatus } from "@/i18n/status";

export const metadata: Metadata = { title: tStatus("title") };

export default async function Page() {
  const data = await loadComponents();
  return (
    <div className="mx-auto grid max-w-[60rem] gap-8">
      <header className="grid gap-3">
        <h1 className="display">{tStatus("title")}</h1>
        <p className="max-w-2xl text-lg text-ink-muted">{tStatus("intro")}</p>
      </header>
      <StatusScreen data={data} />
    </div>
  );
}

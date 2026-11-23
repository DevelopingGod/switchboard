import { loadConnections } from "@/lib/server/data";
import { ProviderCard } from "@/components/kit/ProviderCard";
import { GlassPanel } from "@/components/kit/GlassPanel";
import { t, type StringKey } from "@/i18n/strings";
import { ProviderCardFor } from "./ProviderCards";
import { RouterDown } from "./RouterDown";
import { PacksSection } from "@/components/packs/PacksSection";

function Section({ id, title, hint, children, notice }: { id: string; title: StringKey; hint: StringKey; children: React.ReactNode; notice?: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="grid gap-4">
      <div className="grid gap-1">
        <h2 id={id} className="heading text-2xl!">
          {t(title)}
        </h2>
        <p className="max-w-2xl text-ink-muted">{t(hint)}</p>
        {notice}
      </div>
      <div className="grid gap-(--gap) grid-cols-[repeat(auto-fill,minmax(min(100%,19rem),1fr))]">{children}</div>
    </section>
  );
}

/** Real data from /connections and /catalog. Renders inside <Suspense> on the page. */
export async function ConnectionsScreen() {
  const res = await loadConnections();
  if (!res.ok) return <RouterDown error={res.error} />;
  const { rows, modelsByProvider, hostprobe } = res.data;
  const of = (kind: string) => rows.filter((r) => r.kind === kind);
  const card = (r: (typeof rows)[number]) => <ProviderCardFor key={r.provider} row={r} models={modelsByProvider[r.provider] ?? []} />;

  return (
    <div className="grid gap-12">
      <Section id="sec-api" title="connections.sectionApi" hint="connections.sectionApiHint">
        {of("api_key").map(card)}
      </Section>
      <Section
        id="sec-cli"
        title="connections.sectionCli"
        hint="connections.sectionCliHint"
        notice={
          hostprobe === "down" ? (
            <GlassPanel tone="strong" role="note" className="mt-2 max-w-2xl text-sm">
              {t("connections.hostprobeDown")}
            </GlassPanel>
          ) : null
        }
      >
        {of("cli").map(card)}
      </Section>
      <Section id="sec-local" title="connections.sectionLocal" hint="connections.sectionLocalHint">
        {of("local").map(card)}
      </Section>
      <PacksSection />
    </div>
  );
}

export function ConnectionsFallback() {
  return (
    <div aria-busy className="grid gap-(--gap) grid-cols-[repeat(auto-fill,minmax(min(100%,19rem),1fr))]">
      {[0, 1, 2].map((i) => (
        <ProviderCard key={i} name="…" kind="api" state="loading" />
      ))}
    </div>
  );
}

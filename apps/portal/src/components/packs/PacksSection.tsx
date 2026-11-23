import { routerGetAdmin } from "@/lib/server/router";
import { GlassPanel } from "@/components/kit/GlassPanel";
import type { PackLibrary } from "@/lib/packs-types";
import { tPacks } from "@/i18n/packs";
import { PackCard } from "./PackCard";

const when = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

/** Connections → Workflow packs (M4.5a, SPEC §8a): the library, from packs/ and what hostprobe installed. */
export async function PacksSection() {
  const r = await routerGetAdmin<PackLibrary>("/packs");
  if (!r.ok) return null; // the router-down notice above already covers this page
  const lib = r.data;
  return (
    <section aria-labelledby="sec-packs" className="grid gap-4">
      <div className="grid gap-1">
        <h2 id="sec-packs" className="heading text-2xl!">
          {tPacks("section.title")}
        </h2>
        <p className="max-w-2xl text-ink-muted">{tPacks("section.lead")}</p>
        {!lib.hostprobe ? (
          <GlassPanel tone="strong" role="note" className="mt-2 max-w-2xl text-sm">
            {tPacks("section.hostprobeDown")}
          </GlassPanel>
        ) : (
          <p className="max-w-2xl text-[0.8125rem] text-ink-muted">
            {lib.store ? tPacks("section.store", { store: lib.store }) + " " : ""}
            {lib.network_isolated ? tPacks("section.isolated") : tPacks("section.notIsolated")}
          </p>
        )}
      </div>
      <div className="grid gap-(--gap) grid-cols-[repeat(auto-fill,minmax(min(100%,19rem),1fr))]">
        {lib.packs.map((p) => (
          <PackCard key={p.id} pack={p} hostprobe={lib.hostprobe} />
        ))}
      </div>
      {Object.keys(lib.errors).length > 0 && (
        <GlassPanel tone="strong" role="note" className="grid max-w-2xl gap-1 text-sm">
          <p className="font-semibold">{tPacks("section.errors")}</p>
          <ul className="grid list-disc gap-1 pl-5">
            {Object.entries(lib.errors).map(([k, v]) => (
              <li key={k} className="break-words">
                <span className="font-mono">{k}</span>: {v}
              </li>
            ))}
          </ul>
        </GlassPanel>
      )}
      <details className="max-w-2xl text-sm">
        <summary className="cursor-pointer font-semibold">{tPacks("section.history")}</summary>
        {lib.history.length ? (
          <ul className="mt-2 grid gap-1">
            {lib.history.map((h) => (
              <li key={h.id} className="flex flex-wrap gap-x-2 text-ink-muted">
                <span className="font-semibold text-ink">{h.pack}</span>
                <span>{h.action}</span>
                {h.version && <span className="font-mono">{h.version}</span>}
                <span className={h.status === "failed" ? "text-err" : undefined}>{h.status}</span>
                <span suppressHydrationWarning>{when.format(new Date(h.started_at))} UTC</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-ink-muted">{tPacks("section.noHistory")}</p>
        )}
      </details>
    </section>
  );
}

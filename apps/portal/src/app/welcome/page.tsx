import type { Metadata } from "next";
import { RouterDown } from "@/components/connections/RouterDown";
import { Wizard } from "@/components/wizard/Wizard";
import { STEPS } from "@/lib/wizard";
import { loadConnections, loadOnboarding } from "@/lib/server/data";
import { t } from "@/i18n/strings";

export const metadata: Metadata = { title: t("wizard.title") };

export default async function Page({ searchParams }: { searchParams: Promise<{ step?: string }> }) {
  const [ob, conn, sp] = await Promise.all([loadOnboarding(), loadConnections(), searchParams]);
  if (!ob.ok) {
    return (
      <div className="mx-auto max-w-3xl">
        <RouterDown error={ob.error} />
      </div>
    );
  }
  const { state, goals } = ob.data;
  // ?step=1..5 deep-links a step (used for screenshots and "run setup again"); otherwise resume where saved.
  const asked = Number(sp.step);
  const saved = state && !state.completed_at ? STEPS.indexOf(state.step) : 0;
  const startStep = Number.isInteger(asked) && asked >= 1 && asked <= STEPS.length ? asked - 1 : Math.max(saved, 0);
  return (
    <Wizard
      initial={state}
      goalMap={goals}
      rows={conn.ok ? conn.data.rows : []}
      modelsByProvider={conn.ok ? conn.data.modelsByProvider : {}}
      startStep={startStep}
    />
  );
}

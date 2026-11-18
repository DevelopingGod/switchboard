import { redirect } from "next/navigation";
import { HomeHero } from "@/components/shell/HomeHero";
import { loadOnboarding, loadSettings } from "@/lib/server/data";

export default async function Home() {
  const [ob, settings] = await Promise.all([loadOnboarding(), loadSettings()]);
  const state = ob.ok ? ob.data.state : undefined;
  // First run only (no record yet). If the router is down we never block Home on it.
  if (state === null) redirect("/welcome");
  return (
    <HomeHero
      setupPending={!!state && !state.completed_at}
      serverName={state?.name ?? ""}
      privateDefault={settings.ok && settings.data.private_by_default}
    />
  );
}

import { redirect } from "next/navigation";
import { HomeHero } from "@/components/shell/HomeHero";
import { loadOnboarding } from "@/lib/server/data";

export default async function Home() {
  const ob = await loadOnboarding();
  const state = ob.ok ? ob.data.state : undefined;
  // First run only (no record yet). If the router is down we never block Home on it.
  if (state === null) redirect("/welcome");
  return <HomeHero setupPending={!!state && !state.completed_at} serverName={state?.name ?? ""} />;
}

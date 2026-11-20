/** App-wide chrome strings added in M1.5 (footer, shortcuts sheet, splash). */
import { lookup, type Leaves, type Vars } from "./strings";

export const shellStrings = {
  footer: {
    label: "Status and links",
    links: "Links",
    saved: "Value saved {amount}",
    savedTip: "What today’s free-tier replies would have cost at list price.",
    quota: {
      ok: "Quota OK",
      limited: "Quota limited",
      blocked: "Daily cap reached",
      /** M3a quota guard: the provider closest to a free limit. */
      day: "{name} {pct}% of today’s limit",
      minute: "{name} {pct}% of its per-minute limit",
      tip: "Quota: today’s budget use plus any provider that is rate-limited or out of credit.",
    },
    version: "v{version}",
    docs: "Docs",
    github: "GitHub",
    shortcuts: "Keyboard shortcuts",
    offline: "Status unavailable",
  },
  splash: "Loading Switchboard",
  /** The left sidebar (M3b). */
  /** M4b: the Jobs badge and job toasts (the watcher ships with the shell, so its strings live here). */
  jobs: {
    badge: "{n} need you",
    badgeOne: "1 needs you",
    /** After the visible number, for screen readers: "Jobs 2 need you". */
    badgeRest: "need you",
    badgeRestOne: "needs you",
    toastPlan: "Job {id} needs you: approve the plan",
    toastDiff: "Job {id} needs you: review the changes",
    toastResult: "Job {id} needs you: review the report",
    toastDone: "Job {id} is done",
    toastFailed: "Job {id} failed",
  },
  sidebar: {
    label: "Sidebar",
    collapse: "Collapse sidebar",
    expand: "Expand sidebar",
    openMenu: "Open menu",
    closeMenu: "Close menu",
    newChat: "New chat",
    palette: "Open command palette",
    searchChats: "Search chats",
    nav: "Main navigation",
    recents: "Recent chats",
    showMore: "Show more",
    loading: "Loading…",
    failed: "Couldn’t load your chats.",
    retry: "Try again",
    budget: "Today’s budget",
    budgetValue: "{spent} of {cap} used today",
    budgetUnknown: "Today’s budget: checking",
    health: {
      ok: "Everything is running",
      limited: "Running, with limits. Open Status",
      down: "Something needs attention. Open Status",
      unknown: "Checking status",
    },
    mode: "Mode",
    modeToggle: "Mode: {mode}. Switch to {other}",
    settings: "Settings",
    profile: "Profile: {name}",
    profileFallback: "Profile",
    appearance: "Appearance",
  },
  page: { actions: "Page actions", titleFallback: "Switchboard" },
};

export type ShellKey = Leaves<typeof shellStrings>;
export const tShell = (key: ShellKey, vars?: Vars) => lookup(shellStrings, key, vars);

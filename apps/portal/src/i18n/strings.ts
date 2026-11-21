/**
 * Core UI strings (every screen). Use `t("path.to.key", { vars })`. Feature strings live next to
 * this file in their own modules (chat.ts, connections.ts, wizard.ts, dev.ts) so each route ships
 * only its own text. Every user-facing string lives in src/i18n/.
 */
export const strings = {
  app: { name: "Switchboard", tagline: "One portal for every model and agent." },
  nav: {
    chat: "Chat",
    studio: "Studio",
    jobs: "Jobs",
    connections: "Connections",
    metrics: "Metrics",
    settings: "Settings",
    status: "Status",
    newChat: "New chat",
    home: "Home",
    skip: "Skip to content",
  },
  home: {
    greeting: "Hello, {name}.",
    question: "What do you want to build today?",
    fallbackName: "there",
    readOnlyNote: "On small screens the portal is read-only. Open it on a larger screen to start new work.",
    finishSetup: "Finish setup",
    chips: {
      label: "Quick starts",
      linkedin: { label: "Write a LinkedIn post", prompt: "Write a short LinkedIn post announcing that I built my own AI command center." },
      tests: {
        label: "Fix failing tests",
        prompt: "Fix the failing tests in my repo. The test suite fails with: TypeError: Cannot read properties of undefined (reading 'map').",
      },
      image: { label: "Make an image", prompt: "Make an image of a calm sky with soft clouds at sunrise." },
      research: { label: "Research a topic", prompt: "Research the best free LLM APIs for a personal assistant, with pros and cons." },
    },
  },
  composer: {
    label: "Message",
    placeholder: "Describe what you want. Switchboard picks the model or agent.",
    send: "Send",
    sending: "Sending…",
    target: "Target",
    auto: "Auto",
    autonomy: "Autonomy",
    private: "Private",
    privateHint: "Private work stays on local models.",
    think: "Think harder",
    thinkHint: "For this message only: a slower local model that reasons first. Better for tricky questions.",
    temperature: "Temperature",
    attach: "Attach file",
    errorDefault: "Couldn’t send that. Your text is still here, so try again.",
    disabledDefault: "Sending is unavailable right now.",
    emptyHint: "Type a request to get started.",
    stop: "Stop",
    slash: {
      label: "Slash commands",
      chat: "Plain chat (default rule)",
      code: "Code help (code rule)",
      research: "Research (chat; “Run as job” for longer work)",
      image: "Image (Studio, M5)",
      video: "Video (Studio, M5)",
      private: "Private: local model only",
      bulk: "Bulk, cheapest model",
    },
  },
  autonomy: {
    levels: ["Ask first", "Plan, then ask", "Work in sandbox", "Full auto"],
    descriptions: [
      "Reads and answers only. Nothing is changed without you.",
      "Proposes changes and waits for your approval.",
      "Runs in a sandbox or worktree; you review the result.",
      "Runs end to end inside a sandbox. Needs a budget and no real credentials.",
    ],
    valueText: "Level {level}: {name}",
  },
  mode: {
    label: "Mode",
    simple: "Simple",
    pro: "Pro",
    simpleHint: "Hides raw YAML, temperatures, fallbacks and logs.",
    proHint: "Shows every control.",
  },
  appearance: {
    open: "Appearance",
    theme: "Theme",
    system: "System",
    light: "Day sky",
    dark: "Dusk",
    density: "Density",
    comfortable: "Comfortable",
    compact: "Compact",
    solid: "Solid surfaces",
    solidHint: "Replaces glass with opaque panels.",
    skyImage: "Sky image",
    skyImageHint: "Use the optional painted sky instead of the gradient.",
  },
  palette: {
    open: "Search or jump to…",
    shortcut: "⌘K",
    title: "Command palette",
    placeholder: "Type a command or screen name",
    empty: "Nothing matches that.",
    groupGo: "Go to",
    groupPrefs: "Preferences",
    devComponents: "Component gallery",
    rules: "Routing rules",
    toggleTheme: "Switch to {theme} theme",
    toggleDensity: "Use {density} density",
    toggleMode: "Switch to {mode} mode",
    toggleSolid: "Toggle solid surfaces",
    toggleSky: "Toggle sky image",
  },
  status: {
    healthy: "Healthy",
    warning: "Needs attention",
    error: "Error",
    offline: "Offline",
    queued: "Queued",
    running: "Running",
    needsApproval: "Needs approval",
    done: "Done",
    failed: "Failed",
    stopped: "Stopped",
    waiting: "Waiting for reset",
  },
  state: {
    loading: "Loading",
    empty: "Nothing here yet",
    error: "Something went wrong",
    disabled: "Unavailable",
    retry: "Try again",
    dismiss: "Dismiss",
  },
  cost: { free: "Free", paid: "{amount}", estimate: "≈ {amount}", unknown: "Cost unknown", freeHint: "No charge", paidHint: "Billed to your key" },
  route: {
    routedTo: "Routed to {target}",
    byRule: "by rule {rule}",
    why: "Why this?",
    unknown: "Route unknown",
    pending: "Choosing a route",
    unavailable: "Decision log unavailable",
    title: "Why this route?",
    rule: "Rule",
    model: "Model",
    reasons: "Top reasons",
    runnerUp: "Runner-up",
    noRunnerUp: "None",
    skipped: "Skipped",
    tokens: "Tokens",
    tokensValue: "{in} in · {out} out",
    estimated: "(estimated)",
    context: "Context sent",
    contextValue: "{n} tokens of history",
    cost: "Cost",
    freeValue: "Free (≈ {value} value)",
    free: "Free",
    latency: "Latency",
    latencyValue: "{total} total · first token {ttft}",
    request: "Request #{id}",
    matched: {
      manual: "you picked it",
      slash: "slash command",
      private: "Private is on",
      intent: "matched the request",
      default: "nothing more specific matched",
    },
  },
  provider: {
    cli: "CLI agent",
    api: "API key",
    local: "Local model",
    quota: "Quota left",
    quotaUnknown: "No quota info",
    lastError: "Last error",
    test: "Test",
    login: "Log in",
    install: "Install",
    free: "Free tier",
    paid: "Paid",
    trains: "May train on your data",
    noTrain: "Not used for training",
  },
  job: {
    agent: "Agent",
    approve: "Approve",
    reject: "Reject",
    stop: "Stop",
    open: "Open",
    progress: "{pct}% complete",
    elapsed: "{time} elapsed",
    needsYou: "Waiting for your decision",
  },
  stat: { vsLast: "{delta} vs last week", noData: "No data" },
  explain: { open: "Explain {topic}", learnMore: "Learn more", close: "Close" },
  toast: { region: "Notifications", info: "Info", success: "Done", warning: "Heads up", error: "Error", close: "Dismiss notification" },
  empty: {
    jobsTitle: "No jobs yet",
    jobsBody: "A job is a task an agent works on in the background, like “fix the failing tests”. You approve anything risky.",
    jobsAction: "Run a sample job",
    generic: "Nothing to show yet.",
  },
  screens: {
    chat: { title: "Chat", body: "Threads, streaming replies and routing chips." },
    studio: { title: "Studio", body: "Image, video and content creation arrive in milestones M5 and M5.5." },
    jobs: { title: "Jobs", body: "Agents and the job board." },
    connections: { title: "Connections" },
    metrics: { title: "Metrics", body: "Cost, quota and latency dashboards arrive in milestone M6." },
    settings: { title: "Settings", body: "Rules, budgets and roles arrive in later milestones. Appearance is available from the toolbar." },
    comingSoon: "Coming soon",
  },
  logo: { alt: "Switchboard home" },
  connections: {
    intro: "Connect the services Switchboard can route to. Keys stay on this machine, encrypted, and only the last four characters are ever shown.",
    sectionApi: "API keys",
    sectionApiHint: "Free tiers first. Paste a key and it is checked before it is saved.",
    sectionCli: "Subscriptions and CLI agents",
    sectionCliHint: "Official command-line tools that run inside Ubuntu. Logging in happens in your terminal.",
    sectionLocal: "On this computer",
    sectionLocalHint: "Local models. Private work never leaves this machine.",
    routerDown: "Can’t reach the router",
    routerDownHint: "Start the stack and check it with scripts/doctor.sh, then try again.",
    hostprobeDown: "CLI status is unavailable because the hostprobe service isn’t running. scripts/doctor.sh shows how to start it.",
    refresh: "Try again",
  },
  badge: { code: "Best for code", fastest: "Fastest", context: "Largest context", free: "Free", paid: "Paid" },
  copy: { label: "Copy command", copied: "Copied", failed: "Select the text and copy it by hand." },
  a11y: { decorative: "", close: "Close", more: "More" },
} as const;






export type Leaves<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends string
    ? `${P}${K}`
    : T[K] extends readonly unknown[]
      ? `${P}${K}`
      : Leaves<T[K], `${P}${K}.`>;
}[keyof T & string];

export type StringKey = Leaves<typeof strings>;
export type Vars = Record<string, string | number>;

export function lookup(root: unknown, key: string, vars?: Vars): string {
  let node: unknown = root;
  for (const part of key.split(".")) node = (node as Record<string, unknown>)[part];
  const s = typeof node === "string" ? node : "";
  return vars ? s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`)) : s;
}

export function t(key: StringKey, vars?: Vars): string {
  return lookup(strings, key, vars);
}

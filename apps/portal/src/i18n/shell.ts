/** App-wide chrome strings added in M1.5 (footer, shortcuts sheet, splash). */
import { lookup, type Leaves, type Vars } from "./strings";

export const shellStrings = {
  footer: {
    label: "Status and links",
    links: "Links",
    health: {
      label: "Service health",
      router: "Router",
      litellm: "LiteLLM",
      ollama: "Ollama",
      paperclip: "Paperclip",
      ok: "{name}: running",
      down: "{name}: not running",
      unknown: "{name}: checking",
      open: "Open status",
    },
    spend: "Today {amount}",
    saved: "Value saved {amount}",
    savedTip: "What today’s free-tier replies would have cost at list price.",
    quota: {
      ok: "Quota OK",
      limited: "Quota limited",
      blocked: "Daily cap reached",
      tip: "Quota: today’s budget use plus any provider that is rate-limited or out of credit.",
    },
    version: "v{version}",
    docs: "Docs",
    github: "GitHub",
    shortcuts: "Keyboard shortcuts",
    offline: "Status unavailable",
  },
  splash: "Loading Switchboard",
};

export type ShellKey = Leaves<typeof shellStrings>;
export const tShell = (key: ShellKey, vars?: Vars) => lookup(shellStrings, key, vars);

/** Settings page strings (M1.5): their own module, so only /settings ships them. */
import { lookup, type Leaves, type Vars } from "./strings";

export const settingsStrings = {
  title: "Settings",
  intro: "Your name, goals, look and feel, privacy, budgets and data.",
  nav: "Settings sections",
  saved: "Saved",
  saving: "Saving…",
  save: "Save",
  reset: "Use default",
  cancel: "Cancel",
  section: {
    profile: "Profile",
    goals: "Goals & preset",
    appearance: "Appearance",
    privacy: "Privacy",
    budgets: "Budgets",
    data: "Data",
    setup: "Run setup again",
  },
  profile: {
    name: "Your name",
    nameHelp: "Used in greetings, for example on Home.",
    explain: "Stored on this machine with your setup. Nothing is sent to any model provider.",
  },
  goals: {
    presetTitle: "Preset",
    explain: "Free only never uses a paid model. Balanced adds your subscriptions. Best quality prefers the strongest model, with confirmation before any spend.",
    needOne: "Pick at least one goal.",
  },
  appearance: {
    lead: "Changes apply at once and are kept in this browser.",
    motion: "Motion",
    motionSystem: "Follow system",
    motionReduce: "Reduce",
    motionHint: "Reduce turns off every animation, whatever your system setting is.",
    cursor: "Ambient cursor",
    cursorHint: "A soft glow follows the pointer and lights the edges of cards. Desktop only; off when motion is reduced.",
    explain: "Solid surfaces and Reduce motion are the same switches your operating system offers (reduced transparency and reduced motion); either one turns these effects off.",
  },
  privacy: {
    privateDefault: "Start new chats as Private",
    privateHint: "Private chats use local models only and never leave this computer. You can still switch it off for one chat.",
    explain: "A chat that starts private stays private. Private replies come from Ollama on this machine, so quality depends on your local models.",
  },
  budgets: {
    lead: "Spend limits for paid models. Free-tier and local models never count.",
    perRequest: "Per-request cap (US$)",
    perRequestHelp: "A single reply that would cost more is blocked before it is sent. Default {value}.",
    daily: "Daily cap (US$)",
    dailyHelp: "Paid replies stop for the rest of the day (UTC) once this is reached. Default {value}.",
    today: "Spent today",
    todayOf: "{spent} of {cap}",
    invalid: "Enter an amount between 0 and 100, like 0.50.",
    explain: "Caps are checked before every request, using the price list of the chosen model. Rules can set a lower cap for a task; the stricter limit always wins.",
  },
  data: {
    exportTitle: "Export chats",
    exportLead: "Download every chat as a file you can keep or open elsewhere.",
    json: "Download JSON",
    md: "Download Markdown",
    includePrivate: "Include private chats",
    clearTitle: "Clear all chats",
    clearLead: "Deletes every chat and reply on this machine. Settings and keys are kept.",
    clear: "Clear chats…",
    confirmTitle: "Delete every chat?",
    confirmBody: "This can’t be undone. Export first if you want a copy.",
    confirmLabel: "Type delete to confirm",
    confirmWord: "delete",
    confirmYes: "Delete all chats",
    cleared: "All chats deleted",
    explain: "Exports are made on this machine and downloaded directly; nothing is uploaded.",
  },
  setup: {
    lead: "Go through the setup again with your current answers filled in. Nothing changes until you finish it.",
    open: "Run setup again",
  },
};

export type SettingsKey = Leaves<typeof settingsStrings>;
export const tSet = (key: SettingsKey, vars?: Vars) => lookup(settingsStrings, key, vars);

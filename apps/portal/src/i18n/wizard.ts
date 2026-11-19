/** Wizard strings: their own module so only the screens that use them ship them
 * (the core registry is strings.ts; every user-facing string lives in src/i18n/). */
import { lookup, type Leaves, type Vars } from "./strings";

export const wizardStrings = {
  wizard: {
    title: "Set up Switchboard",
    progress: "Setup progress",
    step: "Step {n} of {total}",
    skip: "Skip for now",
    cancelAgain: "Cancel (keep current setup)",
    saveAgain: "Save changes",
    back: "Back",
    next: "Continue",
    open: "Open Switchboard",
    saveFailed: "Couldn’t save your progress",
    steps: { welcome: "Welcome", goals: "Goals", connect: "Connect", preset: "Preset", finish: "Done" },
    welcome: {
      title: "Welcome to Switchboard",
      body: "One place to chat, build and create. It picks the right model or agent for each request and tells you what it cost.",
      nameLabel: "What should we call you?",
      namePlaceholder: "Your first name",
      modeLabel: "How much detail do you want?",
    },
    goals: {
      title: "What do you want to do?",
      body: "Pick everything that applies. We’ll only ask you to connect what those goals need.",
      empty: "Choose at least one goal to continue.",
      items: {
        chat: { label: "Chat and quick answers", hint: "Fast questions, explanations, drafts." },
        writing: { label: "Writing and content", hint: "Posts, emails, blogs, newsletters." },
        code: { label: "Code", hint: "Write, fix and review code with agents." },
        research: { label: "Research", hint: "Read widely and summarise." },
        images: { label: "Images", hint: "Free quota first; a paid option is available." },
        video: { label: "Video", hint: "No reliable free option exists. It is paid and always asks before spending." },
        private: { label: "Private work", hint: "Stays on local models and never leaves this machine." },
      },
    },
    connect: {
      title: "Connect what you need",
      body: "Only the providers your goals use. You can skip any of them and add them later in Connections.",
      none: "Pick at least one goal first, and the providers you need will show up here.",
      forGoals: "Needed for: {goals}",
      /** M3a: the local-model profile picked from the detected GPU. */
      localProfile: "Detected {gpu} → local profile “{label}” ({models}). Change it in Settings → Local models.",
      noGpu: "no NVIDIA GPU",
    },
    preset: {
      title: "Pick a starting preset",
      body: "A preset is how Switchboard balances cost and quality. You can change it later.",
      free: { label: "Free only", body: "Free tiers and local models. Never spends money." },
      balanced: { label: "Balanced", body: "Free tiers first, plus the subscriptions you already have." },
      best: { label: "Best quality", body: "The strongest model for each task, within your budget caps." },
      note: "Routing uses it for every message. Change it any time.",
    },
    finish: {
      title: "You’re all set, {name}",
      body: "Here is what you chose. All of it can be changed from Connections and Settings.",
      goals: "Goals",
      preset: "Preset",
      connected: "Connected",
      none: "None yet",
      tryTitle: "Try it",
      tryBody: "Ask something in Chat to see routing, the “Why this?” chip and cost. Image and code-job samples arrive with Studio (M5) and Jobs (M4).",
      tryBadge: "Chat is live",
    },
  },
} as const;

export type WizardKey = Leaves<typeof wizardStrings>;

export function tWizard(key: WizardKey, vars?: Vars): string {
  return lookup(wizardStrings, key, vars);
}

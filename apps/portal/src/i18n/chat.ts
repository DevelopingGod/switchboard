/** Chat strings: their own module so only the screens that use them ship them
 * (the core registry is strings.ts; every user-facing string lives in src/i18n/). */
import { lookup, type Leaves, type Vars } from "./strings";

export const chatStrings = {
  chat: {
    title: "Chat",
    threads: "Chats",
    newChat: "New chat",
    noThreads: "No chats yet. Ask anything below.",
    untitled: "New chat",
    privateThread: "Private: stays on this computer",
    privateBadge: "Private",
    emptyTitle: "Start a conversation",
    emptyBody: "Switchboard picks a model for each message and shows why. Pick one yourself with Target, or start with a slash command.",
    you: "You",
    assistant: "Assistant",
    rename: "Rename chat",
    renameLabel: "Chat name",
    save: "Save",
    cancel: "Cancel",
    delete: "Delete chat",
    deleteConfirm: "Delete this chat?",
    deleteYes: "Delete",
    deleted: "Chat deleted",
    stopped: "Stopped. The reply so far is kept.",
    regenerate: "Regenerate",
    edit: "Edit message",
    editLabel: "Edit your last message",
    editSend: "Save and resend",
    copy: "Copy reply",
    copyCode: "Copy code",
    copied: "Copied",
    good: "Good reply",
    bad: "Bad reply",
    feedbackSaved: "Thanks, noted for routing",
    thinking: "Thinking…",
    thoughtFor: "Thought for {time}",
    showThinking: "Show thinking",
    hideThinking: "Hide thinking",
    thinkingNote: "Thinking is shown live and never saved.",
    routing: "Choosing a model…",
    answering: "Answering with {label}",
    fallingBack: "{label}: {reason}. Trying {next}…",
    fallingBackNone: "{label}: {reason}.",
    retry: "Try again",
    sendFailedGeneric: "Couldn’t reach Switchboard. Try again in a moment.",
    jobHint: "This looks like a job for an agent. Jobs arrive in milestone M4; for now you get a chat answer.",
    runAsJob: "Run as job (M4)",
    notice: {
      image: "Image generation arrives in Studio (milestone M5). Nothing was sent or charged.",
      video: "Video generation arrives in Studio (milestone M5). Nothing was sent or charged.",
      audio: "Audio arrives in Studio (milestone M5). Nothing was sent or charged.",
      open: "Open Studio",
    },
    blocked: {
      title: "Budget cap reached",
      daily: "Daily budget {cap} reached ({spent} spent today).",
      request: "This would cost more than the {cap} per-request cap.",
      hint: "Free and local models still work: pick one with Target. Caps live in config/rules.yaml.",
    },
    target: {
      label: "Target",
      auto: "Auto",
      autoHint: "Rules pick per message",
      aliases: "Aliases",
      models: "{provider} models",
      loading: "Loading models…",
      failed: "Couldn’t load models: {reason}",
      privateOnly: "Private is on: local only",
      paid: "Paid",
      local: "On this computer",
      choose: "Choose a target",
    },
    loadFailed: "Couldn’t load chats: {reason}",
  },
} as const;

export type ChatKey = Leaves<typeof chatStrings>;

export function tChat(key: ChatKey, vars?: Vars): string {
  return lookup(chatStrings, key, vars);
}

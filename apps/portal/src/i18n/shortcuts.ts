/** Keyboard shortcuts sheet strings: only the lazy sheet imports them (M1.5). */
import { lookup, type Leaves, type Vars } from "./strings";

export const shortcutStrings = {
  title: "Keyboard shortcuts",
  description: "Press ? anywhere to open this list.",
  group: { general: "General", chat: "Chat", list: "Thread list" },
  item: {
    palette: "Search and jump to anything",
    shortcuts: "Show keyboard shortcuts",
    close: "Close a dialog, menu or tooltip",
    newChat: "New chat",
    sidebar: "Show or hide the sidebar",
    focusComposer: "Focus the message box",
    send: "Send the message",
    newline: "New line in the message",
    stop: "Stop the reply",
    listMove: "Move between threads",
    listOpen: "Open the thread",
    listRename: "Rename the thread",
    listDelete: "Delete the thread",
  },
  mod: { mac: "⌘", other: "Ctrl" },
};

export type ShortcutKey = Leaves<typeof shortcutStrings>;
export const tShortcuts = (key: ShortcutKey, vars?: Vars) => lookup(shortcutStrings, key, vars);

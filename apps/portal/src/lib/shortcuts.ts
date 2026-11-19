/**
 * Every keyboard shortcut (M1.5), in one place: the sheet (`?`) lists exactly these, and the
 * global handler in AppShell matches on the same ids. `mod` is ⌘ on Mac and Ctrl elsewhere.
 * Scope "chat" ones only act on the Chat screen; "list" ones apply inside the thread list.
 */
export type ShortcutId =
  | "palette"
  | "shortcuts"
  | "sidebar"
  | "newChat"
  | "focusComposer"
  | "stop"
  | "send"
  | "newline"
  | "listMove"
  | "listOpen"
  | "listRename"
  | "listDelete"
  | "close";

export interface Shortcut {
  id: ShortcutId;
  /** Keys as shown; "mod" renders as ⌘ or Ctrl. */
  keys: string[];
  group: "general" | "chat" | "list";
}

export const SHORTCUTS: Shortcut[] = [
  { id: "palette", keys: ["mod", "K"], group: "general" },
  { id: "shortcuts", keys: ["?"], group: "general" },
  { id: "close", keys: ["Esc"], group: "general" },
  { id: "newChat", keys: ["mod", "Shift", "O"], group: "general" },
  { id: "sidebar", keys: ["mod", "B"], group: "general" },
  { id: "focusComposer", keys: ["/"], group: "chat" },
  { id: "send", keys: ["Enter"], group: "chat" },
  { id: "newline", keys: ["Shift", "Enter"], group: "chat" },
  { id: "stop", keys: ["mod", "."], group: "chat" },
  { id: "listMove", keys: ["↑", "↓"], group: "list" },
  { id: "listOpen", keys: ["Enter"], group: "list" },
  { id: "listRename", keys: ["F2"], group: "list" },
  { id: "listDelete", keys: ["Delete"], group: "list" },
];

/** True when the key event is typed into a text field (single-key shortcuts must not fire). */
export function isTyping(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}

/** Which global shortcut a key event is, if any. */
export function matchShortcut(e: KeyboardEvent): ShortcutId | null {
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key.toLowerCase();
  if (mod && !e.shiftKey && !e.altKey && k === "k") return "palette";
  if (mod && !e.shiftKey && !e.altKey && k === "b") return "sidebar";
  if (mod && e.shiftKey && !e.altKey && k === "o") return "newChat";
  if (mod && !e.shiftKey && k === ".") return "stop";
  if (!mod && !e.altKey && e.key === "?" && !isTyping(e)) return "shortcuts";
  if (!mod && !e.altKey && !e.shiftKey && e.key === "/" && !isTyping(e)) return "focusComposer";
  return null;
}

export const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

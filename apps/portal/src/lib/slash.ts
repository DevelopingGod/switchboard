/**
 * Slash commands (SPEC §7.1), mirrored from config/rules.yaml `slash:` for composer hints.
 * The router is the source of truth for routing; this only drives the hint list.
 */

export const SLASH_COMMANDS = ["chat", "code", "research", "image", "video", "private", "bulk"] as const;
export type SlashCommand = (typeof SLASH_COMMANDS)[number];

/** Commands matching what is typed so far ("/co" -> ["code"]), or null when no hint applies. */
export function slashMatches(text: string): SlashCommand[] | null {
  const m = /^\/([a-z]*)$/i.exec(text);
  if (!m) return null;
  const q = m[1].toLowerCase();
  const hits = SLASH_COMMANDS.filter((c) => c.startsWith(q));
  return hits.length ? hits : null;
}

/** Replaces the typed fragment with the full command and a trailing space. */
export function applySlash(cmd: SlashCommand): string {
  return `/${cmd} `;
}

/** The command a message starts with, if any. */
export function leadingSlash(text: string): SlashCommand | null {
  const m = /^\/([a-z]+)(\s|$)/i.exec(text.trim());
  const c = m?.[1].toLowerCase();
  return c && (SLASH_COMMANDS as readonly string[]).includes(c) ? (c as SlashCommand) : null;
}

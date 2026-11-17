/** "claude  (then /login in the browser)" → the command and the note after it. */
export function splitHint(hint: string | null | undefined): { command: string; note: string | null } {
  const m = (hint ?? "").match(/^(.*?)\s{2,}\((.*)\)\s*$/);
  return m ? { command: m[1].trim(), note: m[2].trim() } : { command: (hint ?? "").trim(), note: null };
}


/** "claude  (then /login in the browser)" → the command and the note after it. */
export function splitHint(hint: string | null | undefined): { command: string; note: string | null } {
  const m = (hint ?? "").match(/^(.*?)\s{2,}\((.*)\)\s*$/);
  return m ? { command: m[1].trim(), note: m[2].trim() } : { command: (hint ?? "").trim(), note: null };
}


/** The program in a login command: "opencode auth login" → "opencode". */
export const binOf = (command: string): string => command.trim().split(/\s+/)[0] ?? "";

/** "~/.opencode/bin" → "$HOME/.opencode/bin" (inside double quotes "~" would not expand). */
export const toShellPath = (p: string): string => (p === "~" || p.startsWith("~/") ? `$HOME${p.slice(1)}` : p);

/** One line that puts an install directory on PATH for every new terminal, and this one. */
export const pathFixLine = (binDir: string): string =>
  `echo 'export PATH="${toShellPath(binDir)}:$PATH"' >> ~/.bashrc && source ~/.bashrc`;

/** The login command with its program replaced by the binary's full path (works with no PATH change). */
export function fullPathCommand(command: string, binPath: string): string {
  const bin = binOf(command);
  return bin ? `${binPath}${command.trim().slice(bin.length)}` : command;
}

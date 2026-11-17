import { CopyButton } from "@/components/kit/CopyButton";
import { binOf, fullPathCommand, pathFixLine } from "@/lib/cli-hint";
import { tConn } from "@/i18n/connections";

interface Props {
  /** The login command, e.g. "opencode auth login". */
  command: string;
  note?: string | null;
  binPath?: string | null;
  binDir?: string | null;
  /** false = a new terminal can't find the binary yet; null/undefined = unknown (no PATH step shown). */
  onUserPath?: boolean | null;
  /** Sub-heading level: h4 inside a card (under its h3), h3 inside the install dialog (under its h2). */
  headingAs?: "h3" | "h4";
}

function Command({ text, label }: { text: string; label: string }) {
  return (
    <div className="grid gap-1.5">
      <pre className="solid-panel overflow-x-auto p-3" tabIndex={0} aria-label={label}>
        <code>{text}</code>
      </pre>
      <div>
        <CopyButton text={text} label={label} />
      </div>
    </div>
  );
}

/**
 * What to run in a terminal to log in. When the install directory is not on a new terminal's PATH
 * ("command not found"), a one-line PATH fix comes first, and the login command by full path is
 * offered as a fallback. Nothing here runs anything: it is text to copy.
 */
export function LoginSteps({ command, note, binPath, binDir, onUserPath, headingAs: H = "h4" }: Props) {
  const needsPath = onUserPath === false && !!binDir && !!binPath;
  const bin = binOf(command);
  return (
    <div className="grid gap-3">
      <p className="text-sm text-ink-muted">{tConn("cli.loginBody")}</p>
      {needsPath && (
        <section className="grid gap-1.5">
          <H className="label">{tConn("cli.pathTitle", { bin })}</H>
          <p className="text-sm text-ink-muted">{tConn("cli.pathBody", { bin, dir: binDir! })}</p>
          <Command text={pathFixLine(binDir!)} label={tConn("cli.copyPath")} />
        </section>
      )}
      <section className="grid gap-1.5">
        <H className="label">{needsPath ? tConn("cli.loginStep") : tConn("cli.loginTitle")}</H>
        <Command text={command} label={tConn("cli.copyLogin")} />
        {note && <p className="text-xs text-ink-muted">{tConn("cli.loginNote", { note })}</p>}
      </section>
      {needsPath && (
        <section className="grid gap-1.5">
          <H className="label">{tConn("cli.fullPathTitle")}</H>
          <p className="text-sm text-ink-muted">{tConn("cli.fullPathBody")}</p>
          <Command text={fullPathCommand(command, binPath!)} label={tConn("cli.copyFullPath")} />
        </section>
      )}
    </div>
  );
}

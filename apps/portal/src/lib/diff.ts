/**
 * Split a unified `git diff` (hostprobe's job diff, ≤ 1 MB) into one entry per file, so the viewer can
 * render, collapse and highlight each file on its own (M4b). Pure and linear in the input size.
 */
export interface DiffLine {
  kind: "add" | "del" | "ctx" | "hunk" | "meta";
  text: string;
}

export interface FileDiff {
  path: string;
  oldPath: string | null;
  isNew: boolean;
  isDeleted: boolean;
  binary: boolean;
  added: number;
  removed: number;
  lines: DiffLine[];
}

const HEADER = /^diff --git a\/(.+?) b\/(.+)$/;

export function parseDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let cur: FileDiff | null = null;
  let inHunk = false;
  for (const raw of text.split("\n")) {
    const h = HEADER.exec(raw);
    if (h) {
      cur = { path: h[2], oldPath: h[1] !== h[2] ? h[1] : null, isNew: false, isDeleted: false, binary: false, added: 0, removed: 0, lines: [] };
      files.push(cur);
      inHunk = false;
      continue;
    }
    if (!cur) continue;
    if (!inHunk) {
      if (raw.startsWith("new file mode")) cur.isNew = true;
      else if (raw.startsWith("deleted file mode")) cur.isDeleted = true;
      else if (raw.startsWith("Binary files")) cur.binary = true;
      else if (raw.startsWith("+++ ") && raw !== "+++ /dev/null") cur.path = raw.slice(4).replace(/^b\//, "");
      if (raw.startsWith("@@")) {
        inHunk = true;
        cur.lines.push({ kind: "hunk", text: raw });
      }
      continue;
    }
    if (raw.startsWith("@@")) cur.lines.push({ kind: "hunk", text: raw });
    else if (raw.startsWith("+")) {
      cur.added++;
      cur.lines.push({ kind: "add", text: raw.slice(1) });
    } else if (raw.startsWith("-")) {
      cur.removed++;
      cur.lines.push({ kind: "del", text: raw.slice(1) });
    } else if (raw.startsWith("\\")) cur.lines.push({ kind: "meta", text: raw });
    else if (raw.startsWith(" ") || raw === "") cur.lines.push({ kind: "ctx", text: raw.slice(1) });
  }
  // A trailing "" from the final newline is not a context line.
  for (const f of files) {
    const last = f.lines[f.lines.length - 1];
    if (last && last.kind === "ctx" && last.text === "") f.lines.pop();
  }
  return files;
}

/** File extension → highlight.js language (only the ones the chat bundle already registers). */
export function languageOf(path: string): string | undefined {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    py: "python",
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    json: "json",
    sh: "bash",
    bash: "bash",
    yml: "yaml",
    yaml: "yaml",
    md: "markdown",
    css: "css",
    html: "xml",
    xml: "xml",
    go: "go",
    rs: "rust",
    java: "java",
    sql: "sql",
  };
  return map[ext];
}

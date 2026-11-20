/**
 * A bounded list of log lines for the live job log (M4b): the page keeps at most `max` lines however long
 * a run talks, and remembers how many it dropped (principle 4: no unbounded in-memory state).
 * Immutable updates, so React state can hold it directly.
 */
export interface LogLine {
  /** Stable key: run id + sequence number within this buffer. */
  key: string;
  stream: string;
  text: string;
}

export interface LogBuffer {
  lines: LogLine[];
  dropped: number;
  seq: number;
}

export const emptyLog = (): LogBuffer => ({ lines: [], dropped: 0, seq: 0 });

export function appendLog(buf: LogBuffer, run: string, items: { stream?: string | null; chunk?: string | null }[], max = 5000): LogBuffer {
  if (!items.length) return buf;
  let seq = buf.seq;
  const add: LogLine[] = [];
  for (const it of items) {
    const text = (it.chunk ?? "").replace(/\r\n?/g, "\n").replace(/\n$/, "");
    for (const part of text.split("\n")) add.push({ key: `${run}:${seq++}`, stream: it.stream ?? "stdout", text: part });
  }
  const all = buf.lines.concat(add);
  const over = Math.max(0, all.length - max);
  return { lines: over ? all.slice(over) : all, dropped: buf.dropped + over, seq };
}

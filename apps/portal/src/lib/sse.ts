/**
 * Minimal Server-Sent Events reader for `fetch` streams (EventSource is GET-only; chat is a POST).
 * Client-safe; unit-tested in sse.test.ts.
 */

export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

/** Incremental parser: feed text chunks, get complete events back. */
export class SseParser {
  private buf = "";

  feed(chunk: string): SseEvent[] {
    this.buf += chunk.replace(/\r\n?/g, "\n");
    const out: SseEvent[] = [];
    let i: number;
    while ((i = this.buf.indexOf("\n\n")) >= 0) {
      const block = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 2);
      const ev = parseBlock(block);
      if (ev) out.push(ev);
    }
    return out;
  }
}

function parseBlock(block: string): SseEvent | null {
  let event = "message";
  let id: string | undefined;
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const c = line.indexOf(":");
    const field = c < 0 ? line : line.slice(0, c);
    const value = c < 0 ? "" : line.slice(c + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    else if (field === "id") id = value;
  }
  if (!data.length) return null;
  return { event, data: data.join("\n"), id };
}

/** Reads a fetch Response body as SSE, calling `onEvent` per event. Resolves when the stream ends. */
export async function readSse(res: Response, onEvent: (e: SseEvent) => void): Promise<void> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const parser = new SseParser();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    for (const ev of parser.feed(dec.decode(value, { stream: true }))) onEvent(ev);
  }
  for (const ev of parser.feed(dec.decode() + "\n\n")) onEvent(ev);
}

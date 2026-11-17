import { describe, expect, it } from "vitest";
import { SseParser, readSse } from "./sse";

describe("SseParser", () => {
  it("parses events split across chunks", () => {
    const p = new SseParser();
    expect(p.feed("event: delta\nda")).toEqual([]);
    expect(p.feed('ta: {"text":"Hi"}\n\nevent: done\ndata: {}\n')).toEqual([{ event: "delta", data: '{"text":"Hi"}', id: undefined }]);
    expect(p.feed("\n")).toEqual([{ event: "done", data: "{}", id: undefined }]);
  });

  it("handles CRLF, comments, ids and multi-line data", () => {
    const p = new SseParser();
    expect(p.feed(": keepalive\r\nid: 7\r\nevent: log\r\ndata: a\r\ndata: b\r\n\r\n")).toEqual([{ event: "log", data: "a\nb", id: "7" }]);
  });

  it("defaults the event name to message and skips blocks without data", () => {
    const p = new SseParser();
    expect(p.feed("event: ping\n\ndata: x\n\n")).toEqual([{ event: "message", data: "x", id: undefined }]);
  });
});

describe("readSse", () => {
  it("reads a streamed Response and flushes the tail", async () => {
    const body = new ReadableStream({
      start(c) {
        const enc = new TextEncoder();
        c.enqueue(enc.encode('event: start\ndata: {"a":1}\n\nevent: del'));
        c.enqueue(enc.encode('ta\ndata: {"text":"é"}\n\nevent: done\ndata: {}'));
        c.close();
      },
    });
    const seen: string[] = [];
    await readSse(new Response(body), (e) => seen.push(`${e.event}:${e.data}`));
    expect(seen).toEqual(['start:{"a":1}', 'delta:{"text":"é"}', "done:{}"]);
  });
});

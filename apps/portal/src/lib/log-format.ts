/**
 * The agents' live output in plain words (M4b). Claude Code (`stream-json`), Codex (`exec --json`) and
 * OpenCode (`run --format json`) print one JSON event per line; this keeps what a person wants to follow
 * (the agent's own words, the commands and tools it runs, how a run ended) and drops bookkeeping events.
 * Formats were read from real runs of Claude Code 2.1.326, Codex 0.170.0 and OpenCode 1.19.6 (docs/m4a.md).
 * Anything unknown is shown as it is; "Show raw output" always has every line.
 */
export interface Pretty {
  kind: "text" | "tool" | "result" | "plain";
  text: string;
}

const short = (s: unknown, n = 160) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

type O = Record<string, unknown>;
const obj = (v: unknown): O => (v && typeof v === "object" ? (v as O) : {});

function toolText(name: unknown, input: unknown): string {
  const i = obj(input);
  const what = i.command ?? i.file_path ?? i.filePath ?? i.path ?? i.pattern ?? i.url ?? "";
  return `→ ${String(name ?? "tool")}${what ? `: ${short(what, 140)}` : ""}`;
}

/** null = an event that isn't worth showing (session bookkeeping, rate-limit pings, step markers). */
export function prettyLine(line: string): Pretty | null {
  const s = line.trim();
  if (!s) return null;
  if (!s.startsWith("{")) return { kind: "plain", text: line };
  let e: O;
  try {
    e = JSON.parse(s) as O;
  } catch {
    return { kind: "plain", text: line };
  }
  const type = String(e.type ?? "");
  // Claude Code
  if (type === "assistant") {
    const parts = (obj(e.message).content as O[] | undefined) ?? [];
    const out = parts
      .map((p) => (p.type === "text" ? short(p.text, 600) : p.type === "tool_use" ? toolText(p.name, p.input) : ""))
      .filter(Boolean);
    return out.length ? { kind: parts.some((p) => p.type === "tool_use") ? "tool" : "text", text: out.join("\n") } : null;
  }
  if (type === "user") {
    const parts = (obj(e.message).content as O[] | undefined) ?? [];
    const err = parts.find((p) => p.type === "tool_result" && p.is_error);
    return err ? { kind: "tool", text: `← refused or failed: ${short(err.content, 200)}` } : null;
  }
  if (type === "result") {
    const cost = typeof e.total_cost_usd === "number" ? `, list price $${e.total_cost_usd.toFixed(3)}` : "";
    const secs = typeof e.duration_ms === "number" ? `, ${Math.round(e.duration_ms / 1000)} s` : "";
    return { kind: "result", text: `Run finished: ${String(e.subtype ?? "done")}${secs}${cost}` };
  }
  if (type === "system" || type === "rate_limit_event") return null;
  // Codex
  if (type === "item.completed" || type === "item.started") {
    const it = obj(e.item);
    if (it.type === "agent_message" && type === "item.completed") return { kind: "text", text: short(it.text, 600) };
    if (it.type === "command_execution") {
      if (type === "item.started") return { kind: "tool", text: `$ ${short(it.command, 200)}` };
      return typeof it.exit_code === "number" && it.exit_code !== 0 ? { kind: "tool", text: `← exit ${it.exit_code}` } : null;
    }
    if (it.type === "file_change" && type === "item.completed") {
      const ch = (it.changes as O[] | undefined) ?? [];
      return { kind: "tool", text: `→ edit: ${ch.map((c) => c.path).filter(Boolean).join(", ") || "files"}` };
    }
    return null;
  }
  if (type === "turn.completed") return { kind: "result", text: "Turn finished" };
  if (type === "turn.failed" || type === "error") return { kind: "result", text: `Failed: ${short(obj(e.error).message ?? e.message, 300)}` };
  if (type.startsWith("thread.") || type === "turn.started") return null;
  // OpenCode
  if (type === "text") return { kind: "text", text: short(obj(e.part).text, 600) };
  if (type === "tool_use") {
    const part = obj(e.part);
    return { kind: "tool", text: toolText(part.tool, obj(part.state).input) };
  }
  if (type === "step_start" || type === "step_finish") return null;
  return { kind: "plain", text: short(s, 300) };
}

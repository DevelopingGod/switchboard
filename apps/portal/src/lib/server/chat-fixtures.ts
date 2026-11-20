import "server-only";
import type { Result } from "./router";
import type { ChatMessage, ChatThread, RouteInfo, TargetsResponse, TargetModel } from "../router-types";

/**
 * PORTAL_DATA=fixture: an in-memory fake of the router's chat API with deterministic streaming
 * scenarios (tests, axe, visual baselines, screenshots). Scenario by prompt:
 *   "rate limit"            fast answers 429 -> falls back to smart-free (chip shows why)
 *   private / "/private"    local only, with a "Thinking…" phase
 *   "budget"                blocked by the daily cap
 *   "/image", "make an image of", "/video"   Studio notice (M5)
 *   "failing tests", "/research"             answered in chat + a "Run as job" button (M4b)
 *   "code" / "/code"        a fenced code block
 *   "blood test"            auto-private (M3a): kept local with a "Not sensitive — use cloud" note
 *   a pasted "sk-…" key     masked, kept local, secret note on the message (M3a)
 *   anything else           a short Markdown answer
 * The seeded "Notes on my health check" thread is private by auto-detection and has a summary.
 */

interface FxThread extends ChatThread {
  messages: ChatMessage[];
}

interface Store {
  threads: FxThread[];
  nextMsg: number;
  nextReq: number;
  nextThread: number;
  stops: Set<number>;
}

const g = globalThis as unknown as { __sbChat?: Store };
/** Fixture times are relative to server start (local time), so the sidebar's Today / Yesterday /
 * Previous 7 days / Older groups are the same on every run (M1.5). */
const day = (offset: number, hour = 9, minute = 0) => {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  d.setDate(d.getDate() + offset);
  return d.toISOString();
};
const T0 = day(0);

const SECRET = /\b(sk-[A-Za-z0-9_-]{20,})\b/g;

const local = (over: Partial<RouteInfo>): Partial<RouteInfo> => ({
  rule: "private",
  private: true,
  target: "model:local",
  label: "Ollama · qwen3:4b",
  local: true,
  model: "ollama_chat/qwen3:4b",
  provider: "ollama",
  provider_name: "Ollama (local)",
  runner_up: null,
  skipped: [],
  list_price_usd: null,
  thinking_ms: null,
  latency_ms: 2100,
  ttft_ms: 1900,
  ...over,
});

const base = (over: Partial<RouteInfo>): RouteInfo => ({
  request_id: 1,
  rule: "default",
  matched_by: "default",
  intent: "chat",
  preset: "balanced",
  private: false,
  job_suggested: false,
  target: "model:fast",
  label: "Groq · gpt-oss-120b",
  local: false,
  free_tier: true,
  reasons: ["General chat → default rule", "First choice of rule “default”", "Free tier · Groq does not train on API data"],
  runner_up: "Google AI Studio · gemini-3.1-flash-lite",
  skipped: [
    { target: "model:general", label: "Mistral · mistral-small-latest", code: "not_connected", reason: "Not connected: add a key for Mistral (La Plateforme) in Connections" },
  ],
  context_tokens: 0,
  thinking_ms: 120,
  model: "groq/openai/gpt-oss-120b",
  provider: "groq",
  provider_name: "Groq",
  tokens_in: 117,
  tokens_out: 81,
  estimated: false,
  cost_usd: 0,
  list_price_usd: 0.000066,
  latency_ms: 747,
  ttft_ms: 655,
  ...over,
});

const SKY = [
  "The sky looks blue because of **Rayleigh scattering**: air molecules scatter short (blue) wavelengths of sunlight much more than long (red) ones.",
  "",
  "- Blue light is scattered about 5× more than red.",
  "- At sunset, light crosses more air, so the blues are scattered away and reds remain.",
].join("\n");

const CODE = [
  "Here is a one-liner that reverses a list in Python:",
  "",
  "```python",
  "items = [1, 2, 3, 4]",
  "reversed_items = items[::-1]  # [4, 3, 2, 1]",
  "```",
  "",
  "Use `items.reverse()` to reverse in place instead.",
].join("\n");

function seed(): FxThread[] {
  const fallback = base({
    request_id: 3,
    target: "model:smart-free",
    label: "Google AI Studio · gemini-3.1-flash-lite",
    model: "gemini/gemini-3.1-flash-lite",
    provider: "gemini",
    provider_name: "Google AI Studio (Gemini)",
    reasons: [
      "General chat → default rule",
      "Fallback: Groq · gpt-oss-120b skipped (Rate limited (429))",
      "Free tier (may train on your data)",
    ],
    runner_up: "Ollama · qwen3:4b",
    skipped: [
      { target: "model:fast", label: "Groq · gpt-oss-120b", code: "rate_limited", reason: "Rate limited (429)" },
      { target: "model:general", label: "Mistral · mistral-small-latest", code: "not_connected", reason: "Not connected: add a key for Mistral (La Plateforme) in Connections" },
    ],
    thinking_ms: null,
    tokens_in: 42,
    tokens_out: 35,
    list_price_usd: 0.000063,
    latency_ms: 1674,
    ttft_ms: 1499,
  });
  return [
    {
      id: "6f1c2a10-0000-4000-8000-000000000001",
      title: "Why the sky is blue",
      title_source: "local",
      private: false,
      pinned: false,
      created_at: T0,
      updated_at: day(0, 9, 5),
      messages: [
        { id: 1, role: "user", content: "In two lines: why is the sky blue?", status: "done", private: false, feedback: null, route: null, created_at: T0 },
        { id: 2, role: "assistant", content: SKY, status: "done", private: false, feedback: "up", route: base({ request_id: 1 }), created_at: T0 },
        { id: 3, role: "user", content: "/code reverse a list in python", status: "done", private: false, feedback: null, route: null, created_at: T0 },
        {
          id: 4,
          role: "assistant",
          content: CODE,
          status: "done",
          private: false,
          feedback: null,
          route: base({
            request_id: 2,
            rule: "code-light",
            matched_by: "slash",
            intent: "code",
            reasons: [
              "/code command → rule “code-light”",
              "Fallback: OpenCode Zen · big-pickle skipped (Not connected: add a key for OpenCode Zen in Connections)",
              "Free tier · Groq does not train on API data",
            ],
            skipped: [{ target: "model:code-free", label: "OpenCode Zen · big-pickle", code: "not_connected", reason: "Not connected: add a key for OpenCode Zen in Connections" }],
          }),
          created_at: T0,
        },
        { id: 5, role: "user", content: "And what about sunsets on Mars?", status: "done", private: false, feedback: null, route: null, created_at: T0 },
        {
          id: 6,
          role: "assistant",
          content: "On Mars, fine dust scatters red light during the day, and sunsets look **blue** near the sun, because the dust scatters blue light forward.",
          status: "done",
          private: false,
          feedback: null,
          route: fallback,
          created_at: T0,
        },
      ],
    },
    {
      id: "6f1c2a10-0000-4000-8000-000000000002",
      title: "Launch post for LinkedIn",
      title_source: "local",
      private: false,
      pinned: false,
      created_at: day(-1, 15),
      updated_at: day(-1, 15, 2),
      messages: [],
    },
    {
      id: "6f1c2a10-0000-4000-8000-000000000003",
      title: "Notes on my health check",
      title_source: "words",
      private: true,
      private_source: "auto",
      pinned: false,
      created_at: day(-4, 10),
      updated_at: day(-4, 10, 1),
      summary: {
        text: "- Blood test: ALT and AST slightly high; doctor wants a re-test in 6 weeks.\n- The user asked about diet; suggested less alcohol and fried food.",
        upto_message_id: 21,
        covers: 2,
        model: "ollama/qwen3:4b",
        created_at: day(-4, 10, 1),
      },
      messages: [
        { id: 20, role: "user", content: "My blood test shows ALT and AST slightly high. What could that mean?", status: "done", private: true, feedback: null, route: null, created_at: day(-4, 10) },
        {
          id: 21,
          role: "assistant",
          content: "Slightly raised ALT and AST often come from recent exercise, alcohol, some medicines or a fatty liver. Your doctor's re-test will show whether it persists.",
          status: "done",
          private: true,
          feedback: null,
          route: base(
            local({
              request_id: 7,
              matched_by: "auto_private",
              reasons: ["Looks sensitive (health) → kept on this machine", "First choice of rule “private”", "Runs on your GPU; nothing leaves the machine"],
              sensitive: { source: "classifier", category: "health", overridable: true },
            }),
          ),
          created_at: day(-4, 10),
        },
        { id: 22, role: "user", content: "Thanks. What should I eat this week?", status: "done", private: true, feedback: null, route: null, created_at: day(-4, 10, 1) },
        {
          id: 23,
          role: "assistant",
          content: "Plenty of vegetables, whole grains and lean protein; go easy on alcohol, sugar and fried food until the re-test.",
          status: "done",
          private: true,
          feedback: null,
          route: base(local({ request_id: 8, matched_by: "private", reasons: ["Private is on → stays on this machine", "First choice of rule “private”", "Runs on your GPU; nothing leaves the machine"] })),
          created_at: day(-4, 10, 1),
        },
      ],
    },
    {
      id: "6f1c2a10-0000-4000-8000-000000000004",
      title: "Trip ideas for a long weekend in Goa with friends who like quiet beaches and good seafood",
      title_source: "local",
      private: false,
      pinned: false,
      created_at: day(-20, 18),
      updated_at: day(-20, 18, 30),
      messages: [],
    },
  ];
}

function store(): Store {
  if (!g.__sbChat) g.__sbChat = { threads: seed(), nextMsg: 100, nextReq: 100, nextThread: 100, stops: new Set() };
  return g.__sbChat;
}

const ok = <T>(data: unknown): Result<T> => ({ ok: true, data: data as T });
const fail = <T>(status: number, error: string): Result<T> => ({ ok: false, status, error });
const strip = (th: FxThread): ChatThread => {
  const { messages, ...rest } = th;
  void messages;
  return rest;
};

function targets(): TargetsResponse {
  const model = (provider: string, model_id: string, tags: string[], over: Partial<TargetModel> = {}): TargetModel => ({
    target: `model:${provider}/${model_id}`,
    provider,
    model_id,
    display_name: null,
    tags,
    tag_source: "curated",
    context: 131072,
    max_output: null,
    free: true,
    paid: false,
    privacy: provider === "ollama" ? "local" : provider === "groq" ? "no-training" : "may-train",
    status: "available",
    test: null,
    ...over,
  });
  return {
    preset: "balanced",
    aliases: [
      { target: "model:fast", alias: "fast", label: "Groq · gpt-oss-120b", available: true, reason: null, local: false, free_tier: true, paid: false, privacy: "no-training" },
      { target: "model:smart-free", alias: "smart-free", label: "Google AI Studio · gemini-3.1-flash-lite", available: true, reason: null, local: false, free_tier: true, paid: false, privacy: "may-train" },
      { target: "model:general", alias: "general", label: "Mistral · mistral-small-latest", available: false, reason: "Add a key for Mistral (La Plateforme) in Connections", local: false, free_tier: false, paid: false, privacy: "may-train" },
      { target: "model:code-free", alias: "code-free", label: "OpenCode Zen · big-pickle", available: false, reason: "Add a key for OpenCode Zen in Connections", local: false, free_tier: false, paid: false, privacy: "varies" },
      { target: "model:local", alias: "local", label: "Ollama · qwen3:4b", available: true, reason: null, local: true, free_tier: true, paid: false, privacy: "local" },
      { target: "model:local-code", alias: "local-code", label: "Ollama · qwen2.5-coder:3b", available: true, reason: null, local: true, free_tier: true, paid: false, privacy: "local" },
    ],
    providers: [
      {
        provider: "gemini",
        name: "Google AI Studio (Gemini)",
        local: false,
        privacy: "may-train",
        models: [
          model("gemini", "gemini-3.1-flash-lite", ["chat", "fast", "long-context"], { context: 1048576, test: { samples: 3, error_rate: 0, p50_ms: 1297, p95_ms: 1500, last_ok: true } }),
          model("gemini", "gemini-3-flash-preview", ["chat", "reasoning", "long-context"], { context: 1048576 }),
        ],
      },
      {
        provider: "groq",
        name: "Groq",
        local: false,
        privacy: "no-training",
        models: [
          model("groq", "openai/gpt-oss-120b", ["chat", "code", "reasoning", "fast"], { test: { samples: 5, error_rate: 0, p50_ms: 338, p95_ms: 600, last_ok: true } }),
          model("groq", "openai/gpt-oss-20b", ["chat", "reasoning", "fast", "small"]),
        ],
      },
      {
        provider: "ollama",
        name: "Ollama (local)",
        local: true,
        privacy: "local",
        models: [
          model("ollama", "qwen3:4b", ["chat", "reasoning", "small"], { context: 40960 }),
          model("ollama", "qwen2.5-coder:3b", ["chat", "code", "small"], { context: 32768 }),
          model("ollama", "llama3.2:3b", ["chat", "small"], { context: 131072 }),
        ],
      },
    ],
  };
}

export function handle<T>(method: string, path: string, body: unknown): Result<T> {
  const s = store();
  const p = new URL(path, "http://fixture").pathname;
  const b = (body ?? {}) as Record<string, unknown>;
  if (method === "GET" && p === "/chat/threads") {
    // Same contract as the router: keyset pages (cursor = "<updated_at>_<id>"), pinned apart, title search.
    const url = new URL(path, "http://fixture");
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 30) || 30));
    const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
    const cursor = url.searchParams.get("cursor");
    const newest = (a: FxThread, z: FxThread) => z.updated_at.localeCompare(a.updated_at) || z.id.localeCompare(a.id);
    let rows = [...s.threads].filter((x) => (q ? x.title.toLowerCase().includes(q) : !x.pinned)).sort(newest);
    if (cursor) rows = rows.filter((x) => `${x.updated_at}_${x.id}` < cursor);
    const page = rows.slice(0, limit);
    const pinned = !q && !cursor ? s.threads.filter((x) => x.pinned).sort(newest).slice(0, 50) : [];
    const last = rows.length > limit ? page.at(-1) : null;
    return ok({ pinned: pinned.map(strip), threads: page.map(strip), next_cursor: last ? `${last.updated_at}_${last.id}` : null });
  }
  if (method === "DELETE" && p === "/chat/threads") {
    if (b.confirm !== "delete all chats") return fail(422, "confirm with the phrase");
    const n = s.threads.length;
    s.threads = [];
    return ok({ deleted: n });
  }
  if (method === "GET" && p === "/chat/export") {
    const url = new URL(path, "http://fixture");
    const all = url.searchParams.get("include_private") === "true";
    const list = s.threads.filter((x) => all || !x.private);
    if (url.searchParams.get("format") === "md") {
      const md = ["# Switchboard chats", ""];
      for (const th of list) {
        md.push(`## ${th.title || "New chat"}`, "");
        for (const msg of th.messages) md.push(msg.role === "user" ? "**You**" : "**Assistant**", "", msg.content, "");
      }
      return ok({ markdown: md.join("\n") });
    }
    return ok({ format: "switchboard.chats.v1", threads: list });
  }
  if (method === "GET" && p === "/chat/targets") return ok(targets());
  let m = p.match(/^\/chat\/threads\/([\w-]+)$/);
  if (m) {
    const t = s.threads.find((x) => x.id === m![1]);
    if (!t) return fail(404, "thread not found");
    if (method === "GET") return ok({ thread: strip(t), messages: t.messages });
    if (method === "PATCH") {
      if (typeof b.title === "string") Object.assign(t, { title: b.title.slice(0, 80), title_source: "user" });
      if (typeof b.pinned === "boolean") t.pinned = b.pinned;
      return ok(strip(t));
    }
    if (method === "DELETE") {
      s.threads = s.threads.filter((x) => x !== t);
      return ok({ deleted: t.id });
    }
  }
  m = p.match(/^\/chat\/messages\/(\d+)\/feedback$/);
  if (m && method === "POST") {
    const msg = s.threads.flatMap((t) => t.messages).find((x) => x.id === Number(m![1]));
    if (!msg || msg.role !== "assistant") return fail(404, "reply not found");
    msg.feedback = (b.value as "up" | "down" | null) ?? null;
    return ok({ message_id: msg.id, feedback: msg.feedback });
  }
  m = p.match(/^\/chat\/requests\/(\d+)\/stop$/);
  if (m && method === "POST") {
    s.stops.add(Number(m[1]));
    return ok({ stopped: true });
  }
  return fail(404, `fixture: no route for ${method} ${p}`);
}

// --- streaming --------------------------------------------------------------------------------
type Ev = [string, Record<string, unknown>] | ["wait", number];

function words(text: string): string[] {
  return text.match(/\S+\s*|\s+/g) ?? [];
}

function scenario(
  text: string,
  priv: boolean,
  target: string,
  extra: { secret?: boolean; noAuto?: boolean; think?: boolean } = {},
): { route: RouteInfo; events: Ev[]; content: string; status: ChatMessage["status"] } {
  const lower = text.toLowerCase();
  const ev: Ev = ["route", { target: "model:local", label: "Ollama · qwen3:4b", local: true, free_tier: true }];
  if (extra.secret) {
    const route = base(
      local({
        matched_by: "secret",
        reasons: ["Contains a secret (masked) → kept on this machine", "First choice of rule “private”", "Runs on your GPU; nothing leaves the machine"],
        sensitive: { source: "secret", category: "secret", overridable: false },
      }),
    );
    return { route, content: "That key is now in this chat's history on your computer only. Rotate it in the provider's console to be safe.", status: "done", events: [ev] };
  }
  if (!priv && !extra.noAuto && lower.includes("blood test")) {
    const route = base(
      local({
        matched_by: "auto_private",
        reasons: ["Looks sensitive (health) → kept on this machine", "First choice of rule “private”", "Runs on your GPU; nothing leaves the machine"],
        sensitive: { source: "classifier", category: "health", overridable: true },
      }),
    );
    return { route, content: "Slightly raised liver values are common and often harmless; your doctor's re-test will tell.", status: "done", events: [ev] };
  }
  if (priv || lower.startsWith("/private")) {
    const content = "Noted. This stays on your computer: nothing was sent to a cloud model.";
    // M4a (ADR 0006): local answers come from a model that doesn't think first; "Think harder" picks the
    // profile's thinking model for that one message.
    const think = !!extra.think;
    const label = think ? "Ollama · qwen3:4b" : "Ollama · qwen3:4b-instruct-2507-q4_K_M";
    const route = base({
      rule: "private",
      matched_by: "private",
      private: true,
      target: "model:local",
      label,
      local: true,
      model: think ? "ollama_chat/qwen3:4b" : "ollama_chat/qwen3:4b-instruct-2507-q4_K_M",
      provider: "ollama",
      provider_name: "Ollama (local)",
      reasons: ["Private is on → stays on this machine", "First choice of rule “private”", "Runs on your GPU; nothing leaves the machine"],
      runner_up: null,
      skipped: target !== "auto" && !target.includes("local") ? [{ target, label: target.replace("model:", ""), code: "private", reason: "Private is on: your pick was not used" }] : [],
      list_price_usd: null,
      thinking_ms: think ? 2400 : null,
      latency_ms: think ? 4100 : 900,
      ttft_ms: think ? 3900 : 200,
    });
    const thought: Ev[] = think
      ? ["The user wants a private note. ", "Keep it short and confirm it stays local. "].flatMap((x) => [["thinking", { text: x }], ["wait", 300]] as Ev[])
      : [];
    return { route, content, status: "done", events: [["route", { target: "model:local", label, local: true, free_tier: true }], ...thought] };
  }
  if (lower.includes("budget")) {
    const blocked = { code: "budget_daily", reason: "Daily budget $1.00 reached ($1.02 spent today)", daily_cap_usd: 1, max_cost_usd: 0.5, spent_today: 1.02 } as const;
    const route = base({ rule: "manual", matched_by: "manual", target: null, label: null, reasons: [], skipped: [{ target: "model:general", label: "Mistral · mistral-small-latest", code: "budget_daily", reason: blocked.reason }], blocked, model: undefined, tokens_in: undefined, tokens_out: undefined, cost_usd: undefined, latency_ms: undefined });
    return { route, content: "", status: "blocked", events: [["blocked", { ...blocked }]] };
  }
  const media = lower.startsWith("/video") || /make a video/.test(lower) ? "video" : lower.startsWith("/image") || /make an image/.test(lower) ? "image" : null;
  if (media) {
    const route = base({ rule: media, matched_by: lower.startsWith("/") ? "slash" : "intent", intent: media, target: null, label: null, reasons: [], skipped: [], notice: media, model: undefined, tokens_in: undefined, tokens_out: undefined, cost_usd: undefined, latency_ms: undefined });
    return { route, content: "", status: "notice", events: [["notice", { kind: media }]] };
  }
  const job = /failing tests|\/research|research /.test(lower);
  const code = /code|python|function|tests/.test(lower);
  const rate = lower.includes("rate limit");
  let route = base({});
  const events: Ev[] = [["route", { target: "model:fast", label: "Groq · gpt-oss-120b", local: false, free_tier: true }]];
  if (rate) {
    events.push(["wait", 250], ["fallback", { target: "model:fast", label: "Groq · gpt-oss-120b", code: "rate_limited", reason: "Rate limited (429)", next: "Google AI Studio · gemini-3.1-flash-lite" }]);
    events.push(["route", { target: "model:smart-free", label: "Google AI Studio · gemini-3.1-flash-lite", local: false, free_tier: true }]);
    route = seed()[0].messages[5].route!;
  } else {
    events.push(["thinking", { text: "Short answer, with an example." }]);
  }
  if (job) {
    route = base({
      rule: lower.includes("tests") ? "code-heavy" : "research",
      matched_by: lower.startsWith("/") ? "slash" : "intent",
      intent: lower.includes("tests") ? "code" : "research",
      job_suggested: true,
      reasons: ["Looks like code (“failing tests”) → rule “code-heavy”", "Fallback: Claude Code skipped (Claude Code works as a job: start it with Run as job)", "Free tier · Groq does not train on API data"],
      skipped: [{ target: "agent:claude-code", label: "Claude Code", code: "agent", reason: "Claude Code works as a job: start it with Run as job" }],
    });
  } else if (code && !rate) {
    route = base({ rule: "code-light", matched_by: lower.startsWith("/") ? "slash" : "intent", intent: "code" });
  }
  if (target !== "auto" && !rate) {
    route = { ...route, rule: "manual", matched_by: "manual", reasons: ["You picked this model", `${route.label} answered directly (no fallbacks for a manual pick)`, route.reasons[2]], runner_up: null, skipped: [] };
  }
  const content = job
    ? "I can't run your test suite from chat yet, but here is how to approach it:\n\n1. Run the tests and copy the first failure.\n2. Paste the error here and I'll suggest a fix.\n\nOnce Jobs arrive, an agent can do this for you in a sandbox."
    : code
      ? CODE
      : SKY;
  return { route, content, status: "done", events };
}

export function stream(path: string, body: unknown, signal: AbortSignal): Response {
  const s = store();
  const b = (body ?? {}) as { thread_id?: string | null; text?: string; target?: string; private?: boolean; cloud_override?: boolean; think?: boolean };
  const enc = new TextEncoder();
  let thread: FxThread | undefined;
  let text = String(b.text ?? "");
  const m = path.match(/^\/chat\/threads\/([\w-]+)\/(regenerate|edit-last)$/);
  if (path === "/chat/send") {
    thread = b.thread_id ? s.threads.find((x) => x.id === b.thread_id) : undefined;
    if (b.thread_id && !thread) return Response.json({ error: "thread not found" }, { status: 404 });
    if (!thread) {
      const n = s.nextThread++; // monotonic: deleting a thread must never let a new one reuse its id
      thread = {
        id: `6f1c2a10-0000-4000-8000-${String(n).padStart(12, "0")}`,
        title: "",
        title_source: "none",
        private: !!b.private,
        pinned: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        messages: [],
      };
      s.threads.push(thread);
    }
    const secret = SECRET.test(text);
    SECRET.lastIndex = 0;
    const stored = secret ? text.replace(SECRET, "[secret masked: API key]") : text;
    thread.messages.push({
      id: s.nextMsg++,
      role: "user",
      content: stored,
      status: "done",
      private: !!b.private || secret,
      feedback: null,
      route: null,
      secret: secret ? { kinds: ["api_key"] } : null,
      created_at: new Date().toISOString(),
    });
    if (secret) Object.assign(thread, { private: true, private_source: "secret" });
    text = stored; // the raw secret is never kept (title, history)
  } else if (m) {
    thread = s.threads.find((x) => x.id === m[1]);
    if (!thread) return Response.json({ error: "thread not found" }, { status: 404 });
    const users = thread.messages.filter((x) => x.role === "user");
    const last = users.at(-1);
    if (!last) return Response.json({ error: "nothing to regenerate yet" }, { status: 409 });
    if (m[2] === "edit-last") last.content = text;
    text = last.content;
    thread.messages = thread.messages.filter((x) => x.id <= last.id);
    if (b.cloud_override) {
      if (thread.private_source !== "auto") return Response.json({ error: "only a thread that auto-detection made private can be switched to the cloud" }, { status: 409 });
      Object.assign(thread, { private: false, private_source: null });
      for (const x of thread.messages) x.private = false;
    }
  } else {
    return new Response("not found", { status: 404 });
  }
  const lastUser = thread.messages.filter((x) => x.role === "user").at(-1);
  const secret = !!lastUser?.secret;
  const priv = !!b.private || thread.private || text.toLowerCase().startsWith("/private");
  const sc = scenario(text, priv && !secret, b.target ?? "auto", { secret, noAuto: !!b.cloud_override, think: !!b.think });
  const privNow = priv || secret || sc.route.private;
  if (privNow && !thread.private) Object.assign(thread, { private: true, private_source: sc.route.matched_by === "auto_private" ? "auto" : "user" });
  const requestId = s.nextReq++;
  const reply: ChatMessage = { id: s.nextMsg++, role: "assistant", content: "", status: "streaming", private: privNow, feedback: null, route: null, created_at: new Date().toISOString() };
  thread.messages.push(reply);
  const firstTurn = thread.title_source === "none";
  if (firstTurn) Object.assign(thread, { title: text.replace(/^\/\w+\s*/, "").split(/\s+/).slice(0, 6).join(" "), title_source: "words" });
  thread.updated_at = new Date().toISOString();
  const t = thread;

  const body2 = new ReadableStream({
    async start(c) {
      const send = (event: string, data: unknown) => {
        try {
          c.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          /* the client went away (Stop); the reply is still saved as stopped */
        }
      };
      const stopped = () => signal.aborted || s.stops.has(requestId);
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const masked = secret && lastUser ? { user_text: lastUser.content, secret: lastUser.secret } : {};
      send("start", { thread_id: t.id, user_message_id: reply.id - 1, message_id: reply.id, request_id: requestId, private: privNow, title: t.title, rule: sc.route.rule, job_suggested: sc.route.job_suggested, ...masked });
      for (const ev of sc.events) {
        const [name, arg] = ev;
        if (typeof arg === "number") await wait(arg);
        else send(name, arg);
      }
      let status = sc.status;
      if (sc.status === "done") {
        for (const w of words(sc.content)) {
          if (stopped()) {
            status = "stopped";
            break;
          }
          await wait(35);
          reply.content += w;
          send("delta", { text: w });
        }
      }
      reply.content = reply.content.trim();
      reply.status = status;
      reply.route = { ...sc.route, request_id: requestId };
      send("done", { message_id: reply.id, status, content: reply.content, route: reply.route });
      if (firstTurn && status === "done") {
        await wait(150);
        const title = sc.route.job_suggested ? "Fixing failing tests" : sc.route.private ? "Private note" : "A quick answer";
        Object.assign(t, { title, title_source: "local" });
        send("title", { thread_id: t.id, title, source: "local" });
      }
      try {
        c.close();
      } catch {
        /* already closed */
      }
    },
  });
  return new Response(body2, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform" } });
}

import "server-only";
import type {
  CatalogModel,
  ComponentsResponse,
  ConnectionRow,
  SettingsView,
  SystemComponent,
  InstallPlan,
  OnboardingResponse,
  OnboardingState,
  LocalProfile,
  LocalProfileView,
} from "../router-types";
import type { Result } from "./router";

/**
 * A tiny in-memory stand-in for the Router API (PORTAL_DATA=fixture). It exists so axe, visual
 * baselines, screenshots and the bundle test run without the Docker stack or any real key.
 * State lives on globalThis so it survives route-module reloads; restarting the server resets it.
 * Nothing here looks like a real credential.
 */

const ok = <T>(data: unknown): Result<T> => ({ ok: true, data: data as T });
const fail = <T>(status: number, error: string, code?: string, detail?: string): Result<T> => ({ ok: false, status, error, code, detail: detail ?? null });

const api = (
  provider: string,
  name: string,
  over: Partial<ConnectionRow> = {},
): ConnectionRow => ({
  provider,
  name,
  kind: "api_key",
  privacy: "no-training",
  paid: false,
  free_limits: null,
  notes: null,
  status: "no_key",
  last_checked: null,
  last_error: null,
  key_last4: null,
  models_available: 0,
  ...over,
});

const cli = (provider: string, name: string, login_hint: string, over: Partial<ConnectionRow> = {}): ConnectionRow => ({
  provider,
  name,
  kind: "cli",
  privacy: "varies",
  paid: false,
  free_limits: null,
  notes: null,
  status: "not_installed",
  last_checked: null,
  last_error: null,
  installed: false,
  version: null,
  logged_in: null,
  windows_only: false,
  login_method: null,
  login_hint,
  ...over,
});

const model = (provider: string, model_id: string, tags: string[], context: number | null, over: Partial<CatalogModel> = {}): CatalogModel => ({
  provider,
  model_id,
  display_name: null,
  tags,
  tag_source: tags.length ? "curated" : "none",
  context,
  max_output: null,
  free: true,
  privacy: "no-training",
  status: "available",
  test: null,
  ...over,
});

const connections = (): ConnectionRow[] => [
  api("groq", "Groq", {
    status: "connected",
    key_last4: "1234",
    models_available: 4,
    free_limits: "~30 req/min, 1k–14.4k req/day per model",
    notes: "Groq states no training on API data.",
    last_checked: "2026-11-17T08:00:00Z",
  }),
  api("gemini", "Google AI Studio (Gemini)", {
    status: "error",
    key_last4: "5678",
    models_available: 4,
    privacy: "may-train",
    free_limits: "Flash: ~10 req/min, ~250 req/day; Flash-Lite higher",
    notes: "Free tier may train on data outside EEA/UK/CH.",
    last_error: "Test call timed out after 30 s.",
    last_error_code: "timeout",
    last_checked: "2026-11-17T08:00:00Z",
  }),
  api("cerebras", "Cerebras", {
    free_limits: "One-time free credits (no renewing free tier); enter your starting balance",
    notes: "Credits run out. The card shows what is left; routing stops at $0.",
    credits: { starting_usd: null },
  }),
  api("mistral", "Mistral (La Plateforme)", {
    paid: true,
    privacy: "may-train",
    free_limits: "None: the free plan cannot activate API keys (paid plan required)",
    notes: "Paid plan required. Hidden from the free presets and the wizard. May train on data unless opted out.",
  }),
  api("openrouter", "OpenRouter", { privacy: "varies", free_limits: "`:free` models: 20 req/min, 50 req/day" }),
  api("opencode-zen", "OpenCode Zen", { privacy: "varies", free_limits: "Rotating free models; limits per model" }),
  api("xai", "xAI (Grok API)", {
    paid: true,
    privacy: "varies",
    free_limits: "Paid, pay per token / image / second. No free tier.",
    notes: "Optional. Text, plus Imagine image and video generation (M5).",
  }),
  {
    ...api("ollama", "Ollama (local)", {
      kind: "local",
      privacy: "local",
      status: "connected",
      models_available: 3,
      free_limits: "Unlimited (your GPU: ≤ ~4B params at Q4)",
      last_checked: "2026-11-17T08:00:00Z",
    }),
    key_last4: undefined,
  },
  cli("claude-code", "Claude Code", "claude  (then /login in the browser)", {
    paid: true,
    status: "windows_only",
    windows_only: true,
    notes: "Claude Pro subscription; official CLI only.",
  }),
  cli("codex", "Codex CLI", "codex login", {
    status: "logged_in",
    installed: true,
    version: "0.169.0",
    logged_in: true,
    login_method: "codex login status",
    bin_path: "~/.local/bin/codex",
    bin_dir: "~/.local/bin",
    on_user_path: true,
  }),
  cli("gemini-cli", "Gemini CLI", "gemini  (choose Use Gemini API key, not Google sign-in; create a key at aistudio.google.com/apikey)", {
    notes: "Google sign-in no longer works for individuals. Shares the Gemini API free quota with smart-free, so CLI use eats into it.",
    privacy: "may-train",
    status: "logged_out",
    installed: true,
    version: "0.68.0",
    logged_in: false,
    login_method: "credential file present (stat only)",
    bin_path: "~/.nvm/versions/node/v24.22.3/bin/gemini",
    bin_dir: "~/.nvm/versions/node/v24.22.3/bin",
    on_user_path: true,
  }),
  cli("grok-build", "Grok Build", "grok auth login", {
    paid: true,
    notes: "Beta. Headless use may bill an xAI API key. Verify before routing jobs (SPEC §12).",
  }),
  cli("opencode", "OpenCode", "opencode auth login"),
];

const catalog = (): CatalogModel[] => [
  model("groq", "openai/gpt-oss-120b", ["chat", "code", "reasoning", "fast"], 131072, { display_name: "GPT-OSS 120B", test: { samples: 3, error_rate: 0, p50_ms: 420, p95_ms: 610, last_ok: true } }),
  model("groq", "openai/gpt-oss-20b", ["chat", "reasoning", "fast", "small"], 131072, { display_name: "GPT-OSS 20B" }),
  model("groq", "llama-3.3-70b-versatile", ["chat"], 131072, { display_name: "Llama 3.3 70B" }),
  model("groq", "whisper-large-v3", ["audio"], null, { display_name: "Whisper Large v3" }),
  model("gemini", "gemini-3.5-flash", ["chat", "vision", "long-context", "fast"], 1048576, { privacy: "may-train", display_name: "Gemini 3.5 Flash" }),
  model("gemini", "gemini-3.5-pro", ["chat", "code", "reasoning", "vision", "long-context"], 2097152, { privacy: "may-train", display_name: "Gemini 3.5 Pro" }),
  model("gemini", "gemini-3.5-flash-lite", ["chat", "long-context", "fast", "small"], 1048576, { privacy: "may-train", display_name: "Gemini 3.5 Flash-Lite" }),
  model("gemini", "gemini-experimental-x", [], 32768, { privacy: "may-train" }),
  model("ollama", "qwen3:4b", ["chat", "reasoning"], 40960, { privacy: "local", display_name: "Qwen3 4B" }),
  model("ollama", "qwen2.5-coder:3b", ["chat", "code"], 32768, { privacy: "local", display_name: "Qwen2.5 Coder 3B" }),
  model("ollama", "llama3.2:3b", ["chat", "fast", "small"], 131072, { privacy: "local", display_name: "Llama 3.2 3B" }),
];

interface Job {
  cli: string;
  planId: string;
  cancelled: boolean;
}

interface Store {
  rows: ConnectionRow[];
  catalog: CatalogModel[];
  onboarding: OnboardingState | null;
  plans: Map<string, string>;
  jobs: Map<string, Job>;
  settings: Partial<SettingsView>;
  localProfile?: string;
}

const g = globalThis as unknown as { __sbFixture?: Store };

const ARCH = "hf.co/katanemo/Arch-Router-1.5B.gguf:Q4_K_M";
const LOCAL_PROFILES: LocalProfile[] = [
  { name: "none", label: "CPU only / under 4 GB", min_vram_gb: 0, classifier: null, general: "llama3.2:3b", tasks: null, coder: "llama3.2:3b", cpu: true, max_loaded: 1, models: ["llama3.2:3b"] },
  { name: "small", label: "4–6 GB GPU", min_vram_gb: 4, classifier: ARCH, general: "qwen3:4b", tasks: "llama3.2:3b", coder: "qwen3:4b", cpu: false, max_loaded: 2, models: [ARCH, "qwen3:4b", "llama3.2:3b"] },
  { name: "medium", label: "8–12 GB GPU", min_vram_gb: 8, classifier: ARCH, general: "qwen3:8b", tasks: "llama3.2:3b", coder: "qwen3:8b", cpu: false, max_loaded: 2, models: [ARCH, "qwen3:8b", "llama3.2:3b"] },
  { name: "large", label: "16 GB+ GPU", min_vram_gb: 16, classifier: ARCH, general: "qwen3:14b", tasks: "llama3.2:3b", coder: "qwen2.5-coder:14b", cpu: false, max_loaded: 2, models: [ARCH, "qwen3:14b", "llama3.2:3b", "qwen2.5-coder:14b"] },
];
const INSTALLED = ["qwen3:4b", "llama3.2:3b", ARCH];

function localProfile(active: string): LocalProfileView {
  const prof = LOCAL_PROFILES.find((x) => x.name === active) ?? LOCAL_PROFILES[1];
  return {
    active: prof.name,
    recommended: "small",
    overridden: prof.name !== "small",
    detected: { vram_gb: 4, ram_gb: 13.6, gpu: "NVIDIA GeForce RTX 3050 Laptop GPU", source: "nvidia-smi" },
    profiles: LOCAL_PROFILES,
    installed: INSTALLED,
    missing: prof.models.filter((x) => !INSTALLED.includes(x)),
    ollama: "ok",
    pull: { status: "idle", model: null, percent: null, error: null },
    // M2.5: the small profile's vision model, not pulled in the fixture (shows the Pull button)
    vision: prof.name === "none" ? null : prof.name === "small" ? "qwen3-vl:2b" : "gemma3:4b",
    vision_installed: prof.name === "none" ? null : false,
  };
}

/** Status view fixture: Ollama is down (an instruction, not an in-app fix); Paperclip runs with its
 * "no login (local only)" note and a passing loopback check (M4b); a provider whose registration failed
 * shows "Resync models". */
function components(s: Store): ComponentsResponse {
  const comps: SystemComponent[] = [
    { id: "router", status: "ok", fix: null, detail: null },
    { id: "database", status: "ok", fix: null, detail: null },
    { id: "litellm", status: "ok", fix: null, detail: null },
    { id: "model_sync", status: "ok", fix: null, detail: null, last_ok_at: "2026-11-17T09:00:00Z" },
    { id: "ollama", status: "down", fix: "open_ollama", detail: "ConnectError" },
    {
      id: "paperclip",
      status: "ok",
      fix: null,
      detail: "No login (local only): any program on this computer can use Paperclip",
      notes: { auth: "local_trusted", exposure: "private", version: "2026.1106.0", pinned: "2026.1106.0", loopback: { checked: true, ok: true, addresses: ["127.0.0.1"], port: 3100 } },
    },
    { id: "hostprobe", status: "ok", fix: "recheck_cli", detail: null },
    // M3a
    { id: "local_profile", status: "ok", fix: null, detail: null, profile: "small", label: "4–6 GB GPU", vram_gb: 4, missing: [], overridden: false },
    { id: "classifier", status: "ok", fix: null, detail: null, code: null },
    // M6.5: the Metrics rollup worker and one subscription account near its window
    { id: "rollups", status: "ok", fix: null, detail: null, state: "ok", pending_buckets: 0, last_run_at: "2026-11-18T12:00:00Z" },
    {
      id: "subscription:claude:default",
      name: "Claude Pro",
      account: "default",
      status: "ok",
      fix: null,
      detail: null,
      until: "2026-11-18T14:20:00Z",
      window: { window: "five_hour", label: "5-hour", hours: 5, used: 0.7, resets_at: "2026-11-18T14:20:00Z", limited: false, source: "reported", runs: 0, seen_at: "2026-11-18T11:30:00Z" },
    },
    {
      id: "provider:openrouter",
      name: "OpenRouter",
      status: "degraded",
      fix: null,
      detail: "Rate limited (429)",
      code: "rate_limited",
      until: "2026-11-18T14:05:00Z",
    },
    {
      id: "provider:groq",
      name: "Groq",
      status: "degraded",
      fix: null,
      detail: null,
      code: "quota_high",
      until: "2026-11-19T00:00:00Z",
      quota: { provider: "groq", name: "Groq", model: "openai/gpt-oss-120b", fraction: 0.82, window: "day", kind: "requests", used: 820, limit: 1000, resets_at: "2026-11-19T00:00:00Z", source: "counter", estimate: false },
    },
  ];
  for (const r of s.rows) {
    if (r.sync_error) comps.push({ id: `provider:${r.provider}`, name: r.name, status: "down", fix: "resync", detail: r.sync_error, code: "gateway_sync" });
    else if (r.status === "error") comps.push({ id: `provider:${r.provider}`, name: r.name, status: "down", fix: `retest:${r.provider}`, detail: r.last_error, code: r.last_error_code ?? null });
  }
  const status = comps.some((c) => c.status === "down") ? "down" : comps.some((c) => c.status === "degraded") ? "degraded" : "ok";
  return { status, components: comps };
}

function store(): Store {
  if (!g.__sbFixture) {
    const done = process.env.PORTAL_FIXTURE_ONBOARDING !== "none";
    g.__sbFixture = {
      rows: connections(),
      catalog: catalog(),
      onboarding: done
        ? { step: "finish", name: "Sam", goals: ["chat", "code"], preset: "balanced", skipped: false, completed_at: "2026-11-17T08:00:00Z" }
        : null,
      plans: new Map(),
      jobs: new Map(),
      settings: {},
    };
  }
  return g.__sbFixture;
}

const GOALS: OnboardingResponse["goals"] = {
  chat: [{ provider: "groq", paid: false }, { provider: "cerebras", paid: false }],
  writing: [{ provider: "gemini", paid: false }, { provider: "openrouter", paid: false }],
  code: [
    { provider: "claude-code", paid: true },
    { provider: "codex", paid: false },
    { provider: "grok-build", paid: true },
    { provider: "opencode", paid: false },
    { provider: "opencode-zen", paid: false },
  ],
  research: [{ provider: "gemini", paid: false }],
  images: [{ provider: "gemini", paid: false }, { provider: "xai", paid: true }],
  video: [{ provider: "xai", paid: true }],
  private: [{ provider: "ollama", paid: false }],
};

const SOURCES: Record<string, { source: string; docs: string; version: string; commands: string[]; env?: Record<string, string>; effects: string[]; npm?: boolean }> = {
  claude: {
    source: "https://claude.ai/install.sh",
    docs: "https://code.claude.com/docs/en/setup",
    version: "2.1.311",
    commands: ["download https://claude.ai/install.sh (sha256 0123456789abcdef…, 9704 bytes)", "bash install.sh 2.1.311"],
    effects: ["Installs the claude binary under ~/.local/bin and data under ~/.claude. Version: stable channel."],
  },
  codex: {
    source: "https://chatgpt.com/codex/install.sh",
    docs: "https://developers.openai.com/codex/cli",
    version: "0.169.0",
    commands: ["download https://chatgpt.com/codex/install.sh (sha256 0123456789abcdef…, 43647 bytes)", "CODEX_RELEASE=0.169.0 CODEX_NON_INTERACTIVE=1 sh install.sh"],
    env: { CODEX_RELEASE: "0.169.0", CODEX_NON_INTERACTIVE: "1" },
    effects: ["Installs codex under ~/.local/bin and data under ~/.codex.", "May add a PATH line to your shell profile (~/.bashrc or ~/.profile)."],
  },
  gemini: {
    source: "https://www.npmjs.com/package/@google/gemini-cli",
    docs: "https://github.com/google-gemini/gemini-cli",
    version: "0.68.0",
    commands: ["npm install -g @google/gemini-cli@0.68.0"],
    effects: ["Installs the gemini command into your Node (nvm) global prefix. Needs Node 20 or newer."],
    npm: true,
  },
  grok: {
    source: "https://x.ai/cli/install.sh",
    docs: "https://x.ai/cli",
    version: "1.0.88",
    commands: ["download https://x.ai/cli/install.sh (sha256 0123456789abcdef…, 30506 bytes)", "bash install.sh 1.0.88"],
    effects: ["Installs grok under ~/.grok/bin.", "May add a PATH line to your shell profile (~/.bashrc).", "Beta. A SuperGrok subscription or xAI API key is needed to log in."],
  },
  opencode: {
    source: "https://opencode.ai/install",
    docs: "https://opencode.ai/docs",
    version: "1.19.6",
    commands: ["download https://opencode.ai/install (sha256 0123456789abcdef…, 15443 bytes)", "bash install.sh --version 1.19.6 --no-modify-path"],
    effects: ["Installs opencode under ~/.opencode/bin. Your shell profile is not changed."],
  },
};

const BIN: Record<string, string> = { "claude-code": "claude", codex: "codex", "gemini-cli": "gemini", "grok-build": "grok", opencode: "opencode" };

function latency(id: string) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 900;
  return 280 + h;
}

function cliBody(s: Store) {
  const rows = Object.fromEntries(s.rows.filter((r) => r.kind === "cli").map((r) => [r.provider, r]));
  return { hostprobe: "up", error: null, clis: rows };
}

export function handle<T>(method: string, path: string, body: unknown): Result<T> {
  const s = store();
  const url = new URL(path, "http://fixture");
  const p = url.pathname;
  const b = (body ?? {}) as Record<string, unknown>;
  const row = (id: string) => s.rows.find((r) => r.provider === id);

  if (method === "GET" && p === "/connections") return ok({ providers: s.rows, hostprobe: "up" });
  if (method === "GET" && p === "/catalog") {
    const provider = url.searchParams.get("provider");
    return ok({ count: 0, models: s.catalog.filter((m) => !provider || m.provider === provider) });
  }
  if (method === "GET" && p === "/onboarding") return ok({ state: s.onboarding, goals: GOALS });
  if (method === "PUT" && p === "/onboarding") {
    const { completed, ...rest } = b as Record<string, unknown> & { completed?: boolean };
    const cur: OnboardingState = s.onboarding ?? { step: "welcome", name: "", goals: [], preset: null, skipped: false, completed_at: null };
    const next = { ...cur, ...rest } as OnboardingState;
    if (completed === true) Object.assign(next, { completed_at: new Date().toISOString(), skipped: false });
    s.onboarding = next;
    return ok({ state: next });
  }

  let m = p.match(/^\/connections\/([\w-]+)\/key$/);
  if (m && (method === "PUT" || method === "DELETE")) {
    const r = row(m[1]);
    if (!r || r.kind !== "api_key") return fail(404, `unknown provider ${m[1]}`);
    if (method === "DELETE") {
      Object.assign(r, { status: "no_key", key_last4: null, last_error: null, models_available: 0 });
      return ok({ provider: r.provider, removed: true, status: "no_key" });
    }
    const key = String(b.api_key ?? "").trim();
    if (key.length < 8) return fail(422, "String should have at least 8 characters");
    if (key.toLowerCase().startsWith("bad"))
      return fail(400, "The provider did not accept this key.", "key_rejected", "key test failed: the provider rejected this key (HTTP 401)");
    if (key.toLowerCase().startsWith("gateway")) {
      // The key is stored, but LiteLLM registration fails: the card offers "Retry sync" (M1.5).
      const detail = "LiteLLM POST /model/new -> 500: {'error': 'Failed to add model to db.'}";
      Object.assign(r, { status: "connected", key_last4: key.slice(-4), last_error: null, sync_error: detail });
      return fail(502, "Key saved. Couldn't sync with the model gateway; retrying automatically.", "gateway_sync", detail);
    }
    const count = s.catalog.filter((x) => x.provider === r.provider).length;
    Object.assign(r, { status: "connected", key_last4: key.slice(-4), last_error: null, models_available: count || 3 });
    return ok({ provider: r.provider, status: "connected", key_last4: key.slice(-4) });
  }
  m = p.match(/^\/connections\/([\w-]+)\/resync$/);
  if (m && method === "POST") {
    const r = row(m[1]);
    if (!r) return fail(404, `unknown provider ${m[1]}`);
    delete r.sync_error;
    return ok({ provider: r.provider, ok: true });
  }
  if (method === "POST" && p === "/system/resync") {
    for (const r of s.rows) delete r.sync_error;
    return ok({ ok: true });
  }
  if (method === "GET" && p === "/system/components") return ok(components(s));
  if (method === "POST" && p === "/system/rollups/run") return ok({ recomputed: 0, state: "ok", pending_buckets: 0 });
  if (p === "/system/local-profile" && (method === "GET" || method === "PUT")) {
    if (method === "PUT") {
      const name = (b as { profile?: string | null }).profile ?? null;
      if (name !== null && !LOCAL_PROFILES.some((x) => x.name === name)) return fail(400, "unknown profile");
      s.localProfile = name ?? "small";
    }
    return ok(localProfile(s.localProfile ?? "small"));
  }
  if (method === "POST" && p === "/system/models/pull") return ok({ started: false, missing: [], pull: { status: "idle" } });
  if (p === "/settings" && (method === "GET" || method === "PUT")) {
    const defaults = { max_cost_usd: 0.5, daily_cap_usd: 1, private_by_default: false, explore: false, auto_private: true, approval_expiry_h: 24, keep_worktrees_per_project: 10 };
    if (method === "PUT") {
      for (const [k, v] of Object.entries(b)) {
        if (!(k in defaults)) continue;
        if (typeof v === "number" && (v < 0 || v > (k === "approval_expiry_h" ? 720 : 100))) return fail(422, "Input is out of range");
        if (v === null) delete s.settings[k as keyof SettingsView];
        else (s.settings as Record<string, unknown>)[k] = v;
      }
    }
    return ok({ ...defaults, ...s.settings, defaults, overridden: Object.keys(s.settings).sort() });
  }
  if (method === "GET" && p === "/system/summary")
    return ok({
      health: { router: "ok", litellm: "ok", ollama: "down", paperclip: "ok", model_sync: "ok" },
      spend_today_usd: 0.0123,
      value_saved_usd: 0.0841,
      // Groq at 31% stays under the footer's 50% threshold (visual baselines keep "Quota OK").
      quota: {
        status: "ok",
        daily_cap_usd: 1,
        daily_cap_used: 0.012,
        cooling_down: [],
        credits_low: [],
        credits_out: [],
        providers: [{ provider: "groq", name: "Groq", model: "openai/gpt-oss-120b", fraction: 0.31, window: "day", kind: "requests", used: 310, limit: 1000, resets_at: null, source: "counter", estimate: false }],
        top: null,
      },
      version: "0.9.0", // PROJECT_VERSION: scripts/check-docs.mjs keeps this equal to the root VERSION file
    });
  m = p.match(/^\/connections\/([\w-]+)\/credits$/);
  if (m && method === "PUT") {
    const r = row(m[1]);
    if (!r || !r.credits) return fail(400, `${m[1]} does not use credits`);
    const start = Number(b.starting_usd);
    if (!Number.isFinite(start) || start < 0) return fail(422, "Input should be greater than or equal to 0");
    r.credits = { starting_usd: start, spent_usd: 0, remaining_usd: start, exhausted: start <= 0 };
    return ok({ provider: r.provider, credits: r.credits });
  }
  m = p.match(/^\/connections\/([\w-]+)\/test$/);
  if (m && method === "POST") {
    const r = row(m[1]);
    if (!r) return fail(404, `unknown provider ${m[1]}`);
    if (r.kind === "api_key" && !r.key_last4) return fail(400, `no key stored for ${r.provider}`);
    if (r.provider === "gemini") return ok({ provider: r.provider, ok: false, error: "Test call timed out after 30 s.", error_code: "timeout" });
    Object.assign(r, { status: "connected", last_error: null });
    return ok({ provider: r.provider, ok: true });
  }
  if (method === "POST" && p === "/models/test") {
    const id = String(b.model_id ?? "");
    const bad = id.includes("experimental") || b.provider === "gemini";
    return ok({ provider: b.provider, model_id: id, ok: !bad, latency_ms: latency(id), error: bad ? "No answer within 30 s." : null });
  }

  if (method === "POST" && p === "/connections/cli/refresh") return ok(cliBody(s));
  m = p.match(/^\/connections\/cli\/([\w-]+)\/install-plan$/);
  if (m && method === "POST") {
    const r = row(m[1]);
    if (!r || r.kind !== "cli") return fail(m ? 404 : 400, `unknown provider ${m[1]}`);
    const spec = SOURCES[BIN[r.provider]];
    const plan_id = `fixture-plan-${r.provider}`;
    s.plans.set(plan_id, r.provider);
    const plan: InstallPlan = {
      cli: BIN[r.provider],
      plan_id,
      method: spec.npm ? "npm" : "script",
      source: spec.source,
      docs: spec.docs,
      version: spec.version,
      sha256: spec.npm ? undefined : "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      size: spec.npm ? undefined : 15443,
      commands: spec.commands,
      env: spec.env ?? {},
      effects: spec.effects,
      sudo: false,
      expires_in: 300,
    };
    return ok(plan);
  }
  m = p.match(/^\/connections\/cli\/([\w-]+)\/install$/);
  if (m && method === "POST") {
    const provider = s.plans.get(String(b.plan_id));
    if (!provider || provider !== m[1]) return fail(410, "the plan expired or was already used; review it again");
    s.plans.delete(String(b.plan_id));
    const id = `fixture-job-${provider}`;
    s.jobs.set(id, { cli: provider, planId: String(b.plan_id), cancelled: false });
    return ok({ id, cli: BIN[provider], state: "running", exit_code: null });
  }
  m = p.match(/^\/connections\/cli\/jobs\/([\w-]+)\/cancel$/);
  if (m && method === "POST") {
    const job = s.jobs.get(m[1]);
    if (!job) return fail(404, "unknown job");
    job.cancelled = true;
    return ok({ id: m[1], state: "cancelled" });
  }
  return fail(404, `fixture: no route for ${method} ${p}`);
}

/** What each fixture install leaves behind. opencode lands off a new terminal's PATH (as it did for real). */
const AFTER: Record<string, { bin_dir: string; on_user_path: boolean }> = {
  claude: { bin_dir: "~/.local/bin", on_user_path: true },
  codex: { bin_dir: "~/.local/bin", on_user_path: true },
  gemini: { bin_dir: "~/.nvm/versions/node/v24.22.3/bin", on_user_path: true },
  grok: { bin_dir: "~/.grok/bin", on_user_path: true },
  opencode: { bin_dir: "~/.opencode/bin", on_user_path: false },
};

/** Claude Code's fixture install fails, so the failure state can be tested. */
const FAILS = new Set(["claude"]);

interface Entry {
  t: string;
  r: boolean;
  p: number | null;
}
const line = (t: string): Entry => ({ t, r: false, p: null });
const bar = (pct: number, last = false): Entry => ({
  t: `${"#".repeat(Math.round(pct * 0.72))}${" ".repeat(72 - Math.round(pct * 0.72))} ${pct.toFixed(1)}%`,
  r: !last,
  p: pct,
});

function script(bin: string, version: string): Entry[] {
  if (FAILS.has(bin)) {
    return [
      line(`Downloading ${bin} ${version}…`),
      bar(8.9),
      bar(31.4),
      line("curl: (22) The requested URL returned error: 404"),
      ...Array.from({ length: 22 }, (_, i) => line(`retry ${i + 1}: mirror unavailable`)),
      line(`Install failed: could not download ${bin} ${version}`),
    ];
  }
  return [
    line(`Downloading ${bin} ${version}…`),
    { t: "#=#=#", r: true, p: null },
    bar(8.9),
    bar(44.8),
    bar(85.1),
    bar(100, true),
    line(`Installing ${bin} ${version}`),
    line("Verifying checksum… ok"),
    line("Done."),
  ];
}

/** Canned SSE for an install job; flips the CLI to installed when it succeeds. */
export function stream(path: string): Response {
  const s = store();
  const m = path.match(/\/connections\/cli\/jobs\/([\w-]+)\/events/);
  const job = m && s.jobs.get(m[1]);
  if (!job) return new Response("install job not found", { status: 404 });
  const bin = BIN[job.cli];
  const enc = new TextEncoder();
  const body = new ReadableStream({
    async start(c) {
      let n = 0;
      for (const entry of script(bin, SOURCES[bin].version)) {
        if (job.cancelled) break;
        await new Promise((r) => setTimeout(r, 120));
        c.enqueue(enc.encode(`id: ${++n}\nevent: log\ndata: ${JSON.stringify(entry)}\n\n`));
      }
      const failed = FAILS.has(bin);
      const state = job.cancelled ? "cancelled" : failed ? "failed" : "ok";
      if (state === "ok") {
        const r = s.rows.find((x) => x.provider === job.cli);
        const after = AFTER[bin];
        if (r) {
          Object.assign(r, {
            status: "logged_out",
            installed: true,
            windows_only: false,
            version: SOURCES[bin].version,
            logged_in: false,
            bin_dir: after.bin_dir,
            bin_path: `${after.bin_dir}/${bin}`,
            on_user_path: after.on_user_path,
          });
        }
      }
      c.enqueue(enc.encode(`event: exit\ndata: ${JSON.stringify({ state, exit_code: state === "ok" ? 0 : state === "failed" ? 1 : null })}\n\n`));
      c.close();
    },
  });
  return new Response(body, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform" } });
}

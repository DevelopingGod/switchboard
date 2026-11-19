/** Shapes returned by the Router API (services/router). Safe to import from client code: types only. */

export type Privacy = "no-training" | "may-train" | "local" | "varies";

export interface CreditsInfo {
  /** null until the balance is entered; nothing is blocked before that. */
  starting_usd: number | null;
  spent_usd?: number;
  remaining_usd?: number;
  exhausted?: boolean;
}

export interface ConnectionRow {
  provider: string;
  name: string;
  kind: "api_key" | "cli" | "local";
  privacy: Privacy;
  paid: boolean;
  free_limits: string | null;
  notes: string | null;
  /** api_key/local: connected | error | no_key | unknown. cli: logged_in | logged_out | installed | windows_only | not_installed | unknown. */
  status: string;
  last_checked: string | null;
  last_error: string | null;
  /** Stable code for last_error (plain-language mapping in i18n/errors.ts). */
  last_error_code?: string | null;
  /** Set while LiteLLM registration failed; the router retries by itself, the card offers "Retry sync". */
  sync_error?: string;
  key_last4?: string | null;
  /** One-time free credits (Cerebras): tracked against a balance you enter. Absent for other providers. */
  credits?: CreditsInfo;
  /** M3a generic providers: extra non-secret values the key form asks for (e.g. an account id). */
  params?: string[];
  param_values?: Record<string, string>;
  models_available?: number;
  installed?: boolean | null;
  version?: string | null;
  logged_in?: boolean | null;
  windows_only?: boolean | null;
  login_method?: string | null;
  login_hint?: string | null;
  /** Home-relative ("~/.opencode/bin/opencode") so absolute home paths are not sent around. */
  bin_path?: string | null;
  bin_dir?: string | null;
  /** Whether a new terminal's PATH contains bin_dir; null when unknown or not installed. */
  on_user_path?: boolean | null;
  error?: string;
}

/** One install-log entry from hostprobe. `r`: a redraw the next entry replaces; `p`: download percent. */
export interface LogEntry {
  t: string;
  r: boolean;
  p: number | null;
}

export interface ConnectionsResponse {
  providers: ConnectionRow[];
  hostprobe: "up" | "down";
}

export interface ModelTestStats {
  samples: number;
  error_rate: number | null;
  p50_ms: number | null;
  p95_ms: number | null;
  last_ok: boolean | null;
}

export interface CatalogModel {
  provider: string;
  model_id: string;
  display_name: string | null;
  tags: string[];
  tag_source: string;
  context: number | null;
  max_output: number | null;
  free: boolean;
  privacy: Privacy;
  status: string;
  test: ModelTestStats | null;
}

export interface CatalogResponse {
  count: number;
  models: CatalogModel[];
}

export interface InstallPlan {
  cli: string;
  plan_id: string;
  method: "script" | "npm";
  source: string;
  docs: string;
  version: string;
  sha256?: string;
  size?: number;
  commands: string[];
  env: Record<string, string>;
  effects: string[];
  sudo: false;
  expires_in: number;
}

export interface InstallJob {
  id: string;
  cli: string;
  state: "running" | "ok" | "failed" | "cancelled" | "timeout";
  exit_code: number | null;
}

export type OnboardingStep = "welcome" | "goals" | "connect" | "preset" | "finish";
export type Preset = "free" | "balanced" | "best";

export interface OnboardingState {
  step: OnboardingStep;
  name: string;
  goals: string[];
  preset: Preset | null;
  skipped: boolean;
  completed_at: string | null;
}

export interface OnboardingResponse {
  state: OnboardingState | null;
  goals: Record<string, { provider: string; paid: boolean }[]>;
}

export type OnboardingPatch = Partial<Omit<OnboardingState, "completed_at">> & { completed?: boolean };

/** What server actions return to client components. */
export type ActionResult<T = null> = { ok: true; data: T } | { ok: false; error: string; code?: string; detail?: string | null };

// --- Chat (M2) -----------------------------------------------------------------------------------

export interface ChatThread {
  id: string;
  title: string;
  title_source: "none" | "words" | "local" | "user";
  private: boolean;
  /** Pinned threads sort first in the sidebar (M1.5). */
  pinned: boolean;
  /** M3a: user | slash | auto (looked sensitive; may be overridden) | secret. */
  private_source?: "user" | "slash" | "auto" | "secret" | null;
  summary?: ThreadSummary | null;
  created_at: string;
  updated_at: string;
}

/** GET /chat/threads (M3b): the sidebar's recents. `pinned` only comes with the first page of a
 * non-search listing; `next_cursor` is null on the last page. */
export interface ThreadPage {
  pinned: ChatThread[];
  threads: ChatThread[];
  next_cursor: string | null;
}

export interface RouteSkip {
  target: string;
  label: string;
  code: string;
  reason: string;
}

/** What the RouteChip and "Why this?" popover show; stored on every reply by the router. */
export interface RouteInfo {
  request_id: number | null;
  rule: string;
  matched_by: "manual" | "slash" | "private" | "intent" | "default" | "auto_private" | "secret";
  intent: string;
  preset: string;
  private: boolean;
  job_suggested: boolean;
  target: string | null;
  label: string | null;
  local: boolean | null;
  free_tier: boolean | null;
  reasons: string[];
  runner_up: string | null;
  skipped: RouteSkip[];
  context_tokens: number;
  thinking_ms: number | null;
  model?: string;
  provider?: string;
  provider_name?: string;
  tokens_in?: number;
  tokens_out?: number;
  estimated?: boolean;
  cost_usd?: number;
  list_price_usd?: number | null;
  latency_ms?: number;
  ttft_ms?: number | null;
  error?: string | null;
  /** Stable code for `error` (plain-language mapping in i18n/errors.ts). */
  error_code?: string | null;
  notice?: "image" | "video" | "audio";
  blocked?: BlockedInfo;
  /** M3a: why a reply stayed local without the Private toggle. */
  sensitive?: SensitiveInfo | null;
  score?: number | null;
}

export interface SensitiveInfo {
  source: "classifier" | "secret";
  category: "health" | "finance" | "legal" | "personal" | "secret";
  overridable: boolean;
  overridden?: boolean;
  already_private?: boolean;
}

/** M3a: running summary of the older turns of a long thread. */
export interface ThreadSummary {
  text: string;
  upto_message_id: number;
  covers: number;
  model: string | null;
  created_at: string;
}

export interface BlockedInfo {
  code: "budget_daily" | "budget_request";
  reason: string;
  daily_cap_usd: number;
  max_cost_usd: number;
  spent_today: number;
}

export type MessageStatus = "streaming" | "done" | "stopped" | "error" | "notice" | "blocked";

export interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  status: MessageStatus;
  private: boolean;
  feedback: "up" | "down" | null;
  route: RouteInfo | null;
  /** M3a: a pasted secret was masked in this (user) message. */
  secret?: { kinds: string[] } | null;
  created_at: string;
}

export interface ThreadResponse {
  thread: ChatThread;
  messages: ChatMessage[];
}

export interface TargetAlias {
  target: string;
  alias: string;
  label: string;
  available: boolean;
  reason: string | null;
  local: boolean;
  free_tier: boolean;
  paid: boolean;
  privacy: Privacy;
}

export interface TargetModel extends CatalogModel {
  target: string;
  paid: boolean;
}

export interface TargetProvider {
  provider: string;
  name: string;
  local: boolean;
  privacy: Privacy;
  models: TargetModel[];
}

export interface TargetsResponse {
  aliases: TargetAlias[];
  providers: TargetProvider[];
  preset: string;
}

/** Body of POST /api/chat/stream (validated again on the server). */
export interface ChatStreamBody {
  mode: "send" | "regenerate" | "edit";
  thread_id?: string | null;
  text?: string;
  target: string;
  private: boolean;
  temperature?: number | null;
  autonomy?: number | null;
  /** M3a: "Not sensitive — use cloud" (regenerate only). */
  cloud_override?: boolean;
}

/** Status view (GET /system/components). */
export type ComponentStatus = "ok" | "degraded" | "down";
export type ComponentFix =
  | "resync"
  | "recheck_cli"
  | "start_docker"
  | "open_ollama"
  | "start_paperclip"
  | "start_hostprobe"
  | "pull_models"
  | `retest:${string}`;

export interface SystemComponent {
  id: string;
  status: ComponentStatus;
  fix: ComponentFix | null;
  detail: string | null;
  name?: string;
  code?: string | null;
  last_ok_at?: string | null;
  next_retry_at?: string | null;
  /** M3a: when a cooldown or a quota window ends (ISO). */
  until?: string | null;
  quota?: QuotaUsage;
  /** local_profile row */
  profile?: string;
  label?: string;
  vram_gb?: number | null;
  missing?: string[];
  overridden?: boolean;
}

export interface ComponentsResponse {
  status: ComponentStatus;
  components: SystemComponent[];
}

/** Footer (GET /system/summary). */
export interface SystemSummary {
  health: { router: string; litellm: string; ollama: string; paperclip: string; model_sync: string };
  spend_today_usd: number;
  value_saved_usd: number;
  quota: {
    status: "ok" | "limited" | "blocked";
    daily_cap_usd: number;
    daily_cap_used: number;
    cooling_down: string[];
    credits_low: string[];
    credits_out: string[];
    /** M3a quota guard: every connected provider with limits, closest to its limit first. */
    providers?: QuotaUsage[];
    /** The provider closest to a free limit, once it is at 50% or more. */
    top?: QuotaUsage | null;
  };
  version: string;
}

export interface QuotaUsage {
  provider: string;
  name: string;
  model: string | null;
  fraction: number;
  window: "minute" | "day";
  kind: "requests" | "tokens";
  used: number;
  limit: number;
  resets_at: string | null;
  source: "counter" | "headers";
  estimate: boolean;
}

/** Settings page (GET/PUT /settings): owner overrides over config/rules.yaml defaults. */
export interface SettingsView {
  max_cost_usd: number;
  daily_cap_usd: number;
  private_by_default: boolean;
  /** M3a: try models with few samples (recommender). */
  explore: boolean;
  /** M3a: keep messages that look sensitive on this machine. */
  auto_private: boolean;
  defaults: { max_cost_usd: number; daily_cap_usd: number; private_by_default: boolean; explore: boolean; auto_private: boolean };
  overridden: string[];
}

/** Settings → Local models (GET /system/local-profile, M3a). */
export interface LocalProfile {
  name: string;
  label: string;
  min_vram_gb: number;
  classifier: string | null;
  general: string;
  tasks: string | null;
  coder: string;
  cpu: boolean;
  max_loaded: number;
  models: string[];
}

export interface LocalProfileView {
  active: string;
  recommended: string;
  overridden: boolean;
  detected: { vram_gb: number | null; ram_gb: number | null; gpu?: string | null; source: string };
  profiles: LocalProfile[];
  installed: string[] | null;
  missing: string[];
  ollama: "ok" | "down";
  pull: { status: "idle" | "running" | "done" | "error"; model: string | null; percent: number | null; error: string | null };
}

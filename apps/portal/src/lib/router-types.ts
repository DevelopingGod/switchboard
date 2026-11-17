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
  created_at: string;
  updated_at: string;
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
  matched_by: "manual" | "slash" | "private" | "intent" | "default";
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
}

export interface ComponentsResponse {
  status: ComponentStatus;
  components: SystemComponent[];
}

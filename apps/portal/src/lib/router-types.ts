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
export type ActionResult<T = null> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: string; detail?: string | null; /** Rules UI: one entry per validation mistake. */ problems?: { path: string; message: string }[] };

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
  /** M4a: "Think harder" for this message (local answers use the profile's thinking model). */
  think?: boolean;
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
  | "rebuild_rollups"
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
  /** M4b, the paperclip row: its auth mode and the loopback check (ADR 0007). */
  notes?: PaperclipNotes;
  /** M6.5: `subscription:<cli>:<account>` rows and the `rollups` row. */
  account?: string;
  window?: UsageWindowView;
  state?: "ok" | "behind" | "stopped";
  pending_buckets?: number;
  last_run_at?: string | null;
}

export interface PaperclipNotes {
  /** `local_trusted` = no login (local only). */
  auth?: string | null;
  exposure?: string | null;
  version?: string | null;
  pinned?: string;
  loopback?: { checked: boolean; ok: boolean | null; addresses: string[]; port?: number };
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
  /** M4b: a job waiting longer for your approval is stopped (hours; 0 = never). */
  approval_expiry_h: number;
  /** M4b: finished jobs' worktrees kept per project. */
  keep_worktrees_per_project: number;
  defaults: {
    max_cost_usd: number;
    daily_cap_usd: number;
    private_by_default: boolean;
    explore: boolean;
    auto_private: boolean;
    approval_expiry_h: number;
    keep_worktrees_per_project: number;
  };
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

// --- Rules UI (M3b) -------------------------------------------------------------------------------
export interface RuleDef {
  id: string;
  when?: Record<string, string | boolean>;
  target: string;
  fallbacks?: string[];
  temperature?: number;
  autonomy?: number;
  max_cost_usd?: number;
  job?: boolean;
}

export interface PresetDef {
  paid?: "never" | "manual" | "allowed";
  rules?: Record<string, Partial<RuleDef>>;
}

export interface ClassifierRoute {
  name: string;
  description: string;
  facts: Record<string, string>;
}

/** rules.yaml as the router returns it (base) and merged with the overrides (effective). */
export interface RulesFile {
  defaults: Record<string, number | boolean>;
  rules: RuleDef[];
  slash: Record<string, string>;
  presets: Record<string, PresetDef>;
  classifier: { timeout_s?: number; breaker_s?: number; max_chars?: number; routes: ClassifierRoute[] };
  recommender: { min_samples?: number; weights: Record<string, number> };
  quota: { reroute_at?: number; block_at?: number };
  summary: { start_at?: number; keep_last?: number };
}

/** The owner's edits: a partial rules.yaml (see ADR 0004). `disabled` removes a rule, `before` positions a new one. */
export interface Overrides {
  defaults?: Record<string, number>;
  rules?: Record<string, Partial<RuleDef> & { disabled?: boolean; before?: string }>;
  slash?: Record<string, string | null>;
  presets?: Record<string, PresetDef>;
  classifier?: { timeout_s?: number; routes?: Record<string, { description?: string }> };
  recommender?: { min_samples?: number; weights?: Record<string, number> };
  quota?: { reroute_at?: number; block_at?: number };
  summary?: { start_at?: number; keep_last?: number };
}

export interface RuleProblem {
  path: string;
  message: string;
}

export interface RulesVersion {
  id: number;
  created_at: string;
  source: "edit" | "rollback" | "reset";
  note: string | null;
  rolled_back_to: number | null;
  changes: number;
}

export interface RulesVocab {
  aliases: string[];
  providers: string[];
  capabilities: string[];
  intents: string[];
  sensitive: string[];
  when_keys: string[];
  paid_policies: string[];
  presets: string[];
  protected_rules: string[];
  limits: { max_rules: number; max_fallbacks: number; max_text: number };
}

export interface RulesResponse {
  version: RulesVersion | null;
  overrides: Overrides;
  base: RulesFile;
  effective: RulesFile;
  active_preset: Preset;
  /** Saved overrides that stopped validating (rules.yaml changed): routing uses the plain file. */
  problems: RuleProblem[];
  vocab: RulesVocab;
}

export interface RulesVersionsResponse {
  versions: RulesVersion[];
  next_before: number | null;
}

export interface RulesDiffChange {
  path: string;
  kind: "added" | "removed" | "changed";
  before: unknown;
  after: unknown;
}

export interface DryRunScore {
  label: string;
  score: number;
  proven: boolean;
  parts: Record<string, number>;
}

/** POST /route/dry-run: the decision, the classifier's answer and the score breakdown. */
export interface DryRunResult {
  rule: string;
  matched_by: string;
  intent: string;
  size: string;
  quality: string;
  cue: string | null;
  private: boolean;
  preset: string;
  classifier: { source: string; route: string | null; ms: number; fallback_reason?: string | null } | null;
  sensitive: { source: string; category?: string } | null;
  candidates: { target: string; label: string; note?: string | null }[];
  skipped: { target: string; label: string; code: string; reason: string }[];
  chosen: { target: string; label: string } | null;
  runner_up: string | null;
  reasons: string[];
  scores: DryRunScore[];
}

// --- M4b: jobs, the agent fleet, projects -------------------------------------------------------------
export type JobStatus = "queued" | "running" | "needs_approval" | "waiting_reset" | "done" | "failed" | "stopped";
/** M6.5: `limit` = the usage-limit reset is far away, so the job asks before waiting (ADR 0014). */
export type JobGate = "plan" | "diff" | "result" | "limit";

export interface JobEventRow {
  id: number;
  kind: string;
  at: string;
  [k: string]: unknown;
}

export interface JobView {
  id: number;
  request_id: number | null;
  project_id: number;
  project: { id: number; name: string; path: string } | null;
  title: string;
  prompt: string;
  agent: string;
  agent_label: string;
  agent_chain: string[];
  autonomy: number;
  status: JobStatus;
  phase: string | null;
  gate: JobGate | null;
  run_id: string | null;
  worktree: string | null;
  branch: string | null;
  base_sha: string | null;
  budget_list_usd: number;
  list_price_usd: number;
  cost_usd: number;
  cost_reported: boolean;
  turns: number;
  plan: string | null;
  result: string | null;
  error: string | null;
  paperclip: { issue_id: string | null; agent_id: string | null; approval_id: string | null };
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string | null;
  events?: JobEventRow[];
  approval_expires_at?: string | null;
  /** M6.5: the CLI account (null = default), waiting for a usage-window reset, paid overflow. */
  account?: string | null;
  resume_at?: string | null;
  attempt?: number;
  waits?: number;
  paid?: boolean;
  paid_budget_usd?: number | null;
}

export interface JobsPage {
  jobs: JobView[];
  next: number | null;
}

export interface JobCounts {
  counts: Record<JobStatus, number>;
  all: number;
  needs_you: number;
  waiting?: number;
}

export interface JobPreview {
  ok: boolean;
  problem: string | null;
  project: { id: number; name: string; path: string };
  autonomy: number;
  level: { runs: string[]; review: "diff" | "result"; approve_plan: boolean };
  agents: { id: string; label: string; reason: string | null; chosen: boolean; account?: string | null; window?: UsageWindowView | null; paid?: boolean }[];
  agent: string | null;
  budget_list_usd: number;
  cost_reported: boolean | null;
  caps: { max_turns: number; run_timeout_s: number; job_timeout_s: number };
  branch: string;
  steps: string[];
  /** M6.5: every agent's window is used up: the job waits until then (or asks, when it is far away). */
  waits_until?: string | null;
  paid?: boolean;
  paid_budget_usd?: number | null;
  overflow?: { ready: boolean; left_usd: number | null; model: string | null };
}

// --- M6.5: subscription usage windows, accounts, paid overflow (ADRs 0013-0015) ---------------------------
export interface UsageWindowView {
  window: string;
  label: string;
  hours: number;
  /** 0..1, null = unknown (an estimate with no calibration yet). */
  used: number | null;
  resets_at: string | null;
  limited: boolean;
  source: "reported" | "estimate";
  runs: number;
  seen_at: string | null;
}

export interface SubscriptionView {
  cli: string;
  account: string;
  plan_label: string;
  windows: UsageWindowView[];
  tightest: UsageWindowView | null;
  logged_in?: boolean | null;
  limit_hits_30d?: number;
  label?: string;
}

export interface AccountRow {
  name: string;
  label: string | null;
  logged_in: boolean | null;
  installed: boolean | null;
  plan: string | null;
  plan_label: string | null;
  home: string | null;
  login_command: string | null;
  error?: string | null;
}

export interface AccountsResponse {
  clis: { cli: string; label: string; home_env: string; accounts: AccountRow[] }[];
}

export interface OverflowSettings {
  enabled: boolean;
  monthly_usd: number | null;
  model: string | null;
  spent_usd: number;
  left_usd: number | null;
  ready: boolean;
  models: { model: string; paid: boolean; providers: string[] }[];
  test_free_model: boolean;
}

export interface JobProposal {
  request_id: number;
  private: boolean;
  rule: string | null;
  suggested: boolean;
  agents: string[];
  autonomy: number | null;
}

export interface JobInput {
  prompt: string;
  project_id: number;
  agents: string[];
  autonomy: number;
  budget_list_usd?: number;
  title?: string;
  from_request_id?: number;
  /** M6.5: set only after the "Paid — up to $X" confirmation (ADR 0015). */
  paid_budget_usd?: number;
}

export interface JobRun {
  run: string;
  kind: string | null;
  started_at: string | null;
  status: string;
  agent?: string;
}

export interface JobLogLine {
  stream: string | null;
  chunk: string | null;
  ts?: string | null;
}

export interface JobLogPage {
  run: string;
  lines: JobLogLine[];
  next: number | null;
  offset: number;
}

export interface JobDiff {
  branch: string;
  base: string;
  files: { path: string; added: number | null; removed: number | null; new?: boolean }[];
  diff: string;
  truncated: boolean;
}

export interface AgentRow {
  id: string;
  label: string;
  cli: string;
  template: string | null;
  hired: boolean;
  edited: boolean;
  capabilities: string[];
  runnable: boolean;
  note: string | null;
  installed: boolean;
  windows_only: boolean;
  logged_in: boolean | null;
  version: string | null;
  cost: "reported" | "none" | string;
  model: string | null;
  models: string[];
  role: string | null;
  default_autonomy: number | null;
  allowed_project_ids: number[] | null;
  paused: boolean;
  /** Level ("0".."3") → why it can't run now, or null. */
  levels: Record<string, string | null>;
  active_jobs: number;
  current_job: { id: number; title: string; status: JobStatus } | null;
  success: { done: number; failed: number; rate: number | null };
  spent_today_list_usd: number;
  daily_budget_list_usd: number;
  month_list_usd: number;
  month_cost_usd: number;
  monthly_budget_list_usd: number | null;
  paperclip_agent_id?: string | null;
  /** M6.5: the agent's account (null = default), the paid-overflow agent, its usage windows. */
  account?: string | null;
  paid?: boolean;
  subscription?: SubscriptionView | null;
}

export interface AgentTemplate {
  id: string;
  label: string;
  cli?: string;
  runnable: boolean;
  note: string | null;
  installed: boolean;
  models: string[];
  model: string | null;
  levels: Record<string, string | null>;
}

export interface AgentsResponse {
  agents: AgentRow[];
  templates: AgentTemplate[];
  bwrap: boolean | null;
  /** M6.5: subscription CLI → its account names ("default" first). */
  accounts?: Record<string, string[]>;
  defaults: {
    max_active_per_agent: number;
    per_job_list_usd: number;
    per_agent_daily_list_usd: number;
    per_agent_monthly_list_usd: number | null;
    max_turns: number;
    run_timeout_s: number;
  };
}

export interface AgentInput {
  template?: string;
  label?: string;
  role?: string | null;
  model?: string | null;
  default_autonomy?: number | null;
  monthly_list_usd?: number | null;
  allowed_project_ids?: number[] | null;
  account?: string | null;
}

export interface ProjectRow {
  id: number;
  name: string;
  path: string;
  slug: string;
  head_branch: string | null;
  created_at: string;
  active_jobs: number;
  jobs: number;
  /** M6.5: {cli: account} this project's new jobs use. */
  accounts?: Record<string, string>;
}

export interface ProjectWorktrees {
  worktrees: { job_id: number; path?: string; branch?: string; tip?: string; merged?: boolean; bytes?: number | null }[];
  bytes: number | null;
  keep: number;
  error?: string | null;
}

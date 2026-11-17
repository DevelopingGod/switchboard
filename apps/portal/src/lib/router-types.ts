/** Shapes returned by the Router API (services/router). Safe to import from client code: types only. */

export type Privacy = "no-training" | "may-train" | "local" | "varies";

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
  key_last4?: string | null;
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
export type ActionResult<T = null> = { ok: true; data: T } | { ok: false; error: string };

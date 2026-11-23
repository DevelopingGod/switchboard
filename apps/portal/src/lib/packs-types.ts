/** Workflow packs (M4.5a, SPEC §8a, ADRs 0018-0019): what the router's /packs, /projects/{id}/packs and
 * /metrics/packs return. */

export interface PackVerify {
  ok: boolean;
  version: string | null;
  ms: number;
  files?: number;
  problem: string | null;
}

export interface PackFlow {
  id: string; // "openspec.change"
  label: string;
  summary: string;
  steps: string[];
}

export interface PackRow {
  id: string;
  name: string;
  summary: string;
  trust: "verified" | "community";
  unverified: boolean;
  source: string;
  kind: "npm" | "pypi" | "git";
  package: string | null;
  version: string | null;
  homepage: string | null;
  repository: string | null;
  license: string | null;
  hosts: string[];
  scope: string[];
  refused: string | null;
  lock_problem: string | null;
  installable: boolean;
  auto: "graph" | null;
  flows: PackFlow[];
  installed: string | null;
  previous: string | null;
  update: boolean;
  verify?: PackVerify | null;
}

export interface PackHistoryRow {
  id: number;
  pack: string;
  version: string | null;
  action: "install" | "rollback" | "uninstall";
  status: "running" | "ok" | "failed";
  summary: Record<string, unknown>;
  log_tail: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface PackLibrary {
  packs: PackRow[];
  errors: Record<string, string>;
  hostprobe: boolean;
  hostprobe_error?: string | null;
  store: string | null;
  network_isolated: boolean | null;
  history: PackHistoryRow[];
}

export interface PackRequirement {
  name: string;
  need: string;
  found: string | null;
  ok: boolean;
}

export interface PackPlan {
  id: string;
  name: string;
  summary?: string;
  trust: string;
  unverified: boolean;
  kind: "npm" | "pypi";
  package: string;
  version: string;
  source: string;
  repository: string | null;
  hash: string | null;
  dependencies: number;
  lookalikes: string[];
  install_scripts: string[];
  commands: string[];
  writes: string[];
  project_writes: string[];
  artifacts: string[];
  requires: PackRequirement[];
  problem: string | null;
  network_isolated: boolean;
  current: string | null;
  sudo: false;
  plan_id: string | null;
  expires_in?: number;
}

export interface PackJob {
  id: string;
  cli: string;
  state: "running" | "ok" | "failed" | "cancelled" | "timeout";
  exit_code: number | null;
}

export interface GraphGroup {
  group: string;
  agent: string;
  flow: string | null;
  state: "measuring" | "on" | "off";
  status: string;
  numbers?: { with: number; without: number; gain: number; samples: number } | null;
}

export interface ProjectPackSettings {
  enabled?: boolean;
  mode?: "auto" | "always" | "off";
  hosts: string[];
  groups?: GraphGroup[];
  auto_threshold?: { min_files: number; min_bytes: number };
}

export interface ProjectPacks {
  project_id: number;
  packs: Record<string, ProjectPackSettings>;
}

export interface PackMetricsRow {
  project_id: number;
  project: string;
  agent: string;
  flow: string | null;
  state: "measuring" | "on" | "off";
  status: string;
  round: number;
  median_with: number | null;
  median_without: number | null;
  cached_with: number | null;
  cached_without: number | null;
  samples_with: number;
  samples_without: number;
  cached_known: boolean;
  gain: number | null;
}

export interface PackMetrics {
  rows: PackMetricsRow[];
  measure: { holdout_every: number; min_samples: number; min_gain: number; recheck_every: number };
}

/** A job's packs (the job page). */
export interface JobPacks {
  state: "setting_up" | "ready" | null;
  error?: string | null;
  graphify?: { eligible?: boolean; used?: boolean; control?: boolean; reason?: string | null; build_ms?: number; nodes?: number | null } | null;
  refused: { id: string; reason: string }[];
  packs: Record<string, { name: string; version: string; owned: string[]; artifacts: string[]; edits: { path: string; kind: string }[]; graph_stats?: { nodes: number | null } | null; verify_ms?: number }>;
}

export interface FlowStep {
  pack: string;
  label: string;
  index: number;
  count: number;
  step: string;
  steps: string[];
}

export interface SetupEdit {
  path: string;
  kind: "modified" | "new" | "deleted";
  pack: string;
  pack_name: string;
  agent_changed: boolean;
  both: boolean;
}

/** Agent host ids as packs name them, and their labels. */
export const HOST_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  "gemini-cli": "Gemini CLI",
  "grok-build": "Grok Build",
  hermes: "Hermes",
};

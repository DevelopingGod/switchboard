import "server-only";
import type {
  AgentRow,
  AgentTemplate,
  AgentsResponse,
  JobCounts,
  JobDiff,
  JobEventRow,
  JobLogLine,
  JobPreview,
  JobStatus,
  JobView,
  ProjectRow,
  ProjectWorktrees,
  AccountsResponse,
  OverflowSettings,
  SubscriptionView,
  UsageWindowView,
} from "../router-types";
import type { Result } from "./router";

/**
 * Jobs, the agent fleet and projects for PORTAL_DATA=fixture (M4b): tests, screenshots and the bundle
 * check run without Paperclip, hostprobe or any CLI. Sample data only: invented paths and ids.
 * State lives on globalThis so it survives route-module reloads; restarting the server resets it.
 */

const ok = <T>(data: unknown): Result<T> => ({ ok: true, data: data as T });
const fail = <T>(status: number, error: string): Result<T> => ({ ok: false, status, error, detail: error });

const T0 = Date.parse("2026-11-20T09:00:00Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

const PLAN = `1. Add \`multiply(a, b)\` to \`mathutils.py\`, next to \`add\`.
2. Add \`test_multiply\` to \`tests/test_mathutils.py\` (positive, zero and negative numbers).
3. Run \`python3 -m unittest\` and report the result.

No other files change.`;

const DIFF = `diff --git a/mathutils.py b/mathutils.py
index 3b18e51..9f2c4a1 100644
--- a/mathutils.py
+++ b/mathutils.py
@@ -1,3 +1,8 @@
 def add(a, b):
     """Return a + b."""
     return a + b
+
+
+def multiply(a, b):
+    """Return a * b."""
+    return a * b
diff --git a/tests/test_mathutils.py b/tests/test_mathutils.py
index 5d1c0e2..a8e33f0 100644
--- a/tests/test_mathutils.py
+++ b/tests/test_mathutils.py
@@ -1,9 +1,15 @@
 import unittest

-from mathutils import add
+from mathutils import add, multiply


 class MathTests(unittest.TestCase):
     def test_add(self):
         self.assertEqual(add(2, 3), 5)
+
+    def test_multiply(self):
+        self.assertEqual(multiply(4, 5), 20)
+        self.assertEqual(multiply(0, 9), 0)
+        self.assertEqual(multiply(-2, 3), -6)
diff --git a/CHANGELOG.md b/CHANGELOG.md
new file mode 100644
index 0000000..e69de29
--- /dev/null
+++ b/CHANGELOG.md
@@ -0,0 +1,3 @@
+# Changelog
+
+- Added \`multiply(a, b)\`.
`;

const LOG: JobLogLine[] = [
  { stream: "system", chunk: "run started: edit (Claude Code, autonomy 1)", ts: at(3) },
  { stream: "stdout", chunk: "Reading mathutils.py and tests/test_mathutils.py", ts: at(3) },
  { stream: "stdout", chunk: "Editing mathutils.py: adding multiply(a, b)", ts: at(3.2) },
  { stream: "stdout", chunk: "Editing tests/test_mathutils.py: adding test_multiply", ts: at(3.4) },
  { stream: "stdout", chunk: "$ python3 -m unittest", ts: at(3.6) },
  { stream: "stdout", chunk: "..\n----------------------------------------------------------------------\nRan 2 tests in 0.001s\n\nOK", ts: at(3.7) },
  { stream: "stdout", chunk: "Done: multiply added with a test; 2 tests pass.", ts: at(3.8) },
];

function project(id: number, name: string, path: string, active = 0, jobs = 0): ProjectRow {
  return { id, name, path, slug: name, head_branch: "main", created_at: at(-600), active_jobs: active, jobs };
}

const CLAUDE_L3 = "Level 3 is off: it needs a sandbox, and Paperclip's fails to start on this Linux (merged /usr). A locked-down container per job is planned (ADR 0010, M7). Level 3 never runs without a sandbox.";
const OTHER_L3 = "Level 3 is off until the per-job container sandbox lands (ADR 0010, M7).";

function agent(id: string, label: string, over: Partial<AgentRow> = {}): AgentRow {
  return {
    id,
    label,
    cli: id === "claude-code" ? "claude" : id,
    template: null,
    hired: false,
    edited: false,
    capabilities: ["code"],
    runnable: true,
    note: null,
    installed: true,
    windows_only: false,
    logged_in: true,
    version: "1.0",
    cost: "reported",
    model: null,
    models: [],
    role: null,
    default_autonomy: null,
    allowed_project_ids: null,
    paused: false,
    levels: { "0": null, "1": null, "2": null, "3": OTHER_L3 },
    active_jobs: 0,
    current_job: null,
    success: { done: 0, failed: 0, rate: null },
    spent_today_list_usd: 0,
    daily_budget_list_usd: 10,
    month_list_usd: 0,
    month_cost_usd: 0,
    monthly_budget_list_usd: null,
    ...over,
  };
}

// M6.5: usage windows as the router reports them. Claude's is "reported" (its stream-json rate_limit_event);
// Codex has run through Switchboard but has no reading yet (an estimate without a calibration: no %).
function win(window: string, label: string, hours: number, over: Partial<UsageWindowView> = {}): UsageWindowView {
  return { window, label, hours, used: null, resets_at: null, limited: false, source: "estimate", runs: 0, seen_at: null, ...over };
}
const CLAUDE_WINDOWS = (): UsageWindowView[] => [
  win("five_hour", "5-hour", 5, { used: 0.7, resets_at: at(320), source: "reported", seen_at: at(30) }),
  win("seven_day", "7-day", 168, { used: 0.12, resets_at: at(320 + 4 * 1440), source: "reported", seen_at: at(30) }),
];
const sub = (cli: string, account: string, plan: string, windows: UsageWindowView[], hits = 0): SubscriptionView => ({
  cli,
  account,
  plan_label: plan,
  windows,
  tightest: windows.filter((w) => w.used != null).sort((a, b) => (b.used ?? 0) - (a.used ?? 0))[0] ?? windows[0],
  logged_in: true,
  limit_hits_30d: hits,
});
export const SUBSCRIPTIONS = (): SubscriptionView[] => [
  sub("claude", "default", "Claude Pro", CLAUDE_WINDOWS(), 1),
  sub("codex", "default", "Codex", [win("primary", "5-hour", 5, { runs: 3 }), win("secondary", "weekly", 168, { runs: 3 })]),
];

const NOT_VERIFIED = (label: string) => ({ "0": `${label} isn't set up to run jobs yet`, "1": `${label} isn't set up to run jobs yet`, "2": `${label} isn't set up to run jobs yet`, "3": `${label} isn't set up to run jobs yet` });

function job(id: number, status: JobStatus, over: Partial<JobView> = {}): JobView {
  const title = over.title ?? "Add a function multiply(a, b) with tests";
  return {
    id,
    request_id: 100 + id,
    project_id: 1,
    project: { id: 1, name: "mathutils", path: "/home/you/code/mathutils" },
    title,
    prompt: `${title}.`,
    agent: "claude-code",
    agent_label: "Claude Code",
    agent_chain: ["claude-code", "opencode"],
    autonomy: 1,
    status,
    phase: null,
    gate: null,
    run_id: null,
    worktree: `/home/you/.switchboard/worktrees/mathutils/job-${id}`,
    branch: `switchboard/job-${id}`,
    base_sha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
    budget_list_usd: 2,
    list_price_usd: 0,
    cost_usd: 0,
    cost_reported: true,
    turns: 0,
    plan: null,
    result: null,
    error: null,
    paperclip: { issue_id: null, agent_id: null, approval_id: null },
    created_at: at(id),
    started_at: at(id + 0.1),
    finished_at: null,
    updated_at: at(id + 1),
    ...over,
  };
}

function events(j: JobView): JobEventRow[] {
  const out: JobEventRow[] = [
    { id: 1, kind: "created", at: j.created_at, agent_chain: j.agent_chain, autonomy: j.autonomy, budget: j.budget_list_usd },
  ];
  if (j.status === "queued") return out;
  out.push({ id: 2, kind: "worktree", at: at(j.id + 0.1), branch: j.branch, path: j.worktree });
  out.push({ id: 3, kind: "run_started", at: at(j.id + 0.2), run: `run-${j.id}-0`, run_kind: "read_only", agent: j.agent });
  if (j.plan) {
    out.push({ id: 4, kind: "run_finished", at: at(j.id + 0.6), run: `run-${j.id}-0`, status: "succeeded", turns: 4, list_price_usd: 0.05 });
    out.push({ id: 5, kind: "needs_approval", at: at(j.id + 0.6), gate: "plan" });
  }
  if (j.status === "done" || (j.status === "running" && j.plan) || j.gate === "diff") {
    out.push({ id: 6, kind: "approved", at: at(j.id + 1), gate: "plan", note: null, by: "you" });
    out.push({ id: 7, kind: "run_started", at: at(j.id + 1.1), run: `run-${j.id}-1`, run_kind: "edit", agent: j.agent });
  }
  if (j.status === "done" || j.gate === "diff") {
    out.push({ id: 8, kind: "run_finished", at: at(j.id + 2), run: `run-${j.id}-1`, status: "succeeded", turns: 9, list_price_usd: 0.08 });
  }
  if (j.gate === "diff") out.push({ id: 9, kind: "needs_approval", at: at(j.id + 2), gate: "diff" });
  if (j.status === "done") {
    out.push({ id: 10, kind: "approved", at: at(j.id + 3), gate: "diff", note: "Looks good", by: "you" });
    out.push({ id: 11, kind: "committed", at: at(j.id + 3), sha: "90cc7b4e1f", branch: j.branch, committed: true });
    out.push({ id: 12, kind: "done", at: at(j.id + 3), error: null });
  }
  if (j.status === "failed" || j.status === "stopped") out.push({ id: 13, kind: j.status, at: j.finished_at ?? at(j.id + 2), error: j.error });
  return out;
}

interface JobsStore {
  projects: ProjectRow[];
  agents: AgentRow[];
  jobs: JobView[];
  nextJob: number;
  nextProject: number;
}

function seed(): JobsStore {
  const claude = agent("claude-code", "Claude Code", {
    model: "claude-sonnet-5-5",
    models: ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"],
    capabilities: ["code", "research"],
    levels: { "0": null, "1": null, "2": null, "3": CLAUDE_L3 },
    active_jobs: 1,
    current_job: { id: 27, title: "Add input validation to the CSV importer", status: "running" },
    success: { done: 7, failed: 1, rate: 7 / 8 },
    spent_today_list_usd: 0.41,
    month_list_usd: 3.18,
    subscription: SUBSCRIPTIONS()[0],
  });
  const codex = agent("codex", "Codex", { subscription: SUBSCRIPTIONS()[1], cost: "none", success: { done: 3, failed: 0, rate: 1 }, active_jobs: 1, current_job: { id: 29, title: "Explain how the cache layer expires entries", status: "queued" } });
  const opencode = agent("opencode", "OpenCode", {
    model: "opencode/big-pickle",
    models: ["opencode/big-pickle"],
    success: { done: 4, failed: 2, rate: 4 / 6 },
  });
  const reviewer = agent("reviewer", "Reviewer", {
    template: "claude-code",
    hired: true,
    cli: "claude",
    model: "claude-haiku-5-5",
    models: claude.models,
    role: "You review changes for bugs and missing tests. Be brief.",
    default_autonomy: 0,
    monthly_budget_list_usd: 5,
    month_list_usd: 0.62,
    allowed_project_ids: [1],
    paused: true,
    levels: { "0": null, "1": null, "2": null, "3": CLAUDE_L3 },
    success: { done: 2, failed: 0, rate: 1 },
    account: "work",
    subscription: sub("claude", "work", "Claude Team", [win("five_hour", "5-hour", 5, { used: 0.18, resets_at: at(200), source: "reported", seen_at: at(20) }), win("seven_day", "7-day", 168)]),
  });
  const optional = [
    agent("gemini-cli", "Gemini CLI", { cli: "gemini", runnable: false, installed: false, windows_only: true, logged_in: null, version: null, note: "Not verified for jobs yet (only a Windows install was found).", levels: NOT_VERIFIED("Gemini CLI"), capabilities: ["research", "code"] }),
    agent("grok-build", "Grok Build", { cli: "grok", runnable: false, installed: false, logged_in: null, version: null, note: "Not verified for jobs yet.", levels: NOT_VERIFIED("Grok Build") }),
  ];
  const jobs: JobView[] = [
    job(31, "waiting_reset", {
      title: "Refactor the CSV importer into small functions",
      autonomy: 2,
      phase: "edit",
      attempt: 1,
      waits: 1,
      resume_at: at(320),
      list_price_usd: 0.071,
      turns: 7,
      project_id: 2,
      project: { id: 2, name: "notes-app", path: "/home/you/code/notes-app" },
    }),
    job(30, "needs_approval", { title: "Add a function multiply(a, b) with tests", phase: "read_only", gate: "plan", plan: PLAN, list_price_usd: 0.052, turns: 4, approval_expires_at: at(30 + 24 * 60) }),
    job(29, "queued", { title: "Explain how the cache layer expires entries", agent: "codex", agent_label: "Codex", agent_chain: ["codex"], autonomy: 0, cost_reported: false, started_at: null, worktree: null, branch: null, project_id: 2, project: { id: 2, name: "notes-app", path: "/home/you/code/notes-app" } }),
    job(28, "needs_approval", { title: "Rename the settings module to config", agent: "opencode", agent_label: "OpenCode", agent_chain: ["opencode"], autonomy: 2, phase: "edit", gate: "diff", list_price_usd: 0, turns: 11, approval_expires_at: at(28 + 24 * 60) }),
    job(27, "running", { title: "Add input validation to the CSV importer", phase: "edit", run_id: "run-27-1", plan: PLAN, list_price_usd: 0.088, turns: 6, project_id: 2, project: { id: 2, name: "notes-app", path: "/home/you/code/notes-app" } }),
    job(26, "done", { title: "Add a function subtract(a, b) with tests", agent: "codex", agent_label: "Codex", agent_chain: ["codex"], cost_reported: false, plan: PLAN, result: "Added subtract(a, b) and test_subtract; 2 tests pass.", turns: 14, finished_at: at(29), worktree: "/home/you/.switchboard/worktrees/mathutils/job-26" }),
    job(25, "done", { title: "Add a function divide(a, b) with tests", plan: PLAN, result: "Added divide(a, b) with a ZeroDivisionError test; 3 tests pass.", list_price_usd: 0.134, turns: 13, finished_at: at(28) }),
    job(24, "failed", { title: "Update the README badges", agent: "opencode", agent_label: "OpenCode", agent_chain: ["opencode"], autonomy: 2, error: "The run ended: failed (OpenCode exited with code 1)", finished_at: at(26), worktree: null }),
    job(23, "stopped", { title: "Migrate the tests to pytest", error: "You rejected the plan: keep unittest for now", list_price_usd: 0.051, turns: 3, plan: PLAN, finished_at: at(25), worktree: null }),
  ];
  for (let n = 22; n >= 1; n--) jobs.push(job(n, "done", { title: `Small fix ${n}: tidy imports`, agent: "opencode", agent_label: "OpenCode", agent_chain: ["opencode"], finished_at: at(n + 2), list_price_usd: 0, worktree: null }));
  return {
    projects: [project(1, "mathutils", "/home/you/code/mathutils", 2, 27), project(2, "notes-app", "/home/you/code/notes-app", 2, 3)],
    agents: [
      claude,
      codex,
      opencode,
      reviewer,
      // M6.5: the paid-overflow agent (runs only after "Paid — up to $X")
      agent("opencode-paid", "Paid overflow (OpenCode)", { cli: "opencode", paid: true, success: { done: 1, failed: 0, rate: 1 } }),
      ...optional,
    ],
    jobs,
    nextJob: 32,
    nextProject: 3,
  };
}

const g = globalThis as unknown as { __sbJobs?: JobsStore };
export const jobsStore = (): JobsStore => (g.__sbJobs ??= seed());
export const resetJobsStore = () => {
  g.__sbJobs = seed();
};

const TEMPLATES = (): AgentTemplate[] => {
  const s = jobsStore();
  const by = (id: string) => s.agents.find((a) => a.id === id)!;
  return [
    { id: "claude-code", label: "Claude Code", cli: "claude", runnable: true, note: null, installed: true, models: by("claude-code").models, model: "claude-sonnet-5-5", levels: { "0": null, "1": null, "2": null, "3": CLAUDE_L3 } },
    { id: "codex", label: "Codex", cli: "codex", runnable: true, note: null, installed: true, models: [], model: null, levels: { "0": null, "1": null, "2": null, "3": OTHER_L3 } },
    { id: "opencode", label: "OpenCode", runnable: true, note: null, installed: true, models: ["opencode/big-pickle"], model: "opencode/big-pickle", levels: { "0": null, "1": null, "2": null, "3": OTHER_L3 } },
    { id: "gemini-cli", label: "Gemini CLI", runnable: false, note: "Not verified for jobs yet (only a Windows install was found).", installed: false, models: [], model: null, levels: NOT_VERIFIED("Gemini CLI") },
    { id: "grok-build", label: "Grok Build", runnable: false, note: "Not verified for jobs yet.", installed: false, models: [], model: null, levels: NOT_VERIFIED("Grok Build") },
  ];
};

function withoutEvents(j: JobView): JobView {
  const c = { ...j };
  delete c.events;
  return c;
}

function counts(list: JobView[]): JobCounts {
  const c = { queued: 0, running: 0, needs_approval: 0, waiting_reset: 0, done: 0, failed: 0, stopped: 0 } as Record<JobStatus, number>;
  for (const j of list) c[j.status]++;
  return { counts: c, all: list.length, needs_you: c.needs_approval, waiting: c.waiting_reset };
}

function previewOf(b: Record<string, unknown>): JobPreview | string {
  const s = jobsStore();
  const p = s.projects.find((x) => x.id === Number(b.project_id));
  if (!p) return "That project isn't on the Projects allowlist: add the folder first";
  const chain = (Array.isArray(b.agents) ? (b.agents as string[]) : []).filter(Boolean);
  const level = Number(b.autonomy ?? 1);
  const budget = typeof b.budget_list_usd === "number" ? b.budget_list_usd : 2;
  const rows = chain.map((id) => {
    const a = s.agents.find((x) => x.id === id);
    const reason = !a
      ? "Not in the fleet"
      : a.paused
        ? `${a.label} is paused (Agents page: Resume)`
        : a.allowed_project_ids && !a.allowed_project_ids.includes(p.id)
          ? `${a.label} isn't allowed to work in this project (Agents page: Edit)`
          : a.levels[String(level)];
    return { id, label: a?.label ?? id, reason: reason ?? null, chosen: false, account: a?.subscription ? a.subscription.account : null, window: a?.subscription?.tightest ?? null };
  });
  const first = rows.find((r) => !r.reason);
  if (first) first.chosen = true;
  const chosen = first ? s.agents.find((a) => a.id === first.id)! : null;
  const steps: string[] = [];
  if (chosen) {
    const who = chosen.label;
    steps.push(`Switchboard makes a separate copy of ${p.name} (a git worktree) on a new branch, switchboard/job-<number>. Your own folder and branch aren't touched.`);
    if (level <= 1) steps.push(`${who} reads the project and writes ${level === 1 ? "a plan" : "a report"}. It can't change files or run commands.`);
    if (level === 1) steps.push("Nothing more happens until you approve the plan (or reject it with a note).");
    if (level >= 1) steps.push(`${who} edits files in the copy and may only run test commands (such as python3 -m unittest, python -m unittest, python3 -m pytest, python -m pytest). No internet, no installs, no push.`);
    steps.push(level >= 1 ? "You review the changes file by file. Approving commits them on the job's branch; rejecting throws the copy away." : "You review the report. Nothing is changed or committed.");
    steps.push(chosen.cost === "reported" ? `It stops at $${budget.toFixed(2)} list price, 40 turns or 30 minutes per run, whichever comes first.` : `It stops at 40 turns or 30 minutes per run (${who} doesn't report its cost).`);
    const later = rows.slice(rows.indexOf(first!) + 1).map((r) => r.label);
    if (later.length) steps.push(`If ${who} can't start, ${later.join(", then ")} takes the job instead (only before it starts).`);
    steps.push("Nothing is pushed. To use the work, review and merge the branch yourself.");
  }
  const problem = level === 3 && b.budget_list_usd === undefined ? "Level 3 needs a budget for this job" : chosen ? null : "No agent can take this job now: " + rows.map((r) => `${r.label}: ${r.reason}`).join("; ");
  return {
    ok: !problem,
    problem,
    project: { id: p.id, name: p.name, path: p.path },
    autonomy: level,
    level: { runs: level === 0 ? ["read_only"] : level === 1 ? ["read_only", "edit"] : level === 2 ? ["edit"] : ["full"], review: level === 0 ? "result" : "diff", approve_plan: level === 1 },
    agents: rows,
    agent: chosen?.id ?? null,
    budget_list_usd: budget,
    cost_reported: chosen ? chosen.cost === "reported" : null,
    caps: { max_turns: 40, run_timeout_s: 1800, job_timeout_s: 7200 },
    branch: "switchboard/job-<number>",
    steps,
    waits_until: null,
    paid: false,
    paid_budget_usd: null,
    overflow: { ready: overflow.enabled && !!overflow.model, left_usd: overflow.left_usd, model: overflow.model },
  };
}

// --- M6.5: accounts and paid overflow (fixture state) --------------------------------------------------
const accounts: AccountsResponse = {
  clis: [
    {
      cli: "claude",
      label: "Claude",
      home_env: "CLAUDE_CONFIG_DIR",
      accounts: [
        { name: "default", label: null, logged_in: true, installed: true, plan: "pro", plan_label: "Claude Pro", home: "~/.claude", login_command: "claude auth login" },
        { name: "work", label: "Company Team seat", logged_in: true, installed: true, plan: "team", plan_label: "Claude Team", home: "~/.switchboard/accounts/claude/work", login_command: "CLAUDE_CONFIG_DIR=~/.switchboard/accounts/claude/work claude auth login" },
      ],
    },
    {
      cli: "codex",
      label: "Codex",
      home_env: "CODEX_HOME",
      accounts: [{ name: "default", label: null, logged_in: true, installed: true, plan: null, plan_label: null, home: "~/.codex", login_command: "codex login" }],
    },
  ],
};
const overflow: OverflowSettings = {
  enabled: false,
  monthly_usd: null,
  model: null,
  spent_usd: 0,
  left_usd: null,
  ready: false,
  models: [{ model: "grok", paid: true, providers: ["xai"] }],
  test_free_model: false,
};

function accountsRoute<T>(method: string, p: string, b: Record<string, unknown>): Result<T> | null {
  if (method === "GET" && p === "/accounts") return ok(accounts);
  if (method === "POST" && p === "/accounts") {
    const cli = accounts.clis.find((c) => c.cli === b.cli);
    const name = String(b.name ?? "");
    if (!cli) return fail(400, "Accounts are for subscription CLIs: claude, codex");
    if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(name) || name === "default") return fail(400, 'Use a short name: lowercase letters, digits and dashes (for example "work" or "personal").');
    const home = `~/.switchboard/accounts/${cli.cli}/${name}`;
    const login_command = `${cli.home_env}=${home} ${cli.cli === "claude" ? "claude auth login" : "codex login"}`;
    if (!cli.accounts.some((a) => a.name === name)) cli.accounts.push({ name, label: (b.label as string) || null, logged_in: false, installed: true, plan: null, plan_label: null, home, login_command });
    return ok({ cli: cli.cli, name, home, login_command });
  }
  let m = p.match(/^\/accounts\/([\w-]+)\/([\w-]+)(\/check)?$/);
  if (m) {
    const cli = accounts.clis.find((c) => c.cli === m![1]);
    const a = cli?.accounts.find((x) => x.name === m![2]);
    if (!cli || !a) return method === "DELETE" ? ok({ removed: true }) : fail(404, "no such account");
    if (method === "POST" && m[3]) return ok({ cli: cli.cli, name: a.name, logged_in: a.logged_in, plan: a.plan });
    if (method === "DELETE") {
      const s = jobsStore();
      const used = [...s.agents.filter((x) => x.account === a.name).map((x) => `agent ${x.label}`), ...s.projects.filter((x) => x.accounts?.[cli.cli] === a.name).map((x) => `project ${x.name}`)];
      if (used.length) return fail(409, `“${a.name}” is still used by ${used.join(", ")}. Change those first.`);
      cli.accounts = cli.accounts.filter((x) => x !== a);
      return ok({ removed: true });
    }
  }
  if (method === "GET" && p === "/subscriptions/windows") return ok({ accounts: SUBSCRIPTIONS(), guard: { save_at: 0.8, block_at: 1 } });
  if (p === "/settings/overflow") {
    if (method === "PUT") {
      if (b.enabled && b.monthly_usd == null) return fail(400, "Set a monthly budget to turn paid overflow on");
      if (b.enabled && !overflow.models.some((x) => x.model === b.model)) return fail(400, "Choose one of the paid models (connect a paid provider first)");
      Object.assign(overflow, { enabled: !!b.enabled, monthly_usd: (b.monthly_usd as number) ?? null, model: (b.model as string) ?? null });
      overflow.left_usd = overflow.monthly_usd != null ? Math.max(0, overflow.monthly_usd - overflow.spent_usd) : null;
      overflow.ready = overflow.enabled && !!overflow.model && (overflow.left_usd ?? 0) >= 0.05;
    }
    return ok(overflow);
  }
  m = p.match(/^\/projects\/(\d+)\/accounts$/);
  if (m && method === "PUT") {
    const pr = jobsStore().projects.find((x) => x.id === Number(m![1]));
    if (!pr) return fail(404, "no such project");
    const chosen = (b.accounts ?? {}) as Record<string, string>;
    for (const [cli, name] of Object.entries(chosen)) {
      if (!accounts.clis.find((c) => c.cli === cli)?.accounts.some((a) => a.name === name)) return fail(400, `There is no account called “${name}” (Settings → Accounts)`);
    }
    pr.accounts = Object.fromEntries(Object.entries(chosen).filter(([, n]) => n !== "default"));
    return ok(pr);
  }
  return null;
}

/** M6.5: what a job waiting on a usage limit can do instead (wait anyway, another provider, paid). */
function limitRoute<T>(j: JobView, action: string, b: Record<string, unknown>): Result<T> {
  const s = jobsStore();
  const waiting = j.status === "waiting_reset" || (j.status === "needs_approval" && j.gate === "limit");
  if (!waiting) return fail(409, `Job ${j.id} isn't waiting for a usage limit (it is ${j.status})`);
  if (action === "wait") {
    if (j.gate !== "limit") return fail(409, `Job ${j.id} isn't asking about a long wait (it is ${j.status})`);
    Object.assign(j, { status: "waiting_reset", gate: null, updated_at: new Date().toISOString() });
    return ok(withoutEvents(j));
  }
  if (action === "reroute") {
    const a = s.agents.find((x) => x.id === b.agent);
    const cur = s.agents.find((x) => x.id === j.agent);
    if (!a) return fail(400, "Pick an agent from the fleet (paid overflow has its own button)");
    if (cur && a.cli === cur.cli) return fail(400, `${a.label} uses the same provider: Switchboard never switches accounts of one provider to get around a limit. Pick another provider.`);
    Object.assign(j, { agent: a.id, agent_label: a.label, agent_chain: [...j.agent_chain, a.id], status: "queued", gate: null, resume_at: null, attempt: (j.attempt ?? 0) + 1 });
    return ok(withoutEvents(j));
  }
  if (!overflow.ready) return fail(409, "Paid overflow is off (Settings → Subscriptions → Paid overflow)");
  const budget = Number(b.budget_usd);
  if (overflow.left_usd != null && budget > overflow.left_usd) return fail(409, `That is more than this month's paid-overflow budget left ($${overflow.left_usd.toFixed(2)})`);
  Object.assign(j, { agent: "opencode-paid", agent_label: "Paid overflow (OpenCode)", paid: true, paid_budget_usd: budget, status: "queued", gate: null, resume_at: null, attempt: (j.attempt ?? 0) + 1 });
  return ok(withoutEvents(j));
}

export function handleJobs<T>(method: string, path: string, body: unknown): Result<T> {
  const s = jobsStore();
  const url = new URL(path, "http://fixture");
  const p = url.pathname;
  const b = (body ?? {}) as Record<string, unknown>;
  const find = (id: string | number) => s.jobs.find((j) => j.id === Number(id));
  const filt = (list: JobView[]) => {
    const agent = url.searchParams.get("agent");
    const pid = Number(url.searchParams.get("project_id") ?? 0);
    return list.filter((j) => (!agent || j.agent === agent) && (!pid || j.project_id === pid));
  };

  const acct = accountsRoute<T>(method, p, b);
  if (acct) return acct;
  const lim = p.match(/^\/jobs\/(\d+)\/(wait|reroute|paid)$/);
  if (lim && method === "POST") {
    const j = find(lim[1]);
    return j ? limitRoute<T>(j, lim[2], b) : fail(404, "no such job");
  }

  // --- jobs
  if (method === "GET" && p === "/jobs") {
    const st = url.searchParams.get("status");
    const before = Number(url.searchParams.get("before") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 50);
    const list = filt(s.jobs).filter((j) => (!st || j.status === st) && (!before || j.id < before));
    const page = list.slice(0, limit);
    return ok({ jobs: page.map(withoutEvents), next: list.length > limit ? page[page.length - 1].id : null });
  }
  if (method === "GET" && p === "/jobs/counts") return ok(counts(filt(s.jobs)));
  if (method === "GET" && p === "/jobs/proposal") {
    const rid = Number(url.searchParams.get("request_id"));
    return ok({ request_id: rid, private: rid === 999, rule: "code_job", suggested: true, agents: ["claude-code", "opencode"], autonomy: 1 });
  }
  if (method === "POST" && p === "/jobs/preview") {
    const pv = previewOf(b);
    return typeof pv === "string" ? fail(400, pv) : ok(pv);
  }
  if (method === "POST" && p === "/jobs") {
    const pv = previewOf(b);
    if (typeof pv === "string") return fail(400, pv);
    const pr = s.projects.find((x) => x.id === Number(b.project_id))!;
    const chain = b.agents as string[];
    const a = s.agents.find((x) => x.id === chain[0]);
    const j = job(s.nextJob++, "queued", {
      title: String(b.title ?? b.prompt ?? "").split("\n")[0].slice(0, 200),
      prompt: String(b.prompt ?? ""),
      agent: chain[0],
      agent_label: a?.label ?? chain[0],
      agent_chain: chain,
      autonomy: Number(b.autonomy ?? 1),
      budget_list_usd: pv.budget_list_usd,
      project_id: pr.id,
      project: { id: pr.id, name: pr.name, path: pr.path },
      request_id: typeof b.from_request_id === "number" ? b.from_request_id : null,
      created_at: new Date().toISOString(),
      started_at: null,
      worktree: null,
      branch: null,
      updated_at: new Date().toISOString(),
    });
    if (j.prompt.includes("[fixture:limit]")) {
      // Test trigger (fixture data only): the far-reset question, as when a reset is more than 12 h away.
      Object.assign(j, { status: "needs_approval", gate: "limit", phase: "edit", attempt: 1, waits: 1, resume_at: at(3 * 1440), started_at: j.created_at, approval_expires_at: at(1440) });
    }
    s.jobs.unshift(j);
    return ok(j);
  }
  let m = p.match(/^\/jobs\/(\d+)$/);
  if (m && method === "GET") {
    const j = find(m[1]);
    return j ? ok({ ...j, events: events(j) }) : fail(404, "no such job");
  }
  m = p.match(/^\/jobs\/(\d+)\/(approve|reject|stop)$/);
  if (m && method === "POST") {
    const j = find(m[1]);
    if (!j) return fail(404, "no such job");
    const note = typeof b.note === "string" && b.note ? b.note : null;
    if (m[2] === "stop") {
      if (!["done", "failed", "stopped"].includes(j.status)) Object.assign(j, { status: "stopped", error: "Stopped by you", finished_at: new Date().toISOString(), gate: null, worktree: null });
      return ok(j);
    }
    if (j.status !== "needs_approval") return fail(409, `Job ${j.id} isn't waiting for approval (it is ${j.status})`);
    if (m[2] === "reject") Object.assign(j, { status: "stopped", error: `You rejected the ${j.gate}${note ? `: ${note}` : ""}`, gate: null, finished_at: new Date().toISOString(), worktree: null });
    else if (j.gate === "plan") Object.assign(j, { status: "running", gate: null, phase: "edit", run_id: `run-${j.id}-1` });
    else Object.assign(j, { status: "done", finished_at: new Date().toISOString(), result: j.result ?? "Approved." });
    j.updated_at = new Date().toISOString();
    return ok(j);
  }
  m = p.match(/^\/jobs\/(\d+)\/diff$/);
  if (m && method === "GET") {
    const j = find(m[1]);
    if (!j || !j.worktree) return fail(404, "This job has no worktree (it made no changes, or its worktree was removed)");
    const diff: JobDiff = {
      branch: j.branch ?? "",
      base: j.base_sha ?? "",
      files: [
        { path: "mathutils.py", added: 5, removed: 0 },
        { path: "tests/test_mathutils.py", added: 7, removed: 1 },
        { path: "CHANGELOG.md", added: null, removed: null, new: true },
      ],
      diff: DIFF,
      truncated: false,
    };
    return ok(diff);
  }
  m = p.match(/^\/jobs\/(\d+)\/runs$/);
  if (m && method === "GET") {
    const j = find(m[1]);
    if (!j) return fail(404, "no such job");
    const runs = events(j)
      .filter((e) => e.kind === "run_started")
      .map((e) => ({ run: String(e.run), kind: String(e.run_kind), started_at: e.at, status: "succeeded", agent: j.agent }));
    if (runs.length && j.status === "running") runs[runs.length - 1].status = "running";
    return ok({ runs });
  }
  m = p.match(/^\/jobs\/(\d+)\/log$/);
  if (m && method === "GET") {
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const lines = offset ? [] : LOG;
    return ok({ run: url.searchParams.get("run"), lines, next: lines.length ? 4096 : null, offset });
  }

  // --- agents
  if (method === "GET" && p === "/agents") {
    const res: AgentsResponse = {
      agents: s.agents,
      templates: TEMPLATES(),
      bwrap: true,
      accounts: Object.fromEntries(accounts.clis.map((c) => [c.cli, c.accounts.map((a) => a.name)])),
      defaults: { max_active_per_agent: 1, per_job_list_usd: 2, per_agent_daily_list_usd: 10, per_agent_monthly_list_usd: null, max_turns: 40, run_timeout_s: 1800 },
    };
    return ok(res);
  }
  if (method === "POST" && p === "/agents") {
    const label = String(b.label ?? "").trim();
    const tpl = TEMPLATES().find((x) => x.id === b.template);
    if (!tpl) return fail(400, `No template called “${String(b.template)}” (config/agents.yaml)`);
    if (!tpl.runnable) return fail(400, tpl.note ?? `${tpl.label} can't run jobs yet, so it can't be hired`);
    if (!label) return fail(400, "Give the agent a name");
    if (s.agents.some((a) => a.label.toLowerCase() === label.toLowerCase())) return fail(409, `An agent called “${label}” already exists: pick another name`);
    if (b.default_autonomy === 3) return fail(400, tpl.levels["3"] ?? "Level 3 is off");
    const base = s.agents.find((a) => a.id === tpl.id)!;
    const id = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "agent";
    const row = agent(id, label, {
      ...base,
      id,
      label,
      template: tpl.id,
      hired: true,
      role: (b.role as string) || null,
      model: (b.model as string) || base.model,
      default_autonomy: (b.default_autonomy as number) ?? null,
      monthly_budget_list_usd: (b.monthly_list_usd as number) ?? null,
      allowed_project_ids: (b.allowed_project_ids as number[]) ?? null,
      active_jobs: 0,
      current_job: null,
      success: { done: 0, failed: 0, rate: null },
      month_list_usd: 0,
      spent_today_list_usd: 0,
    });
    s.agents.splice(s.agents.findIndex((a) => !a.runnable), 0, row);
    return ok(row);
  }
  m = p.match(/^\/agents\/([\w-]+)(?:\/(pause|resume|reset))?$/);
  if (m) {
    const a = s.agents.find((x) => x.id === m![1]);
    if (!a) return fail(404, "No such agent");
    if (method === "DELETE") {
      if (!a.hired) return fail(400, "Built-in agents can't be deleted: pause it instead, or reset it to default");
      if (a.active_jobs) return fail(409, "This agent still has a job in progress: stop it or wait for it to finish");
      s.agents = s.agents.filter((x) => x !== a);
      return ok({ deleted: true });
    }
    if (method === "POST" && m[2] === "pause") return ok(Object.assign(a, { paused: true }));
    if (method === "POST" && m[2] === "resume") return ok(Object.assign(a, { paused: false }));
    if (method === "POST" && m[2] === "reset") return ok(Object.assign(a, { edited: false, paused: false, role: null, default_autonomy: null, monthly_budget_list_usd: null, allowed_project_ids: null }));
    if (method === "PATCH") {
      const patch: Partial<AgentRow> = {};
      if ("label" in b && b.label) patch.label = String(b.label);
      if ("role" in b) patch.role = (b.role as string) || null;
      if ("model" in b) patch.model = (b.model as string) || null;
      if ("default_autonomy" in b) patch.default_autonomy = b.default_autonomy as number | null;
      if ("monthly_list_usd" in b) patch.monthly_budget_list_usd = b.monthly_list_usd as number | null;
      if ("allowed_project_ids" in b) patch.allowed_project_ids = b.allowed_project_ids as number[] | null;
      if ("account" in b) patch.account = (b.account as string) || null;
      return ok(Object.assign(a, patch, { edited: !a.hired || a.edited }));
    }
  }

  // --- projects
  if (method === "GET" && p === "/projects") return ok({ projects: s.projects });
  if (method === "POST" && p === "/projects") {
    const raw = String(b.path ?? "").trim();
    const path = raw.startsWith("~/") ? `/home/you${raw.slice(1)}` : raw;
    if (!path.startsWith("/")) return fail(400, "Use the folder's full path, such as /home/you/myrepo or ~/myrepo");
    if (/\/switchboard\/?$/.test(path)) return fail(403, "That is the Switchboard repository itself. Agents can't work on the app that runs them; use another folder.");
    if (path.includes("missing")) return fail(404, "That folder doesn't exist (check the spelling; paths are case-sensitive)");
    if (path.includes("plain")) return fail(400, "That folder isn't a git repository: agents work on a new branch, so it needs git");
    const existing = s.projects.find((x) => x.path === path);
    if (existing) return ok(existing);
    const name = path.replace(/\/$/, "").split("/").pop() || "project";
    const row = project(s.nextProject++, name, path);
    s.projects.push(row);
    return ok(row);
  }
  m = p.match(/^\/projects\/(\d+)(?:\/(worktrees|cleanup))?$/);
  if (m) {
    const pr = s.projects.find((x) => x.id === Number(m![1]));
    if (method === "DELETE") {
      if (!pr) return ok({ removed: true });
      if (pr.active_jobs) return fail(409, `${pr.active_jobs} job(s) are still active in this project: stop them first`);
      s.projects = s.projects.filter((x) => x !== pr);
      return ok({ removed: true });
    }
    if (!pr) return fail(404, "no such project");
    const wts: ProjectWorktrees = {
      worktrees: s.jobs
        .filter((j) => j.project_id === pr.id && j.worktree)
        .map((j) => ({ job_id: j.id, path: j.worktree!, branch: j.branch ?? "", tip: "b".repeat(40), merged: j.id === 25, bytes: 182_000 + j.id * 1_000 })),
      bytes: null,
      keep: 10,
    };
    wts.bytes = wts.worktrees.reduce((n, w) => n + (w.bytes ?? 0), 0);
    if (m[2] === "cleanup" && method === "POST") {
      for (const j of s.jobs) if (j.project_id === pr.id && j.id === 25) j.worktree = null;
      wts.worktrees = wts.worktrees.filter((w) => w.job_id !== 25);
      wts.bytes = wts.worktrees.reduce((n, w) => n + (w.bytes ?? 0), 0);
    }
    return ok(wts);
  }
  return fail(404, `fixture: no route for ${method} ${p}`);
}

/** The job's SSE stream in fixture mode: a snapshot, the log (resumable by line), then `end` if finished. */
export function streamJob(path: string, lastEventId: string | null): Response {
  const m = path.match(/^\/jobs\/(\d+)\/events/);
  const j = m ? jobsStore().jobs.find((x) => x.id === Number(m[1])) : undefined;
  if (!j) return new Response("not found", { status: 404 });
  const enc = new TextEncoder();
  const from = lastEventId?.startsWith("log:") ? Number(lastEventId.split(":")[2] ?? 0) : 0;
  const body = new ReadableStream({
    async start(c) {
      const send = (s: string) => c.enqueue(enc.encode(s));
      send(`event: job\ndata: ${JSON.stringify(withoutEvents(j))}\n\n`);
      if (j.run_id) {
        for (let i = from; i < LOG.length; i++) {
          await new Promise((r) => setTimeout(r, 60));
          send(`event: log\ndata: ${JSON.stringify({ run: j.run_id, ...LOG[i] })}\n\n`);
          send(`id: log:${j.run_id}:${i + 1}\n\n`);
        }
      }
      if (["done", "failed", "stopped"].includes(j.status)) {
        send(`event: end\ndata: ${JSON.stringify({ status: j.status })}\n\n`);
        c.close();
        return;
      }
      // Stay open like the router does (it closes when the job ends); a keep-alive comment every 15 s.
      const timer = setInterval(() => {
        try {
          send(": keep-alive\n\n");
        } catch {
          clearInterval(timer);
        }
      }, 15_000);
    },
  });
  return new Response(body, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform" } });
}

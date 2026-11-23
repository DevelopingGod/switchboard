"use server";

import { revalidatePath } from "next/cache";
import { routerGetAdmin, routerSend, type Result } from "@/lib/server/router";
import type {
  ActionResult,
  AgentInput,
  AgentRow,
  AgentsResponse,
  JobDiff,
  JobInput,
  JobLogPage,
  JobPreview,
  JobProposal,
  JobRun,
  JobsPage,
  JobView,
  ProjectRow,
  ProjectWorktrees,
  OverflowSettings,
} from "@/lib/router-types";
import type { PackLibrary, ProjectPacks } from "@/lib/packs-types";

/**
 * Jobs, the agent fleet and projects (M4b). Every call goes to the router from the server with the admin
 * token; the browser only ever sees the results. Inputs are checked here for shape, and the router checks
 * everything again (allowlist, secrets, availability, budgets).
 */

const res = <T>(r: Result<T>): ActionResult<T> =>
  r.ok ? { ok: true, data: r.data } : { ok: false, error: r.error, code: r.code, detail: r.detail };

const AGENT_ID = /^[a-z][a-z0-9-]{1,63}$/;
const STATUSES = new Set(["queued", "running", "needs_approval", "waiting_reset", "done", "failed", "stopped"]);
const RUN_ID = /^[\w-]{1,64}$/;

function jobBody(input: JobInput): Record<string, unknown> | string {
  const prompt = String(input.prompt ?? "").trim();
  if (!prompt) return "Describe the task first.";
  if (prompt.length > 32_000) return "The task is too long (32,000 characters at most).";
  if (!Number.isInteger(input.project_id) || input.project_id < 1) return "Pick a project.";
  const agents = (input.agents ?? []).filter((a) => AGENT_ID.test(a));
  if (!agents.length) return "Pick at least one agent.";
  if (![0, 1, 2, 3].includes(input.autonomy)) return "Autonomy is 0, 1, 2 or 3.";
  const out: Record<string, unknown> = { prompt, project_id: input.project_id, agents: agents.slice(0, 8), autonomy: input.autonomy };
  if (input.budget_list_usd !== undefined) {
    if (!(typeof input.budget_list_usd === "number" && input.budget_list_usd > 0 && input.budget_list_usd <= 1000)) return "Enter a budget between $0.01 and $1,000.";
    out.budget_list_usd = input.budget_list_usd;
  }
  if (input.paid_budget_usd !== undefined) {
    if (!(typeof input.paid_budget_usd === "number" && input.paid_budget_usd > 0 && input.paid_budget_usd <= 1000)) return "Enter a paid budget between $0.01 and $1,000.";
    out.paid_budget_usd = input.paid_budget_usd;
  }
  if (input.title) out.title = String(input.title).slice(0, 200);
  if (input.from_request_id !== undefined && Number.isInteger(input.from_request_id)) out.from_request_id = input.from_request_id;
  const ids = input.attachment_ids ?? [];
  if (ids.length > 5 || !ids.every((i) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(i))) return "At most 5 files per job.";
  if (ids.length) out.attachment_ids = ids;
  if (input.flow) {
    if (!/^[a-z0-9-]{1,41}\.[a-z0-9-]{1,20}$/.test(input.flow)) return "Unknown workflow.";
    out.flow = input.flow;
  }
  return out;
}

export async function previewJob(input: JobInput): Promise<ActionResult<JobPreview>> {
  const body = jobBody(input);
  if (typeof body === "string") return { ok: false, error: body };
  return res(await routerSend<JobPreview>("POST", "/jobs/preview", body, 45_000));
}

export async function createJob(input: JobInput): Promise<ActionResult<JobView>> {
  const body = jobBody(input);
  if (typeof body === "string") return { ok: false, error: body };
  const r = await routerSend<JobView>("POST", "/jobs", body, 45_000);
  revalidatePath("/jobs");
  return res(r);
}

export async function loadProposal(requestId: number): Promise<ActionResult<JobProposal>> {
  if (!Number.isInteger(requestId) || requestId < 1) return { ok: false, error: "Invalid request." };
  return res(await routerGetAdmin<JobProposal>(`/jobs/proposal?request_id=${requestId}`));
}

/** What the Run as job / New job dialog needs: the fleet and the projects. */
export async function loadJobChoices(): Promise<ActionResult<{ agents: AgentsResponse; projects: ProjectRow[] }>> {
  const [a, p] = await Promise.all([routerGetAdmin<AgentsResponse>("/agents"), routerGetAdmin<{ projects: ProjectRow[] }>("/projects")]);
  if (!a.ok) return res(a);
  if (!p.ok) return res(p);
  return { ok: true, data: { agents: a.data, projects: p.data.projects } };
}

export async function loadJobsPage(q: { status?: string; agent?: string; project?: number; before?: number }): Promise<ActionResult<JobsPage>> {
  const sp = new URLSearchParams({ limit: "25" });
  if (q.status && STATUSES.has(q.status)) sp.set("status", q.status);
  if (q.agent && AGENT_ID.test(q.agent)) sp.set("agent", q.agent);
  if (q.project && Number.isInteger(q.project)) sp.set("project_id", String(q.project));
  if (q.before && Number.isInteger(q.before)) sp.set("before", String(q.before));
  return res(await routerGetAdmin<JobsPage>(`/jobs?${sp}`));
}

async function decide(id: number, action: "approve" | "reject" | "stop", note?: string, setupEdits?: string[]): Promise<ActionResult<JobView>> {
  if (!Number.isInteger(id) || id < 1) return { ok: false, error: "Invalid job." };
  const edits = (setupEdits ?? []).filter((p) => typeof p === "string" && p.length > 0 && p.length <= 1000).slice(0, 200);
  const body = action === "stop" ? undefined : { note: note?.trim() ? note.trim().slice(0, 2000) : null, ...(edits.length ? { include_setup_edits: edits } : {}) };
  const r = await routerSend<JobView>("POST", `/jobs/${id}/${action}`, body, 60_000);
  revalidatePath("/jobs");
  revalidatePath(`/jobs/${id}`);
  return res(r);
}

export const approveJob = async (id: number, note?: string, setupEdits?: string[]) => decide(id, "approve", note, setupEdits);
export const rejectJob = async (id: number, note?: string) => decide(id, "reject", note);
export const stopJob = async (id: number) => decide(id, "stop");

// --- M6.5: a job waiting on a subscription usage limit (ADR 0014) ----------------------------------------
async function limitAction(id: number, path: string, body?: unknown): Promise<ActionResult<JobView>> {
  if (!Number.isInteger(id) || id < 1) return { ok: false, error: "Invalid job." };
  const r = await routerSend<JobView>("POST", `/jobs/${id}/${path}`, body, 60_000);
  revalidatePath("/jobs");
  revalidatePath(`/jobs/${id}`);
  return res(r);
}

export const waitForReset = async (id: number) => limitAction(id, "wait");

export async function rerouteJob(id: number, agent: string): Promise<ActionResult<JobView>> {
  if (!AGENT_ID.test(agent)) return { ok: false, error: "Pick an agent." };
  return limitAction(id, "reroute", { agent });
}

export async function choosePaidOverflow(id: number, budgetUsd: number): Promise<ActionResult<JobView>> {
  if (!(Number.isFinite(budgetUsd) && budgetUsd > 0 && budgetUsd <= 1000)) return { ok: false, error: "Enter a budget between $0.01 and $1,000." };
  return limitAction(id, "paid", { budget_usd: Math.round(budgetUsd * 100) / 100 });
}

export async function loadOverflow(): Promise<ActionResult<OverflowSettings>> {
  return res(await routerGetAdmin<OverflowSettings>("/settings/overflow"));
}

export async function loadDiff(id: number): Promise<ActionResult<JobDiff>> {
  if (!Number.isInteger(id) || id < 1) return { ok: false, error: "Invalid job." };
  return res(await routerGetAdmin<JobDiff>(`/jobs/${id}/diff`));
}

export async function loadRuns(id: number): Promise<ActionResult<{ runs: JobRun[] }>> {
  if (!Number.isInteger(id) || id < 1) return { ok: false, error: "Invalid job." };
  return res(await routerGetAdmin<{ runs: JobRun[] }>(`/jobs/${id}/runs`));
}

export async function loadLog(id: number, run: string, offset = 0): Promise<ActionResult<JobLogPage>> {
  if (!Number.isInteger(id) || id < 1 || !RUN_ID.test(run) || !Number.isInteger(offset) || offset < 0) return { ok: false, error: "Invalid request." };
  return res(await routerGetAdmin<JobLogPage>(`/jobs/${id}/log?run=${encodeURIComponent(run)}&offset=${offset}`));
}

// --- the fleet ------------------------------------------------------------------------------------------
function agentBody(input: AgentInput): Record<string, unknown> | string {
  const out: Record<string, unknown> = {};
  if (input.template !== undefined) {
    if (!AGENT_ID.test(input.template)) return "Pick a template.";
    out.template = input.template;
  }
  if (input.label !== undefined) {
    const l = String(input.label).trim();
    if (!l || l.length > 80) return "Give the agent a name (80 characters at most).";
    out.label = l;
  }
  if (input.role !== undefined) out.role = input.role === null ? null : String(input.role).slice(0, 2000);
  if (input.model !== undefined) out.model = input.model || null;
  if (input.default_autonomy !== undefined) {
    if (input.default_autonomy !== null && ![0, 1, 2, 3].includes(input.default_autonomy)) return "Autonomy is 0, 1, 2 or 3.";
    out.default_autonomy = input.default_autonomy;
  }
  if (input.monthly_list_usd !== undefined) {
    const v = input.monthly_list_usd;
    if (v !== null && !(typeof v === "number" && v > 0 && v <= 10_000)) return "Enter a monthly budget above $0, or leave it empty.";
    out.monthly_list_usd = v;
  }
  if (input.account !== undefined) {
    if (input.account !== null && !/^[a-z0-9][a-z0-9-]{0,30}$/.test(input.account)) return "Invalid account.";
    out.account = input.account;
  }
  if (input.allowed_project_ids !== undefined) {
    const v = input.allowed_project_ids;
    if (v !== null && !(Array.isArray(v) && v.every((x) => Number.isInteger(x) && x > 0))) return "Invalid projects.";
    out.allowed_project_ids = v;
  }
  return out;
}

const fleetDone = <T>(r: Result<T>) => {
  revalidatePath("/jobs/agents");
  revalidatePath("/jobs");
  return res(r);
};

export async function hireAgent(input: AgentInput): Promise<ActionResult<AgentRow>> {
  const body = agentBody(input);
  if (typeof body === "string") return { ok: false, error: body };
  return fleetDone(await routerSend<AgentRow>("POST", "/agents", body));
}

export async function editAgent(id: string, input: AgentInput): Promise<ActionResult<AgentRow>> {
  if (!AGENT_ID.test(id)) return { ok: false, error: "Invalid agent." };
  const body = agentBody(input);
  if (typeof body === "string") return { ok: false, error: body };
  return fleetDone(await routerSend<AgentRow>("PATCH", `/agents/${id}`, body));
}

export async function agentAction(id: string, action: "pause" | "resume" | "reset" | "delete"): Promise<ActionResult<AgentRow | { deleted: true }>> {
  if (!AGENT_ID.test(id)) return { ok: false, error: "Invalid agent." };
  if (action === "delete") return fleetDone(await routerSend<{ deleted: true }>("DELETE", `/agents/${id}`));
  return fleetDone(await routerSend<AgentRow>("POST", `/agents/${id}/${action}`));
}

// --- projects -------------------------------------------------------------------------------------------
export async function addProject(path: string): Promise<ActionResult<ProjectRow>> {
  const p = String(path ?? "").trim();
  if (!p) return { ok: false, error: "Enter the folder's path, such as /home/you/myrepo or ~/myrepo." };
  if (p.length > 4096 || p.includes("\0")) return { ok: false, error: "That path is too long." };
  const r = await routerSend<ProjectRow>("POST", "/projects", { path: p }, 30_000);
  revalidatePath("/settings/projects");
  return res(r);
}

export async function removeProject(id: number): Promise<ActionResult<{ removed: boolean }>> {
  if (!Number.isInteger(id) || id < 1) return { ok: false, error: "Invalid project." };
  const r = await routerSend<{ removed: boolean }>("DELETE", `/projects/${id}`);
  revalidatePath("/settings/projects");
  return res(r);
}

/** M6.5 (ADR 0013): which account each subscription CLI uses for this project's new jobs. */
export async function setProjectAccounts(id: number, accounts: Record<string, string>): Promise<ActionResult<ProjectRow>> {
  if (!Number.isInteger(id) || id < 1) return { ok: false, error: "Invalid project." };
  const clean: Record<string, string> = {};
  for (const [cli, name] of Object.entries(accounts)) {
    if (!/^[a-z][a-z0-9-]{0,15}$/.test(cli) || !/^[a-z0-9][a-z0-9-]{0,30}$/.test(name)) return { ok: false, error: "Invalid account." };
    clean[cli] = name;
  }
  const r = await routerSend<ProjectRow>("PUT", `/projects/${id}/accounts`, { accounts: clean });
  revalidatePath("/settings/projects");
  return res(r);
}

export async function loadWorktrees(id: number): Promise<ActionResult<ProjectWorktrees>> {
  if (!Number.isInteger(id) || id < 1) return { ok: false, error: "Invalid project." };
  return res(await routerGetAdmin<ProjectWorktrees>(`/projects/${id}/worktrees`));
}

export async function cleanupProject(id: number): Promise<ActionResult<ProjectWorktrees>> {
  if (!Number.isInteger(id) || id < 1) return { ok: false, error: "Invalid project." };
  const r = await routerSend<ProjectWorktrees>("POST", `/projects/${id}/cleanup`, undefined, 60_000);
  revalidatePath("/settings/projects");
  return res(r);
}

// --- M4.5a: workflow packs per project ------------------------------------------------------------------------
const PACK_ID = /^[a-z0-9][a-z0-9-]{0,40}$/;
const HOSTS = new Set(["claude-code", "codex", "opencode", "gemini-cli", "grok-build", "hermes"]);

export async function loadProjectPacks(projectId: number): Promise<ActionResult<ProjectPacks>> {
  if (!Number.isInteger(projectId) || projectId < 1) return { ok: false, error: "Invalid project." };
  return res(await routerGetAdmin<ProjectPacks>(`/projects/${projectId}/packs`));
}

export async function setProjectPacks(projectId: number, packs: Record<string, { enabled?: boolean; mode?: string; hosts?: string[]; turn_back_on?: boolean }>): Promise<ActionResult<ProjectPacks>> {
  if (!Number.isInteger(projectId) || projectId < 1) return { ok: false, error: "Invalid project." };
  const body: Record<string, Record<string, unknown>> = {};
  for (const [id, c] of Object.entries(packs ?? {})) {
    if (!PACK_ID.test(id) || typeof c !== "object" || c === null) return { ok: false, error: "Invalid pack." };
    const e: Record<string, unknown> = {};
    if (typeof c.enabled === "boolean") e.enabled = c.enabled;
    if (c.mode !== undefined) {
      if (!["auto", "always", "off"].includes(String(c.mode))) return { ok: false, error: "Invalid mode." };
      e.mode = c.mode;
    }
    if (c.hosts !== undefined) {
      if (!Array.isArray(c.hosts) || !c.hosts.every((h) => HOSTS.has(h))) return { ok: false, error: "Invalid agents." };
      e.hosts = c.hosts;
    }
    if (c.turn_back_on === true) e.turn_back_on = true;
    body[id] = e;
  }
  const r = await routerSend<ProjectPacks>("PUT", `/projects/${projectId}/packs`, { packs: body });
  revalidatePath("/settings/projects");
  return res(r);
}

/** The workflows a project can run (New job): installed packs turned on there, with their agents. */
export async function loadProjectFlows(projectId: number): Promise<ActionResult<{ id: string; label: string; steps: string[]; hosts: string[] }[]>> {
  if (!Number.isInteger(projectId) || projectId < 1) return { ok: false, error: "Invalid project." };
  const [lib, st] = await Promise.all([routerGetAdmin<PackLibrary>("/packs"), routerGetAdmin<ProjectPacks>(`/projects/${projectId}/packs`)]);
  if (!lib.ok) return res(lib);
  if (!st.ok) return res(st);
  const flows = lib.data.packs.flatMap((p) =>
    p.installed && st.data.packs[p.id]?.enabled ? p.flows.map((f) => ({ id: f.id, label: f.label, steps: f.steps, hosts: st.data.packs[p.id].hosts })) : [],
  );
  return { ok: true, data: flows };
}


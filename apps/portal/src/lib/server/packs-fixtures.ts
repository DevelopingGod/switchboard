import "server-only";
import type { Result } from "./router";
import type { PackLibrary, PackMetrics, PackPlan, PackRow, ProjectPacks } from "@/lib/packs-types";

/**
 * Workflow packs for PORTAL_DATA=fixture (M4.5a): the library, an install plan and its streamed log, per-project
 * settings and graphify's measuring. OpenSpec starts installed, graphify not (so its install can be tested), gstack
 * is listed and refused.
 */

const at = (minAgo: number) => new Date(Date.UTC(2026, 10, 23, 9, 0) - minAgo * 60_000).toISOString();

function pack(over: Partial<PackRow> & Pick<PackRow, "id" | "name" | "summary">): PackRow {
  return {
    trust: "verified",
    unverified: false,
    source: "",
    kind: "npm",
    package: null,
    version: null,
    homepage: null,
    repository: null,
    license: "MIT",
    hosts: ["claude-code", "codex", "opencode"],
    scope: ["project"],
    refused: null,
    lock_problem: null,
    installable: true,
    auto: null,
    flows: [],
    installed: null,
    previous: null,
    update: false,
    ...over,
  };
}

interface PacksStore {
  library: PackLibrary;
  projects: Record<number, ProjectPacks["packs"]>;
  jobs: Map<string, { id: string; pack: string }>;
}

function seed(): PacksStore {
  return {
    library: {
      packs: [
        pack({
          id: "graphify",
          name: "graphify",
          summary: "A local map of the code that agents query instead of reading every file.",
          source: "pypi:graphifyy==0.9.115",
          kind: "pypi",
          package: "graphifyy",
          version: "0.9.115",
          homepage: "https://graphify.com",
          repository: "https://github.com/Graphify-Labs/graphify",
          auto: "graph",
          installed: "0.9.114",
          update: true,
        }),
        pack({
          id: "gstack",
          name: "gstack",
          summary: "Role skills for plan reviews, code review, QA, shipping and security audits.",
          trust: "community",
          unverified: true,
          source: "git:https://github.com/garrytan/gstack",
          kind: "git",
          hosts: ["claude-code", "codex"],
          scope: ["global"],
          refused: "gstack installs into your home folder (~/.claude/skills), and Switchboard only installs packs inside a job's copy of the project.",
          installable: false,
          repository: "https://github.com/garrytan/gstack",
        }),
        pack({
          id: "openspec",
          name: "OpenSpec",
          summary: "Agree on a spec before code — propose, apply, archive.",
          source: "npm:@fission-ai/openspec@2.1.1",
          package: "@fission-ai/openspec",
          version: "2.1.1",
          homepage: "https://openspec.dev",
          repository: "https://github.com/Fission-AI/OpenSpec",
          installed: "2.1.1",
          flows: [
            {
              id: "openspec.change",
              label: "OpenSpec: propose → apply → archive",
              summary: "The agent writes a proposal you review, implements it after you approve, then archives the change.",
              steps: ["Propose", "Apply", "Archive"],
            },
          ],
        }),
      ],
      errors: {},
      hostprobe: true,
      store: "~/.switchboard/packs",
      network_isolated: true,
      history: [
        {
          id: 1,
          pack: "openspec",
          version: "2.1.1",
          action: "install",
          status: "ok",
          summary: { source: "https://www.npmjs.com/package/@fission-ai/openspec/v/2.1.1", dependencies: 65 },
          log_tail: "Recorded 2515 files; the folder is now read-only",
          started_at: at(90),
          finished_at: at(89),
        },
      ],
    },
    projects: {
      1: {
        openspec: { enabled: true, hosts: ["claude-code", "opencode"] },
        graphify: {
          mode: "auto",
          hosts: ["claude-code", "codex", "opencode"],
          groups: [
            { group: "claude-code|plain", agent: "claude-code", flow: null, state: "on", status: "Saves 23% tokens (rechecks in 12 jobs)", numbers: { with: 61000, without: 79000, gain: 0.23, samples: 5 } },
            { group: "opencode|openspec.change", agent: "opencode", flow: "openspec.change", state: "measuring", status: "Measuring (2 of 5)", numbers: null },
          ],
          auto_threshold: { min_files: 1500, min_bytes: 20_000_000 },
        },
      },
    },
    jobs: new Map(),
  };
}

const g = globalThis as unknown as { __sbPacks?: PacksStore };
const store = () => (g.__sbPacks ??= seed());

const ok = <T>(data: unknown): Result<T> => ({ ok: true, data: data as T });
const fail = <T>(status: number, error: string): Result<T> => ({ ok: false, status, error });

function projectPacks(id: number): ProjectPacks["packs"] {
  const s = store();
  if (!s.projects[id]) {
    s.projects[id] = {
      openspec: { enabled: false, hosts: ["claude-code", "codex", "opencode"] },
      graphify: { mode: "auto", hosts: ["claude-code", "codex", "opencode"], groups: [], auto_threshold: { min_files: 1500, min_bytes: 20_000_000 } },
    };
  }
  return s.projects[id];
}

/** Flows a project can run, for the New job dialog. */
export function flowsFor(projectId: number): { id: string; label: string; steps: string[]; hosts: string[] }[] {
  const s = store();
  const st = projectPacks(projectId);
  return s.library.packs.flatMap((p) => (p.installed && st[p.id]?.enabled ? p.flows.map((f) => ({ id: f.id, label: f.label, steps: f.steps, hosts: st[p.id].hosts })) : []));
}

const PLAN = (p: PackRow): PackPlan => ({
  id: p.id,
  name: p.name,
  summary: p.summary,
  trust: p.trust,
  unverified: p.unverified,
  kind: p.kind === "pypi" ? "pypi" : "npm",
  package: p.package ?? p.id,
  version: p.version ?? "1.0.0",
  source: p.kind === "pypi" ? `https://pypi.org/project/${p.package}/${p.version}/` : `https://www.npmjs.com/package/${p.package}/v/${p.version}`,
  repository: p.repository,
  hash: p.kind === "pypi" ? "b9398052672f0679c22889735ad279edbb91657e2f9388ab16daebc146bd24c5" : "sha512-GQv1xU4uLrTVJ6MfOKNIxo/BgEk+e8C/XBmjTfzd/W3LNh4v2UMAsfTdn8mjHdjDA/KjfGstwUhZedQW4hdcZQ==",
  dependencies: p.kind === "pypi" ? 30 : 65,
  lookalikes: p.id === "graphify" ? ["graphify"] : [],
  install_scripts: [],
  commands:
    p.kind === "pypi"
      ? [
          "download 31 wheels for cp312-manylinux_x86_64 from files.pythonhosted.org and pip 26.3, each checked against the lock's sha256",
          "(no network) python3 -m venv --without-pip",
          "(no network) pip install --no-index --require-hashes --only-binary :all:",
          "python -m compileall (before the files are recorded)",
          "write wrappers (graphify) that keep the tool's state inside a job's worktree",
          "record every file's sha256, then make the folder read-only",
          "graphify --version",
        ]
      : [
          "download 66 packages from registry.npmjs.org, each checked against the lock's sha512",
          "(no network) npm ci --offline --ignore-scripts",
          "write wrappers (openspec) that keep the tool's state inside a job's worktree",
          "record every file's sha256, then make the folder read-only",
          "openspec --version",
        ],
  writes: [`~/.switchboard/packs/${p.id}/${p.version}`],
  project_writes: p.id === "graphify" ? ["graphify-out/**", ".claude/skills/graphify/**", ".claude/settings.json"] : [".agents/skills/openspec-*/**", ".claude/skills/openspec-*"],
  artifacts: p.id === "openspec" ? ["openspec/**"] : [],
  requires: p.kind === "pypi" ? [{ name: "python", need: ">=3.11.5,<3.15", found: "3.12.3", ok: true }] : [{ name: "node", need: ">=22.20", found: "24.22.3", ok: true }],
  problem: null,
  network_isolated: true,
  current: p.installed,
  sudo: false,
  plan_id: `plan-${p.id}-0123456789`,
  expires_in: 300,
});

export function handle<T>(method: string, path: string, body: unknown): Result<T> {
  const s = store();
  const p = path.split("?")[0];
  const b = (body ?? {}) as Record<string, unknown>;
  if (method === "GET" && p === "/packs") return ok(s.library);
  let m = p.match(/^\/packs\/([\w-]+)\/(install-plan|install|rollback|uninstall|check)$/);
  if (m) {
    const row = s.library.packs.find((x) => x.id === m![1]);
    if (!row) return fail(404, "no such pack");
    if (row.refused) return fail(403, row.refused);
    if (m[2] === "install-plan") return ok(PLAN(row));
    if (m[2] === "install") {
      if (row.unverified && !b.accept_unverified) return fail(400, `${row.name} is unverified: confirm that you accept it before installing`);
      const id = `pk${s.jobs.size + 1}`;
      s.jobs.set(id, { id, pack: row.id });
      return ok({ id, cli: row.id, state: "running", exit_code: null });
    }
    if (m[2] === "check") return ok({ id: row.id, current: row.installed, verify: { ok: true, version: row.installed, ms: row.kind === "pypi" ? 196 : 64, files: row.kind === "pypi" ? 3445 : 2515, problem: null } });
    if (m[2] === "rollback") {
      if (!row.previous) return fail(409, "there is no previous version to roll back to");
      [row.installed, row.previous] = [row.previous, row.installed];
      row.update = row.installed !== row.version;
      return ok({ id: row.id, current: row.installed, previous: row.previous });
    }
    row.installed = null;
    row.previous = null;
    return ok({ id: row.id, removed: true });
  }
  m = p.match(/^\/projects\/(\d+)\/packs$/);
  if (m) {
    const id = Number(m[1]);
    const st = projectPacks(id);
    if (method === "PUT") {
      const changes = (b.packs ?? {}) as Record<string, Record<string, unknown>>;
      for (const [pid, c] of Object.entries(changes)) {
        if (!st[pid]) return fail(400, `${pid}: not an installable pack`);
        if (Array.isArray(c.hosts)) st[pid].hosts = c.hosts as string[];
        if (typeof c.enabled === "boolean") st[pid].enabled = c.enabled;
        if (typeof c.mode === "string") st[pid].mode = c.mode as "auto" | "always" | "off";
        if (c.turn_back_on) {
          st[pid].groups = [];
          if (st[pid].mode === "off") st[pid].mode = "auto";
        }
      }
    }
    return ok({ project_id: id, packs: st });
  }
  if (method === "GET" && p === "/metrics/packs") {
    const data: PackMetrics = {
      measure: { holdout_every: 5, min_samples: 5, min_gain: 0.1, recheck_every: 20 },
      rows: [
        { project_id: 1, project: "mathutils", agent: "claude-code", flow: null, state: "on", status: "Saves 23% tokens (rechecks in 12 jobs)", round: 1, median_with: 61000, median_without: 79000, cached_with: 41000, cached_without: 55000, samples_with: 12, samples_without: 5, cached_known: true, gain: 0.23 },
        { project_id: 1, project: "mathutils", agent: "opencode", flow: "openspec.change", state: "measuring", status: "Measuring (2 of 5)", round: 1, median_with: 18500, median_without: 21000, cached_with: 9000, cached_without: 10500, samples_with: 9, samples_without: 2, cached_known: true, gain: null },
      ],
    };
    return ok(data);
  }
  return fail(404, "no such fixture");
}

/** Canned SSE for a pack install; flips the pack to installed when it finishes. */
export function stream(path: string): Response {
  const s = store();
  const m = path.match(/\/packs\/jobs\/([\w-]+)\/events/);
  const job = m && s.jobs.get(m[1]);
  if (!job) return new Response("install job not found", { status: 404 });
  const row = s.library.packs.find((x) => x.id === job.pack)!;
  const lines = [
    "Downloading 31 files",
    "Checked 10 of 31 (hash and the name inside each file)",
    "Checked 20 of 31 (hash and the name inside each file)",
    "Checked 31 of 31 (hash and the name inside each file)",
    "python3 -m venv --without-pip (no network)",
    "pip install --no-index --require-hashes --only-binary :all:",
    "Compiling Python files before they are recorded",
    `Wrappers: ${row.id}`,
    `${row.id} --version: ${row.id} ${row.version}`,
    "Recorded 3445 files; the folder is now read-only",
    `Installed ${row.name} ${row.version}`,
  ];
  const enc = new TextEncoder();
  const body = new ReadableStream({
    async start(c) {
      let n = 0;
      for (const t of lines) {
        await new Promise((r) => setTimeout(r, 80));
        c.enqueue(enc.encode(`id: ${++n}\nevent: log\ndata: ${JSON.stringify({ t, r: false, p: null })}\n\n`));
      }
      row.previous = row.installed;
      row.installed = row.version;
      row.update = false;
      s.library.history.unshift({ id: s.library.history.length + 1, pack: row.id, version: row.version, action: "install", status: "ok", summary: {}, log_tail: lines.at(-1) ?? null, started_at: new Date().toISOString(), finished_at: new Date().toISOString() });
      c.enqueue(enc.encode(`event: exit\ndata: ${JSON.stringify({ state: "ok", exit_code: 0 })}\n\n`));
      c.close();
    },
  });
  return new Response(body, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform" } });
}

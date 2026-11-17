#!/usr/bin/env python3
"""hostprobe: detects agent CLIs inside WSL for the Router API (which runs in Docker).

Security rules (M1a, docs/m1a.md):
- Allowlist only: a fixed argv per CLI for version and auth status, hard-coded below. No request
  data ever reaches a command; never a shell (subprocess without shell=True).
- Returns only installed / version / logged_in (+ windows_only, login_method). Command output is
  reduced to a version string or a boolean and discarded. Credential files are checked with
  stat only: never opened, read or returned.
- Every request needs X-Probe-Token (constant-time compare). Listens on 127.0.0.1 only.
- 5 s timeout per command; rate limited; results cached for 30 s.
- Detection is read-only (GET /cli). Install (M1b) is the only action: a fixed, pinned spec per
  CLI (INSTALLS below). POST /install/{cli}/plan fetches the vendor installer (host-allowlisted,
  https only) and returns its exact commands and SHA-256; POST /install/{cli}/run with that plan_id
  runs those same bytes. No request field reaches a command. Never sudo (a sudo shim fails the
  call, and the service refuses to run installs as root); one install at a time; 10 min limit.
- Login is never run here: interactive OAuth stays in the user's terminal.

Stdlib only, so it runs on the system python3 without a venv.
"""

import argparse
import glob
import hashlib
import hmac
import json
import os
import re
import secrets
import shutil
import signal
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOME = Path.home()
CMD_TIMEOUT_S = 5
CACHE_TTL_S = 30
VERSION_RE = re.compile(r"\d+\.\d+(?:\.\d+)?(?:[-+.][0-9A-Za-z.\-]+)?")


@dataclass(frozen=True)
class CliSpec:
    bin: str
    auth_argv: tuple[str, ...] | None  # argv after the binary; None = no status command
    auth_kind: str  # how to read the status command: exit0 | codex | opencode
    auth_files: tuple[str, ...]  # relative to $HOME; stat only


# The allowlist. Verified against each CLI's docs/--help at M1a (see docs/m1a.md); grok's
# credential location is unverified until Grok Build is installed.
CLIS: dict[str, CliSpec] = {
    "claude": CliSpec("claude", ("auth", "status"), "exit0", (".claude/.credentials.json",)),
    "codex": CliSpec("codex", ("login", "status"), "codex", (".codex/auth.json",)),
    "gemini": CliSpec("gemini", None, "", (".gemini/oauth_creds.json",)),
    "grok": CliSpec("grok", None, "", (".grok/auth.json", ".config/grok/auth.json")),
    "opencode": CliSpec("opencode", ("auth", "list"), "opencode", (".local/share/opencode/auth.json",)),
}


def linux_path() -> list[str]:
    """A clean Linux PATH: never /mnt/* (Windows binaries via interop)."""
    nvm = sorted(glob.glob(str(HOME / ".nvm/versions/node/*/bin")), reverse=True)
    dirs = [
        *nvm,
        str(HOME / ".local/bin"),
        str(HOME / ".npm-global/bin"),
        str(HOME / ".bun/bin"),
        str(HOME / ".opencode/bin"),
        str(HOME / ".grok/bin"),
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
    ]
    return [d for d in dirs if not d.startswith("/mnt/")]


def which(name: str, path: list[str]) -> str | None:
    for d in path:
        p = os.path.join(d, name)
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    return None


def windows_copy(name: str) -> bool:
    patterns = [f"/mnt/c/Users/*/AppData/Roaming/npm/{name}", f"/mnt/c/Users/*/.local/bin/{name}.exe"]
    return any(glob.glob(p) for p in patterns)


def run(argv: list[str], path: list[str]) -> tuple[int | None, str]:
    """Run a fixed argv; returns (exit code or None on timeout/error, combined output)."""
    env = {"HOME": str(HOME), "PATH": ":".join(path), "NO_COLOR": "1", "TERM": "dumb", "CI": "1"}
    try:
        r = subprocess.run(  # noqa: S603 - argv comes only from the CLIS allowlist
            argv,
            capture_output=True,
            text=True,
            timeout=CMD_TIMEOUT_S,
            env=env,
            stdin=subprocess.DEVNULL,
            check=False,
        )
    except (subprocess.TimeoutExpired, OSError):
        return None, ""
    return r.returncode, (r.stdout or "") + (r.stderr or "")


def parse_auth(kind: str, code: int | None, out: str) -> bool | None:
    """Reduce a status command's output to True/False/None (unknown). Output is discarded."""
    if code is None:
        return None
    low = out.lower()
    if "unknown command" in low or "unrecognized" in low or "no such command" in low:
        return None
    if kind == "codex":
        return code == 0 and "logged in" in low and "not logged in" not in low
    if kind == "opencode":
        m = re.search(r"(\d+)\s+credentials?", low)
        return bool(m and int(m.group(1)) > 0) if m else None
    if kind == "exit0":
        if "not logged in" in low or "logged out" in low:
            return False
        return code == 0
    return None


def files_exist(rel_paths: tuple[str, ...]) -> bool:
    # os.path.exists stats the path; the file is never opened.
    return any(os.path.exists(HOME / rel) for rel in rel_paths)


def probe_cli(spec: CliSpec, path: list[str]) -> dict:
    exe = which(spec.bin, path)
    if exe is None:
        return {
            "installed": False,
            "version": None,
            "logged_in": None,
            "windows_only": windows_copy(spec.bin),
            "login_method": None,
        }
    code, out = run([exe, "--version"], path)
    m = VERSION_RE.search(out) if code == 0 else None
    logged_in, method = None, None
    if spec.auth_argv:
        code, out = run([exe, *spec.auth_argv], path)
        logged_in = parse_auth(spec.auth_kind, code, out)
        method = f"{spec.bin} {' '.join(spec.auth_argv)}"
        del out
    if logged_in is None and spec.auth_files:
        logged_in = files_exist(spec.auth_files)
        method = "credential file present (stat only)"
    return {
        "installed": True,
        "version": m.group(0) if m else None,
        "logged_in": logged_in,
        "windows_only": False,
        "login_method": method,
    }


def probe_all() -> dict:
    path = linux_path()
    return {"clis": {name: probe_cli(spec, path) for name, spec in CLIS.items()}, "at": int(time.time())}


class TokenBucket:
    def __init__(self, capacity: int, per_seconds: float):
        self.capacity, self.rate = capacity, capacity / per_seconds
        self.tokens, self.last = float(capacity), time.monotonic()
        self.lock = threading.Lock()

    def take(self) -> bool:
        with self.lock:
            now = time.monotonic()
            self.tokens = min(self.capacity, self.tokens + (now - self.last) * self.rate)
            self.last = now
            if self.tokens >= 1:
                self.tokens -= 1
                return True
            return False


class Probe:
    """Holds config, cache and rate limits; one per server."""

    def __init__(
        self,
        token: str,
        probe_fn=probe_all,
        request_limit=(60, 60.0),
        probe_limit=(6, 60.0),
        installer: "Installer | None" = None,
    ):
        if len(token) < 16:
            raise ValueError("HOSTPROBE_TOKEN must be at least 16 characters")
        self.token = token.encode()
        self.probe_fn = probe_fn
        self.requests = TokenBucket(*request_limit)
        self.probes = TokenBucket(*probe_limit)  # cache misses that spawn processes
        self.cache: tuple[float, dict] | None = None
        self.lock = threading.Lock()
        self.installer = installer or Installer(on_success=self.invalidate)

    def invalidate(self) -> None:
        with self.lock:
            self.cache = None

    def authorized(self, header: str | None) -> bool:
        return header is not None and hmac.compare_digest(header.encode(), self.token)

    def cli(self, fresh: bool = False) -> tuple[int, dict]:
        """`fresh` skips the 30 s cache (the "Check again" button); it still spends a probe token."""
        with self.lock:
            if not fresh and self.cache and time.monotonic() - self.cache[0] < CACHE_TTL_S:
                return 200, self.cache[1]
            if not self.probes.take():
                return 429, {"error": "rate limited"}
            data = self.probe_fn()
            self.cache = (time.monotonic(), data)
            return 200, data


# --- Install (M1b) -------------------------------------------------------------------------------
# One pinned spec per CLI, each the vendor's current recommended Linux method (checked 2026-11-17
# against the installers themselves). Scripts are downloaded at plan time, shown by SHA-256 and run
# from a file (never `curl | bash`). Re-verify versions and methods when bumping a pin.

INSTALL_PLAN_TTL_S = 300
INSTALL_TIMEOUT_S = 600
MAX_SCRIPT_BYTES = 2_000_000
MAX_LOG_LINES = 3000
MAX_LINE_CHARS = 400
ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")
TOKENISH_RE = re.compile(r"(?:sk-|gsk_|ghp_|xai-|AIza)[A-Za-z0-9_\-]{12,}")


@dataclass(frozen=True)
class InstallSpec:
    method: str  # "script" (vendor installer, run from a file) | "npm"
    source: str  # installer URL, or npm package name
    version: str
    docs: str  # official page that documents this method
    effects: tuple[str, ...]  # plain-language side effects, shown before confirm
    interpreter: str = "bash"
    args: tuple[str, ...] = ()
    env: tuple[tuple[str, str], ...] = ()
    hosts: tuple[str, ...] = ()  # https hosts the installer may be fetched from (incl. redirects)


INSTALLS: dict[str, InstallSpec] = {
    "claude": InstallSpec(
        "script",
        "https://claude.ai/install.sh",
        "2.1.311",
        "https://code.claude.com/docs/en/setup",
        ("Installs the claude binary under ~/.local/bin and data under ~/.claude. Version: stable channel.",),
        args=("2.1.311",),
        hosts=("claude.ai", "downloads.claude.ai"),
    ),
    "codex": InstallSpec(
        "script",
        "https://chatgpt.com/codex/install.sh",
        "0.169.0",
        "https://developers.openai.com/codex/cli",
        (
            "Installs codex under ~/.local/bin and data under ~/.codex.",
            "May add a PATH line to your shell profile (~/.bashrc or ~/.profile).",
        ),
        interpreter="sh",
        env=(("CODEX_RELEASE", "0.169.0"), ("CODEX_NON_INTERACTIVE", "1")),
        hosts=("chatgpt.com", "releases.openai.com"),
    ),
    "gemini": InstallSpec(
        "npm",
        "@google/gemini-cli",
        "0.68.0",
        "https://github.com/google-gemini/gemini-cli",
        ("Installs the gemini command into your Node (nvm) global prefix. Needs Node 20 or newer.",),
    ),
    "grok": InstallSpec(
        "script",
        "https://x.ai/cli/install.sh",
        "1.0.88",
        "https://x.ai/cli",
        (
            "Installs grok under ~/.grok/bin.",
            "May add a PATH line to your shell profile (~/.bashrc).",
            "Beta. A SuperGrok subscription or xAI API key is needed to log in.",
        ),
        args=("1.0.88",),
        hosts=("x.ai",),
    ),
    "opencode": InstallSpec(
        "script",
        "https://opencode.ai/install",
        "1.19.6",
        "https://opencode.ai/docs",
        ("Installs opencode under ~/.opencode/bin. Your shell profile is not changed.",),
        args=("--version", "1.19.6", "--no-modify-path"),
        hosts=("opencode.ai", "raw.githubusercontent.com"),
    ),
}


class InstallError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status, self.message = status, message


class _HostRedirect(urllib.request.HTTPRedirectHandler):
    def __init__(self, hosts: tuple[str, ...]):
        self.hosts = hosts

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        u = urllib.parse.urlparse(newurl)
        if u.scheme != "https" or u.hostname not in self.hosts:
            raise urllib.error.URLError(f"redirect to {u.hostname} is not allowed")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch_script(url: str, hosts: tuple[str, ...]) -> bytes:
    u = urllib.parse.urlparse(url)
    if u.scheme != "https" or u.hostname not in hosts:
        raise InstallError(400, "installer host is not allowed")
    opener = urllib.request.build_opener(_HostRedirect(hosts))
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "switchboard-hostprobe"})  # noqa: S310
        with opener.open(req, timeout=30) as r:  # https and host were checked above
            data = r.read(MAX_SCRIPT_BYTES + 1)
    except (urllib.error.URLError, OSError) as e:
        raise InstallError(502, f"could not download the installer ({type(e).__name__})") from None
    if len(data) > MAX_SCRIPT_BYTES or not data.startswith(b"#!"):
        raise InstallError(502, "the installer download does not look like a script")
    return data


def clean_line(line: str) -> str:
    """One log line: ANSI and control characters stripped, progress-bar rewrites collapsed, secrets masked."""
    line = line.rstrip("\r\n").split("\r")[-1]
    line = "".join(ch for ch in ANSI_RE.sub("", line) if ch == "\t" or ch >= " ")
    return TOKENISH_RE.sub("[redacted]", line)[:MAX_LINE_CHARS]


class Job:
    def __init__(self, job_id: str, cli: str):
        self.id, self.cli = job_id, cli
        self.lines: list[str] = []
        self.state = "running"  # running | ok | failed | cancelled | timeout
        self.exit_code: int | None = None
        self.cond = threading.Condition()
        self.proc: subprocess.Popen | None = None
        self.cancelled = False

    def add(self, line: str) -> None:
        with self.cond:
            if len(self.lines) < MAX_LOG_LINES:
                self.lines.append(line)
            self.cond.notify_all()

    def finish(self, state: str, code: int | None) -> None:
        with self.cond:
            self.state, self.exit_code = state, code
            self.cond.notify_all()

    def snapshot(self) -> dict:
        with self.cond:
            return {
                "id": self.id,
                "cli": self.cli,
                "state": self.state,
                "exit_code": self.exit_code,
                "lines": len(self.lines),
            }


SUDO_SHIM = "#!/bin/sh\necho 'sudo is not allowed in Switchboard installs' >&2\nexit 1\n"


class Installer:
    """Plans, runs and streams installs. One at a time. Everything executable comes from INSTALLS."""

    def __init__(
        self,
        specs: dict[str, InstallSpec] | None = None,
        fetch: Callable[[str, tuple[str, ...]], bytes] = fetch_script,
        path_fn: Callable[[], list[str]] = linux_path,
        on_success: Callable[[], None] | None = None,
        timeout_s: float = INSTALL_TIMEOUT_S,
        plan_limit: tuple[int, float] = (6, 60.0),
    ):
        self.specs = INSTALLS if specs is None else specs
        self.fetch, self.path_fn, self.on_success, self.timeout_s = fetch, path_fn, on_success, timeout_s
        self.plans: dict[str, dict] = {}
        self.jobs: dict[str, Job] = {}
        self.lock = threading.Lock()
        self.plan_bucket = TokenBucket(*plan_limit)

    # -- planning ------------------------------------------------------------------------------
    def _npm_prefix_ok(self, path: list[str]) -> str:
        npm = which("npm", path)
        if npm is None:
            raise InstallError(400, "Node.js (npm) is not installed in WSL; install Node via nvm first")
        code, out = run([npm, "prefix", "-g"], path)
        prefix = out.strip().splitlines()[-1] if out.strip() else ""
        if code != 0 or not prefix.startswith(str(HOME) + os.sep):
            raise InstallError(
                400, "npm's global prefix is not inside your home directory; refusing (no sudo)"
            )
        return npm

    def plan(self, cli: str) -> dict:
        spec = self.specs.get(cli)
        if spec is None:
            raise InstallError(404, "unknown cli")
        if not self.plan_bucket.take():
            raise InstallError(429, "rate limited")
        path = self.path_fn()
        plan: dict = {
            "cli": cli,
            "method": spec.method,
            "source": spec.source
            if spec.method == "script"
            else f"https://www.npmjs.com/package/{spec.source}",
            "docs": spec.docs,
            "version": spec.version,
            "effects": list(spec.effects),
            "sudo": False,
            "env": dict(spec.env),
        }
        if spec.method == "script":
            body = self.fetch(spec.source, spec.hosts)
            plan["sha256"] = hashlib.sha256(body).hexdigest()
            plan["size"] = len(body)
            plan["commands"] = [
                f"download {spec.source} (sha256 {plan['sha256'][:16]}…, {len(body)} bytes)",
                " ".join([*(f"{k}={v}" for k, v in spec.env), spec.interpreter, "install.sh", *spec.args]),
            ]
        else:
            self._npm_prefix_ok(path)
            body = b""
            plan["commands"] = [f"npm install -g {spec.source}@{spec.version}"]
        plan_id = secrets.token_urlsafe(24)
        with self.lock:
            now = time.monotonic()
            self.plans = {k: v for k, v in self.plans.items() if v["expires"] > now}
            self.plans[plan_id] = {"cli": cli, "body": body, "expires": now + INSTALL_PLAN_TTL_S}
        plan["plan_id"] = plan_id
        plan["expires_in"] = INSTALL_PLAN_TTL_S
        return plan

    # -- running -------------------------------------------------------------------------------
    def start(self, cli: str, plan_id: str) -> dict:
        if os.geteuid() == 0:
            raise InstallError(403, "refusing to install as root")
        with self.lock:
            stored = self.plans.pop(plan_id, None)
            if stored is None or stored["cli"] != cli or stored["expires"] <= time.monotonic():
                raise InstallError(410, "the plan expired or was already used; review it again")
            if any(j.state == "running" for j in self.jobs.values()):
                self.plans[plan_id] = stored
                raise InstallError(409, "another install is running")
            spec = self.specs[cli]
            job = Job(secrets.token_urlsafe(9), cli)
            self.jobs[job.id] = job
            if len(self.jobs) > 20:
                for jid in [j for j, v in self.jobs.items() if v.state != "running"][:-10]:
                    del self.jobs[jid]
        path = self.path_fn()
        workdir = Path(tempfile.mkdtemp(prefix="sb-install-"))
        try:
            shim = workdir / "shim"
            shim.mkdir()
            (shim / "sudo").write_text(SUDO_SHIM)
            (shim / "sudo").chmod(0o755)
            if spec.method == "script":
                interp = which(spec.interpreter, path)
                if interp is None:
                    raise InstallError(400, f"{spec.interpreter} not found")
                script = workdir / "install.sh"
                script.write_bytes(stored["body"])
                argv = [interp, str(script), *spec.args]
            else:
                argv = [self._npm_prefix_ok(path), "install", "-g", f"{spec.source}@{spec.version}"]
            env = {
                "HOME": str(HOME),
                "PATH": ":".join([str(shim), *path]),
                "NO_COLOR": "1",
                "TERM": "dumb",
                "CI": "1",
                "npm_config_update_notifier": "false",
                **dict(spec.env),
            }
            job.proc = subprocess.Popen(  # noqa: S603 - argv comes only from INSTALLS
                argv,
                cwd=workdir,
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                errors="replace",
                bufsize=1,
                start_new_session=True,
            )
        except (InstallError, OSError) as e:
            shutil.rmtree(workdir, ignore_errors=True)
            job.finish("failed", None)
            if isinstance(e, InstallError):
                raise
            raise InstallError(500, f"could not start the install ({type(e).__name__})") from None
        threading.Thread(target=self._pump, args=(job, workdir), daemon=True).start()
        return job.snapshot()

    def _pump(self, job: Job, workdir: Path) -> None:
        proc = job.proc
        assert proc is not None and proc.stdout is not None
        timer = threading.Timer(self.timeout_s, self._kill, args=(job, "timeout"))
        timer.start()
        try:
            for raw in proc.stdout:
                job.add(clean_line(raw))
            code = proc.wait()
        finally:
            timer.cancel()
            proc.stdout.close()
            shutil.rmtree(workdir, ignore_errors=True)
        if job.state != "running":
            return
        state = "cancelled" if job.cancelled else ("ok" if code == 0 else "failed")
        job.finish(state, code)
        if state == "ok" and self.on_success:
            self.on_success()

    def _kill(self, job: Job, state: str) -> None:
        job.cancelled = state == "cancelled"
        if job.proc and job.proc.poll() is None:
            try:
                os.killpg(job.proc.pid, signal.SIGTERM)
            except OSError:
                pass
        if state == "timeout":
            job.add("Timed out; the install was stopped.")
            job.finish("timeout", None)

    def cancel(self, job_id: str) -> dict:
        job = self.jobs.get(job_id)
        if job is None:
            raise InstallError(404, "unknown job")
        if job.state == "running":
            self._kill(job, "cancelled")
        return job.snapshot()

    def job(self, job_id: str) -> Job:
        job = self.jobs.get(job_id)
        if job is None:
            raise InstallError(404, "unknown job")
        return job


def make_handler(probe: Probe):
    class Handler(BaseHTTPRequestHandler):
        server_version = "hostprobe"
        sys_version = ""

        def _send(self, code: int, body: dict) -> None:
            raw = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def _body(self) -> dict:
            n = int(self.headers.get("Content-Length") or 0)
            if n > 1024:
                raise InstallError(413, "body too large")
            try:
                data = json.loads(self.rfile.read(n) or b"{}")
            except ValueError:
                raise InstallError(400, "invalid JSON") from None
            return data if isinstance(data, dict) else {}

        def _gate(self) -> bool:
            if not probe.authorized(self.headers.get("X-Probe-Token")):
                self._send(401, {"error": "unauthorized"})
                return False
            if not probe.requests.take():
                self._send(429, {"error": "rate limited"})
                return False
            return True

        def _events(self, job: Job, start: int) -> None:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            sent = start
            try:
                while True:
                    with job.cond:
                        job.cond.wait_for(
                            lambda n=sent: len(job.lines) > n or job.state != "running", timeout=15
                        )
                        batch, state, code = job.lines[sent:], job.state, job.exit_code
                    for line in batch:
                        sent += 1
                        self.wfile.write(f"id: {sent}\nevent: log\ndata: {json.dumps(line)}\n\n".encode())
                    if not batch and state == "running":
                        self.wfile.write(b": ping\n\n")
                    if state != "running" and sent >= len(job.lines):
                        done = json.dumps({"state": state, "exit_code": code})
                        self.wfile.write(f"event: exit\ndata: {done}\n\n".encode())
                        self.wfile.flush()
                        return
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                return  # the browser went away; the install keeps running

        def do_GET(self) -> None:  # noqa: N802
            if not self._gate():
                return
            url = urllib.parse.urlparse(self.path)
            query = urllib.parse.parse_qs(url.query)
            if url.path == "/health":
                return self._send(200, {"status": "ok"})
            if url.path == "/cli":
                return self._send(*probe.cli(fresh=query.get("fresh") == ["1"]))
            m = re.fullmatch(r"/install/jobs/([\w-]+)(/events)?", url.path)
            if m:
                try:
                    job = probe.installer.job(m.group(1))
                except InstallError as e:
                    return self._send(e.status, {"error": e.message})
                if m.group(2):
                    start = (query.get("from") or ["0"])[0]
                    return self._events(job, int(start) if start.isdigit() else 0)
                return self._send(200, job.snapshot())
            return self._send(404, {"error": "not found"})

        def do_POST(self) -> None:  # noqa: N802
            if not self._gate():
                return
            path = urllib.parse.urlparse(self.path).path
            try:
                m = re.fullmatch(r"/install/(\w+)/(plan|run)", path)
                if m and m.group(1) in INSTALLS:
                    if m.group(2) == "plan":
                        return self._send(200, probe.installer.plan(m.group(1)))
                    plan_id = self._body().get("plan_id")
                    if not isinstance(plan_id, str):
                        raise InstallError(400, "plan_id required")
                    return self._send(202, probe.installer.start(m.group(1), plan_id))
                m = re.fullmatch(r"/install/jobs/([\w-]+)/cancel", path)
                if m:
                    return self._send(200, probe.installer.cancel(m.group(1)))
            except InstallError as e:
                return self._send(e.status, {"error": e.message})
            return self._send(404, {"error": "not found"})

        def _deny(self) -> None:
            self._send(405, {"error": "method not allowed"})

        do_PUT = do_DELETE = do_PATCH = _deny  # noqa: N815

        def log_message(self, fmt: str, *args) -> None:
            # Method, path and status only; headers (the token) are never logged.
            print(
                f"{self.address_string()} {self.command} {self.path} {args[1] if len(args) > 1 else ''}",
                flush=True,
            )

    return Handler


def read_env_value(env_file: Path, name: str) -> str | None:
    """Read one variable from deploy/.env without loading the rest of the file into the environment."""
    for line in env_file.read_text().splitlines():
        k, sep, v = line.partition("=")
        if sep and k.strip() == name:
            return v.strip().strip('"').strip("'")
    return None


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--env-file", type=Path, required=True)
    ap.add_argument("--port", type=int, default=None)
    ap.add_argument("--once", action="store_true", help="print one probe as JSON and exit")
    args = ap.parse_args()
    if args.once:
        print(json.dumps(probe_all(), indent=2))
        return
    token = read_env_value(args.env_file, "HOSTPROBE_TOKEN") or ""
    port = args.port or int(read_env_value(args.env_file, "HOSTPROBE_PORT") or 8101)
    server = ThreadingHTTPServer(("127.0.0.1", port), make_handler(Probe(token)))
    print(f"hostprobe listening on 127.0.0.1:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()

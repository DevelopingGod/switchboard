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
- PATH detection (M1b): one fixed `bash -lic` call prints a login shell's PATH (the PATH of a new
  terminal) so the UI can say when an installed CLI's directory is not on it. Nothing is changed.

- Job worktrees (M4a, ADR 0008): narrow git actions for agent jobs. A project path and a job number
  are the only request data that reach `git`, as argv (never a shell), after these checks: the path
  is resolved and must be the top of a git work tree, never this Switchboard repo; worktrees live
  only under one root (SWITCHBOARD_WORKTREE_ROOT, default ~/.switchboard/worktrees); branches are
  exactly `switchboard/job-<n>` from the project's HEAD; nothing is ever pushed or fetched, and the
  project's own checkout and branch are never changed.

Stdlib only, so it runs on the system python3 without a venv.
"""

import argparse
import glob
import hashlib
import hmac
import ipaddress
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
    auth_kind: str  # how to read the status command: exit0 | claude | codex | opencode
    auth_files: tuple[str, ...]  # relative to $HOME; stat only


# The allowlist. Verified against each CLI's docs/--help at M1a (see docs/m1a.md); grok's
# credential location is unverified until Grok Build is installed.
CLIS: dict[str, CliSpec] = {
    "claude": CliSpec("claude", ("auth", "status", "--json"), "claude", (".claude/.credentials.json",)),
    "codex": CliSpec("codex", ("login", "status"), "codex", (".codex/auth.json",)),
    "gemini": CliSpec("gemini", None, "", (".gemini/oauth_creds.json",)),
    "grok": CliSpec("grok", None, "", (".grok/auth.json", ".config/grok/auth.json")),
    "opencode": CliSpec("opencode", ("auth", "list"), "opencode", (".local/share/opencode/auth.json",)),
    # M4a: listed so the registry can say "not installed"; no verified status command or login file yet.
    "hermes": CliSpec("hermes", None, "", ()),
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
    if kind == "claude":
        # `claude auth status --json` (2.1.326, verified 2026-11-19) prints one JSON object whose
        # `loggedIn` is a bool, next to the account email and org. Only that bool is read; the rest of
        # the output is discarded here and never stored or returned.
        try:
            data = json.loads(out)
        except ValueError:
            return None
        flag = data.get("loggedIn") if isinstance(data, dict) else None
        return flag if isinstance(flag, bool) else None
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


def probe_cli(spec: CliSpec, path: list[str], user_path: str | None = None) -> dict:
    """`user_path` is a new terminal's PATH (see bash_path); None means unknown."""
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
    bin_dir = os.path.dirname(exe)
    return {
        "installed": True,
        "version": m.group(0) if m else None,
        "logged_in": logged_in,
        "windows_only": False,
        "login_method": method,
        # Where it lives, and whether a new terminal can find it ("command not found" otherwise).
        "bin_path": display_path(exe),
        "bin_dir": display_path(bin_dir),
        "on_user_path": None if user_path is None else bin_dir in user_path.split(":"),
    }


def probe_all() -> dict:
    path = linux_path()
    # One login-shell call, and only when something is installed.
    user_path = bash_path(path) if any(which(spec.bin, path) for spec in CLIS.values()) else None
    return {
        "clis": {name: probe_cli(spec, path, user_path) for name, spec in CLIS.items()},
        "at": int(time.time()),
    }


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


# --- Hardware (M3a): GPU memory and RAM for the local-model profile ---------------------------------
# One fixed argv (nvidia-smi query, no shell) plus /proc/meminfo. WSL ships nvidia-smi in
# /usr/lib/wsl/lib; native Linux has it on PATH. No NVIDIA GPU -> vram_mb null (the router then uses
# the configured fallback profile and the owner picks one in Settings).
NVIDIA_SMI_DIRS = ["/usr/lib/wsl/lib", "/usr/bin", "/usr/local/bin"]
NVIDIA_SMI_ARGS = ("--query-gpu=name,memory.total", "--format=csv,noheader,nounits")
HW_CACHE_TTL_S = 300


def parse_nvidia_smi(out: str) -> tuple[str | None, int | None]:
    """`NVIDIA GeForce RTX 3050 Laptop GPU, 4096` (one line per GPU) -> (first name, largest MiB)."""
    best: tuple[str | None, int | None] = (None, None)
    for line in out.strip().splitlines():
        name, _, mem = line.rpartition(",")
        try:
            mib = int(float(mem.strip()))
        except ValueError:
            continue
        if best[1] is None or mib > best[1]:
            best = (name.strip() or None, mib)
    return best


def parse_meminfo(text: str) -> int | None:
    m = re.search(r"^MemTotal:\s+(\d+)\s+kB", text, re.M)
    return int(m.group(1)) // 1024 if m else None


def probe_hw() -> dict:
    smi = which("nvidia-smi", NVIDIA_SMI_DIRS)
    gpu, vram, err = None, None, None
    if smi:
        code, out = run([smi, *NVIDIA_SMI_ARGS], NVIDIA_SMI_DIRS)
        if code == 0:
            gpu, vram = parse_nvidia_smi(out)
        else:
            err = "nvidia-smi failed"
    else:
        err = "no NVIDIA GPU found (nvidia-smi missing)"
    try:
        ram = parse_meminfo(Path("/proc/meminfo").read_text())
    except OSError:
        ram = None
    return {
        "gpu": gpu,
        "vram_mb": vram,
        "ram_mb": ram,
        "source": "nvidia-smi" if vram else "none",
        "error": err,
        # M4a: level 3 jobs run only inside the bwrap sandbox (never unsandboxed).
        "bwrap": which("bwrap", ["/usr/bin", "/usr/local/bin", "/bin"]) is not None,
    }


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
        self.hw_fn = probe_hw
        self.hw_cache: tuple[float, dict] | None = None

    def hw(self) -> tuple[int, dict]:
        with self.lock:
            if self.hw_cache and time.monotonic() - self.hw_cache[0] < HW_CACHE_TTL_S:
                return 200, self.hw_cache[1]
            if not self.probes.take():
                return 429, {"error": "rate limited"}
            data = self.hw_fn()
            self.hw_cache = (time.monotonic(), data)
            return 200, data

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
USER_PATH_TIMEOUT_S = 8
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
    """One log line: ANSI and control characters stripped, secrets masked."""
    line = "".join(ch for ch in ANSI_RE.sub("", line) if ch == "\t" or ch >= " ")
    return TOKENISH_RE.sub("[redacted]", line)[:MAX_LINE_CHARS]


PERCENT_RE = re.compile(r"(\d{1,3}(?:\.\d+)?)\s*%")
CURL_TABLE_RE = re.compile(r"^\s*(\d{1,3})\s+\S+\s+(\d{1,3})\s+\S+\s+\d+\s+\d+")  # curl's default meter row
PROGRESS_MIN_INTERVAL_S = 0.25


def percent_of(text: str) -> float | None:
    """A download percentage in a progress line (`#### 45.2%`, or curl's table row), else None."""
    m = PERCENT_RE.search(text)
    if m:
        return min(100.0, float(m.group(1)))
    m = CURL_TABLE_RE.match(text)
    return min(100.0, float(m.group(2))) if m else None


class LineAssembler:
    """Turns raw installer output into log entries `{t, r, p}`.

    A line ended by "\r" is a redraw (curl's progress bar): `r` is true and the UI replaces the
    previous redraw with it. A line ended by "\n" (or "\r\n") is final. `p` is a download percentage
    when the line is progress output. Redraws are throttled (a new percent, or 250 ms) so a 60 MB
    download cannot flood the log. Python's text mode would turn every "\r" into "\n", which is why
    the pipe is read as bytes and split here.
    """

    def __init__(self, clock: Callable[[], float] = time.monotonic):
        self.buf = ""
        self.cr = False  # the previous character was "\r"
        self.clock = clock
        self.last_redraw = (None, -1e9)  # (whole percent, time)
        self.decoder = __import__("codecs").getincrementaldecoder("utf-8")("replace")

    def feed(self, data: bytes, final: bool = False) -> list[dict]:
        out: list[dict] = []
        for ch in self.decoder.decode(data, final):
            if self.cr and ch != "\n":
                self._emit(out, redraw=True)  # "\r" not followed by "\n": the line was redrawn
            self.cr = False
            if ch == "\r":
                self.cr = True
            elif ch == "\n":
                self._emit(out, redraw=False)
            else:
                self.buf += ch
        if final:
            if self.cr:
                self._emit(out, redraw=True)
                self.cr = False
            self._emit(out, redraw=False)
        return out

    def _emit(self, out: list[dict], redraw: bool) -> None:
        raw, self.buf = self.buf, ""
        text = clean_line(raw).rstrip()
        if not text.strip():
            return
        pct = percent_of(text)
        if redraw:
            whole, at = self.last_redraw
            now = self.clock()
            same = pct is not None and int(pct) == whole
            if (same and now - at < PROGRESS_MIN_INTERVAL_S) or (
                pct is None and now - at < PROGRESS_MIN_INTERVAL_S
            ):
                return
            self.last_redraw = (int(pct) if pct is not None else None, now)
        out.append({"t": text, "r": redraw, "p": pct})


def bash_path(path: list[str]) -> str | None:
    """PATH of a new terminal: a login+interactive bash prints it (fixed argv, nothing from a request)."""
    bash = which("bash", path)
    if bash is None:
        return None
    env = {"HOME": str(HOME), "PATH": "/usr/local/bin:/usr/bin:/bin", "TERM": "dumb"}
    try:
        r = subprocess.run(  # noqa: S603 - fixed argv
            [bash, "-lic", 'printf "<<%s>>" "$PATH"'],
            capture_output=True,
            text=True,
            timeout=USER_PATH_TIMEOUT_S,
            env=env,
            stdin=subprocess.DEVNULL,
            check=False,
        )
    except (subprocess.TimeoutExpired, OSError):
        return None
    m = re.search(r"<<(.*?)>>", r.stdout or "", re.S)
    return m.group(1) if m else None


def display_path(p: str) -> str:
    """Home-relative for the UI ("~/.opencode/bin"), so absolute home paths are not sent around."""
    home = str(HOME)
    return "~" + p[len(home) :] if p == home or p.startswith(home + os.sep) else p


class Job:
    def __init__(self, job_id: str, cli: str):
        self.id, self.cli = job_id, cli
        self.lines: list[dict] = []  # entries {t, r, p}; append-only so resuming by index works
        self.state = "running"  # running | ok | failed | cancelled | timeout
        self.exit_code: int | None = None
        self.cond = threading.Condition()
        self.proc: subprocess.Popen | None = None
        self.cancelled = False

    def add(self, entry: dict) -> None:
        with self.cond:
            if len(self.lines) < MAX_LOG_LINES:
                self.lines.append(entry)
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
                bufsize=0,
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
        asm = LineAssembler()
        try:
            fd = proc.stdout.fileno()
            while chunk := os.read(fd, 4096):
                for entry in asm.feed(chunk):
                    job.add(entry)
            for entry in asm.feed(b"", final=True):
                job.add(entry)
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
            job.add({"t": "Timed out; the install was stopped.", "r": False, "p": None})
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


# --- Job worktrees (M4a, ADR 0008) -----------------------------------------------------------------
GIT_TIMEOUT_S = 60
SELF_REPO = Path(__file__).resolve().parents[2]  # services/hostprobe/hostprobe.py -> the Switchboard repo
SLUG_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,60}")
MAX_DIFF_BYTES = 1_000_000
MAX_NEW_FILES = 200
MAX_DU_FILES = 200_000


class GitError(InstallError):
    pass


GIT_LOCK = threading.Lock()


def worktree_root() -> Path:
    return Path(
        os.environ.get("SWITCHBOARD_WORKTREE_ROOT") or HOME / ".switchboard" / "worktrees"
    ).expanduser()


def git_bin() -> str:
    g = which("git", ["/usr/bin", "/usr/local/bin", "/bin"])
    if not g:
        raise GitError(503, "git is not installed")
    return g


def git(args: list[str], cwd: Path, timeout: float = GIT_TIMEOUT_S, ok: tuple[int, ...] = (0,)) -> str:
    """Run git with a fixed argv list (no shell), no prompts, editor or pager. Raises GitError otherwise."""
    env = {
        "HOME": str(HOME),
        "PATH": "/usr/bin:/bin",
        "LANG": "C.UTF-8",
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_EDITOR": "true",
        "GIT_PAGER": "cat",
        "GIT_ASKPASS": "",
        "SSH_ASKPASS": "",
    }
    try:
        r = subprocess.run(  # noqa: S603 - fixed git argv; paths are validated by the callers
            [git_bin(), *args],
            cwd=str(cwd),
            capture_output=True,
            text=True,
            timeout=timeout,
            env=env,
            stdin=subprocess.DEVNULL,
            check=False,
        )
    except subprocess.TimeoutExpired:
        raise GitError(504, f"git {args[0]} took longer than {timeout:g} s") from None
    except OSError as e:
        raise GitError(500, f"git could not start ({type(e).__name__})") from None
    if r.returncode not in ok:
        msg = (r.stderr or r.stdout or "").strip().splitlines()
        raise GitError(409, f"git {args[0]} failed: {msg[-1][:200] if msg else 'exit ' + str(r.returncode)}")
    return r.stdout


def git_ok(args: list[str], cwd: Path) -> bool:
    """True when git exits 0, False on exit 1 (yes/no questions such as merge-base --is-ancestor)."""
    try:
        git(args, cwd, ok=(0,))
        return True
    except GitError:
        return False


def _abs_dir(value: object) -> Path:
    if not isinstance(value, str) or not value.startswith("/") or "\0" in value or len(value) > 4096:
        raise GitError(400, "Use the folder's full path, such as /home/you/myrepo or ~/myrepo")
    try:
        p = Path(value).resolve(strict=True)
    except (OSError, RuntimeError):
        raise GitError(
            404, "That folder doesn't exist (check the spelling; paths are case-sensitive)"
        ) from None
    if not p.is_dir():
        raise GitError(400, "That path is a file, not a folder")
    return p


def _home_relative(value: object) -> object:
    """`~` and `~/x` mean this user's home (the only expansion; never `~other`)."""
    if isinstance(value, str) and (value == "~" or value.startswith("~/")):
        return str(HOME) + value[1:]
    return value


def _is_self(p: Path) -> bool:
    return p == SELF_REPO or SELF_REPO in p.parents


def inspect_repo(value: object) -> dict:
    """Read-only facts about a folder someone wants to add as a project."""
    p = _abs_dir(_home_relative(value))
    try:
        top = Path(git(["rev-parse", "--show-toplevel"], p).strip()).resolve()
    except GitError:
        return {"path": str(p), "is_repo": False, "is_top": False, "is_self": _is_self(p)}
    branch = git(["symbolic-ref", "--quiet", "--short", "HEAD"], p, ok=(0, 1)).strip() or None
    head = git(["rev-parse", "--verify", "--quiet", "HEAD"], p, ok=(0, 1)).strip() or None
    dirty = len(git(["status", "--porcelain"], p).splitlines())
    return {
        "path": str(p),
        "is_repo": True,
        "is_top": top == p,
        "top": str(top),
        "is_self": _is_self(top),
        "head_branch": branch,
        "head_sha": head,
        "has_commits": head is not None,
        "dirty_files": dirty,
    }


def _project(value: object) -> Path:
    p = _abs_dir(value)
    info = inspect_repo(str(p))
    if not info["is_repo"] or not info["is_top"]:
        raise GitError(400, "the project must be the top folder of a git repository")
    if info["is_self"] and os.environ.get("SWITCHBOARD_ALLOW_SELF") != "1":
        raise GitError(403, "jobs never run in the Switchboard repository itself")
    if not info["has_commits"]:
        raise GitError(400, "the repository has no commits yet: commit once, then retry")
    return p


def _job(slug: object, job_id: object) -> tuple[str, int, str, Path]:
    if not isinstance(slug, str) or not SLUG_RE.fullmatch(slug):
        raise GitError(400, "invalid project slug")
    if isinstance(job_id, bool) or not isinstance(job_id, int) or not 0 < job_id < 10**12:
        raise GitError(400, "invalid job id")
    root = worktree_root()
    wt = root / slug / f"job-{job_id}"
    if root not in wt.parents:
        raise GitError(400, "worktree path escapes the worktree root")
    return slug, job_id, f"switchboard/job-{job_id}", wt


def _worktrees(project: Path) -> list[dict]:
    out, cur = [], {}
    for line in git(["worktree", "list", "--porcelain"], project).splitlines():
        if not line:
            if cur:
                out.append(cur)
            cur = {}
            continue
        k, _, v = line.partition(" ")
        cur[k] = v
    if cur:
        out.append(cur)
    return out


def create_worktree(body: dict) -> dict:
    project = _project(body.get("project"))
    _, _, branch, wt = _job(body.get("slug"), body.get("job_id"))
    for w in _worktrees(project):
        if Path(w.get("worktree", "")) == wt:  # already there (a retried request): same answer
            return {
                "path": str(wt),
                "branch": branch,
                "base_sha": git(["rev-parse", "HEAD"], wt).strip(),
                "created": False,
            }
    if wt.exists():
        raise GitError(409, "a folder is already where the job's worktree goes; remove it first")
    wt.parent.mkdir(parents=True, exist_ok=True)
    exists = git(["rev-parse", "--verify", "--quiet", f"refs/heads/{branch}"], project, ok=(0, 1)).strip()
    if exists:
        git(["worktree", "add", "--", str(wt), branch], project)
    else:
        git(["worktree", "add", "-b", branch, "--", str(wt), "HEAD"], project)
    return {
        "path": str(wt),
        "branch": branch,
        "base_sha": git(["rev-parse", "HEAD"], wt).strip(),
        "created": True,
    }


def _existing_worktree(body: dict) -> tuple[Path, Path, str]:
    project = _project(body.get("project"))
    _, _, branch, wt = _job(body.get("slug"), body.get("job_id"))
    if not any(Path(w.get("worktree", "")) == wt for w in _worktrees(project)):
        raise GitError(404, "that job has no worktree")
    return project, wt, branch


def diff_worktree(body: dict) -> dict:
    """The job's changes against its base commit: tracked changes and new files, capped in size."""
    _, wt, branch = _existing_worktree(body)
    base = body.get("base")
    if not isinstance(base, str) or not re.fullmatch(r"[0-9a-f]{7,64}", base):
        raise GitError(400, "invalid base commit")
    stat = git(["diff", "--numstat", base, "--"], wt)
    text = git(["diff", "--no-color", "--no-ext-diff", base, "--"], wt)
    new = [f for f in git(["ls-files", "--others", "--exclude-standard", "-z"], wt).split("\0") if f]
    for f in new[:MAX_NEW_FILES]:
        if len(text) > MAX_DIFF_BYTES:
            break
        text += git(["diff", "--no-color", "--no-index", "--", "/dev/null", f], wt, ok=(0, 1))
    files = [
        {
            "path": parts[2],
            "added": None if parts[0] == "-" else int(parts[0]),
            "removed": None if parts[1] == "-" else int(parts[1]),
        }
        for parts in (line.split("\t", 2) for line in stat.splitlines())
        if len(parts) == 3
    ] + [{"path": f, "added": None, "removed": None, "new": True} for f in new]
    truncated = len(text) > MAX_DIFF_BYTES or len(new) > MAX_NEW_FILES
    return {
        "branch": branch,
        "base": base,
        "files": files,
        "diff": text[:MAX_DIFF_BYTES],
        "truncated": truncated,
    }


def commit_worktree(body: dict) -> dict:
    """Commit the job's changes on its own branch (after the owner approved the diff)."""
    _, wt, branch = _existing_worktree(body)
    message = body.get("message")
    if not isinstance(message, str) or not message.strip() or len(message) > 500 or "\0" in message:
        raise GitError(400, "invalid commit message")
    git(["add", "-A"], wt)
    if not git(["status", "--porcelain"], wt).strip():
        return {"committed": False, "sha": git(["rev-parse", "HEAD"], wt).strip(), "branch": branch}
    ident = []
    if not git(["config", "user.email"], wt, ok=(0, 1)).strip():
        ident = ["-c", "user.name=Switchboard", "-c", "user.email=switchboard@localhost"]
    git([*ident, "commit", "-q", "-m", message], wt, timeout=120)
    return {"committed": True, "sha": git(["rev-parse", "HEAD"], wt).strip(), "branch": branch}


def remove_worktree(body: dict) -> dict:
    """Remove the job's worktree; the branch is kept. Already gone = success."""
    project = _project(body.get("project"))
    _, _, branch, wt = _job(body.get("slug"), body.get("job_id"))
    if any(Path(w.get("worktree", "")) == wt for w in _worktrees(project)):
        git(["worktree", "remove", "--force", "--", str(wt)], project)
    git(["worktree", "prune"], project)
    # An empty folder can be left where the worktree was (Paperclip creates a missing working folder when it
    # checks an agent). Only ever an empty one, inside the worktree root.
    if wt.is_dir() and not wt.is_symlink() and not any(wt.iterdir()):
        wt.rmdir()
    return {"removed": True, "branch": branch}


def _du(path: Path) -> int:
    total, n = 0, 0
    for root, dirs, files in os.walk(path):
        dirs[:] = [d for d in dirs if d != ".git"]
        for f in files:
            n += 1
            if n > MAX_DU_FILES:
                return total
            try:
                total += os.lstat(os.path.join(root, f)).st_size
            except OSError:
                pass
    return total


def list_worktrees(project_value: object, slug: object) -> dict:
    """The project's job worktrees: branch, tip, whether the tip is in the project's HEAD, disk used."""
    project = _project(project_value)
    if not isinstance(slug, str) or not SLUG_RE.fullmatch(slug):
        raise GitError(400, "invalid project slug")
    base = worktree_root() / slug
    out = []
    for w in _worktrees(project):
        path = Path(w.get("worktree", ""))
        m = re.fullmatch(r"job-(\d+)", path.name)
        if path.parent != base or not m:
            continue
        tip = w.get("HEAD", "")
        merged = bool(re.fullmatch(r"[0-9a-f]{40,64}", tip)) and git_ok(
            ["merge-base", "--is-ancestor", tip, "HEAD"], project
        )
        out.append(
            {
                "job_id": int(m.group(1)),
                "path": str(path),
                "branch": w.get("branch", "").removeprefix("refs/heads/"),
                "tip": tip,
                "merged": merged,
                "bytes": _du(path),
            }
        )
    return {"worktrees": out, "bytes": sum(x["bytes"] for x in out)}


def read_proc(name: str) -> str:
    return Path(name).read_text()


def listening(port: object) -> dict:
    """Addresses a local TCP port listens on, from /proc/net/tcp{,6} (no command runs)."""
    if not isinstance(port, str) or not port.isdigit() or not 0 < int(port) < 65536:
        raise GitError(400, "invalid port")
    want = int(port)
    addrs = set()
    for name, v6 in (("/proc/net/tcp", False), ("/proc/net/tcp6", True)):
        try:
            lines = read_proc(name).splitlines()[1:]
        except OSError:
            continue
        for line in lines:
            parts = line.split()
            if len(parts) < 4 or parts[3] != "0A":  # LISTEN
                continue
            hexaddr, hexport = parts[1].split(":")
            if int(hexport, 16) != want:
                continue
            raw = bytes.fromhex(hexaddr)
            if v6:
                words = [raw[i : i + 4][::-1] for i in range(0, 16, 4)]
                addrs.add(str(ipaddress.IPv6Address(b"".join(words))))
            else:
                addrs.add(".".join(str(x) for x in raw[::-1]))
    loopback = all(a.startswith("127.") or a in ("::1", "::ffff:127.0.0.1") for a in addrs)
    return {"port": want, "addresses": sorted(addrs), "loopback_only": bool(addrs) and loopback}


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
            if n > 16384:
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
            if url.path == "/hw":
                return self._send(*probe.hw())
            try:
                q1 = {k: v[0] for k, v in query.items() if v}
                if url.path == "/git/worktrees":
                    return self._send(200, list_worktrees(q1.get("project"), q1.get("slug")))
                if url.path == "/net/listen":
                    return self._send(200, listening(q1.get("port")))
            except InstallError as e:
                return self._send(e.status, {"error": e.message})
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
                git_actions = {
                    "/git/inspect": lambda b: inspect_repo(b.get("path")),
                    "/git/worktrees": create_worktree,
                    "/git/worktrees/diff": diff_worktree,
                    "/git/worktrees/commit": commit_worktree,
                    "/git/worktrees/remove": remove_worktree,
                }
                if path in git_actions:
                    with GIT_LOCK:  # one git action at a time: worktree add/remove share the repo's lock
                        return self._send(200, git_actions[path](self._body()))
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

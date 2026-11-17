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
- Detection only. Login/install endpoints come later (M1b/M4.5) as separate allowlisted,
  user-confirmed endpoints.

Stdlib only, so it runs on the system python3 without a venv.
"""

import argparse
import glob
import hmac
import json
import os
import re
import subprocess
import threading
import time
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

    def __init__(self, token: str, probe_fn=probe_all, request_limit=(60, 60.0), probe_limit=(6, 60.0)):
        if len(token) < 16:
            raise ValueError("HOSTPROBE_TOKEN must be at least 16 characters")
        self.token = token.encode()
        self.probe_fn = probe_fn
        self.requests = TokenBucket(*request_limit)
        self.probes = TokenBucket(*probe_limit)  # cache misses that spawn processes
        self.cache: tuple[float, dict] | None = None
        self.lock = threading.Lock()

    def authorized(self, header: str | None) -> bool:
        return header is not None and hmac.compare_digest(header.encode(), self.token)

    def cli(self) -> tuple[int, dict]:
        with self.lock:
            if self.cache and time.monotonic() - self.cache[0] < CACHE_TTL_S:
                return 200, self.cache[1]
            if not self.probes.take():
                return 429, {"error": "rate limited"}
            data = self.probe_fn()
            self.cache = (time.monotonic(), data)
            return 200, data


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

        def do_GET(self) -> None:  # noqa: N802
            if not probe.authorized(self.headers.get("X-Probe-Token")):
                return self._send(401, {"error": "unauthorized"})
            if not probe.requests.take():
                return self._send(429, {"error": "rate limited"})
            if self.path == "/health":
                return self._send(200, {"status": "ok"})
            if self.path == "/cli":
                return self._send(*probe.cli())
            return self._send(404, {"error": "not found"})

        def _deny(self) -> None:
            self._send(405, {"error": "method not allowed"})

        do_POST = do_PUT = do_DELETE = do_PATCH = _deny  # noqa: N815

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

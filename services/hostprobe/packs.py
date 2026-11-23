"""Workflow packs on the host (M4.5a, ADR 0018). Stdlib only, like hostprobe.

Two halves:
- **The pack store** (`~/.switchboard/packs/<id>/<version>/`): a pack's program, installed from the files its
  committed lock (`packs/<id>/pack.lock.json`) names, each one hash-checked and name-checked before use,
  installed offline (no network for the package manager), then made read-only with a manifest of every file's
  sha256. Wrappers in `<version>/sbbin/` are the only way jobs run a pack: they keep the tool's own state
  inside the job's worktree (`.switchboard/home`). Two versions are kept (current + previous) for rollback.
- **Per-job setup** in a job's worktree: the lock's setup argv, run through the wrappers with a minimal
  environment and no network. A git snapshot before and after sorts every write into owned (never
  committed), artifacts (committed with the code) and setup edits (shown to the owner, unticked by default).

Nothing from a request reaches a command except validated pack ids and host ids that map to the lock's own
values.
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import re
import secrets
import shlex
import shutil
import stat
import subprocess
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from collections.abc import Callable
from pathlib import Path

HOME = Path.home()
SRC_ROOT = Path(__file__).resolve().parents[2] / "packs"  # the repo's packs/ folder (locks)
ID_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,40}")
HOST_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,40}")
VERSION_RE = re.compile(r"[0-9A-Za-z][0-9A-Za-z.+-]{0,40}")
DOWNLOAD_HOSTS = ("registry.npmjs.org", "files.pythonhosted.org")
MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024
DOWNLOAD_TIMEOUT_S = 60
SETUP_TIMEOUT_S = 180
PREPARE_TIMEOUT_S = 900
DETECT_TIMEOUT_S = 30
MANIFEST = "store.manifest.json"
MARKER = "packs.json"  # <worktree>/.switchboard/packs.json: the job's pack record (and the wrappers' marker)
MAX_EDITS = 200
MAX_OUTPUT_CHARS = 4000
SUDO_SHIM = "#!/bin/sh\necho 'sudo is not allowed in Switchboard pack installs' >&2\nexit 1\n"
TOKENISH_RE = re.compile(r"(?:sk-|gsk_|ghp_|xai-|AIza)[A-Za-z0-9_\-]{12,}")
ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")


class PackError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status, self.message = status, message


# --- paths --------------------------------------------------------------------------------------------------
def src_root() -> Path:
    return Path(os.environ.get("SWITCHBOARD_PACKS_DIR") or SRC_ROOT)


def store_root() -> Path:
    return Path(os.environ.get("SWITCHBOARD_PACKS_ROOT") or HOME / ".switchboard" / "packs").expanduser()


def display(p: Path | str) -> str:
    s, home = str(p), str(HOME)
    return "~" + s[len(home) :] if s == home or s.startswith(home + os.sep) else s


def _id(value: object) -> str:
    if not isinstance(value, str) or not ID_RE.fullmatch(value):
        raise PackError(400, "invalid pack id")
    return value


# --- locks --------------------------------------------------------------------------------------------------
def load_lock(pack_id: object) -> dict:
    pid = _id(pack_id)
    path = src_root() / pid / "pack.lock.json"
    try:
        lock = json.loads(path.read_text())
    except FileNotFoundError:
        raise PackError(404, "unknown pack (no lock in packs/)") from None
    except ValueError:
        raise PackError(500, f"{pid}'s lock is not valid JSON") from None
    spec = lock.get("spec") or {}
    if lock.get("lock_version") != 1 or spec.get("id") != pid or lock.get("kind") not in ("npm", "pypi"):
        raise PackError(500, f"{pid}'s lock is not a version-1 npm or PyPI lock")
    if spec.get("scope") != ["project"]:
        raise PackError(
            403, f"{pid} only installs globally; Switchboard only installs packs inside a job's worktree"
        )
    if not VERSION_RE.fullmatch(str(lock.get("version", ""))):
        raise PackError(500, f"{pid}'s lock has an invalid version")
    return lock


def list_locks() -> list[str]:
    root = src_root()
    if not root.is_dir():
        return []
    return sorted(
        p.name for p in root.iterdir() if ID_RE.fullmatch(p.name) and (p / "pack.lock.json").is_file()
    )


# --- versions and requirements ------------------------------------------------------------------------------
def vtuple(v: str) -> tuple[int, ...]:
    return tuple(int(x) for x in re.findall(r"\d+", v)[:3])


def satisfies(version: str, spec: str) -> bool:
    """`spec` like ">=3.11.5,<3.15"; numeric comparison of up to three parts."""
    have = vtuple(version)
    for part in spec.split(","):
        m = re.fullmatch(r"\s*(>=|<=|==|>|<)\s*([\d.]+)\s*", part)
        if not m:
            return False
        op, want = m.group(1), vtuple(m.group(2))
        n = max(len(have), len(want))
        a, b = have + (0,) * (n - len(have)), want + (0,) * (n - len(want))
        if not {">=": a >= b, "<=": a <= b, "==": a == b, ">": a > b, "<": a < b}[op]:
            return False
    return True


def _which(name: str, path: list[str]) -> str | None:
    for d in path:
        p = os.path.join(d, name)
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    return None


def _quick(argv: list[str], timeout: float = 10) -> tuple[int | None, str]:
    try:
        r = subprocess.run(  # noqa: S603 - fixed argv (a runtime's version)
            argv,
            capture_output=True,
            text=True,
            timeout=timeout,
            env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "HOME": "/nonexistent"},
            stdin=subprocess.DEVNULL,
            check=False,
        )
    except (subprocess.TimeoutExpired, OSError):
        return None, ""
    return r.returncode, (r.stdout or "") + (r.stderr or "")


PY_PROBE = (
    "import sys,platform;v=sys.version_info;print(f'{v[0]}.{v[1]}.{v[2]}',sys.platform,platform.machine())"
)


def python_facts(python: str) -> tuple[str, str] | None:
    """(version, target platform key) of a Python, e.g. ("3.12.3", "manylinux_x86_64")."""
    code, out = _quick([python, "-I", "-c", PY_PROBE])
    if code != 0:
        return None
    try:
        ver, plat, mach = out.split()
    except ValueError:
        return None
    mach = {"amd64": "x86_64", "arm64": "arm64", "aarch64": "aarch64"}.get(mach.lower(), mach.lower())
    if plat.startswith("linux"):
        key = {
            "x86_64": "manylinux_x86_64",
            "aarch64": "manylinux_aarch64",
            "arm64": "manylinux_aarch64",
        }.get(mach)
    elif plat == "darwin":
        key = {"arm64": "macos_arm64", "aarch64": "macos_arm64", "x86_64": "macos_x86_64"}.get(mach)
    else:
        key = None
    return ver, key or f"{plat}-{mach}"


def runtime(lock: dict, path: list[str]) -> dict:
    """Find the runtime a pack needs and check its version against `requires`.

    Returns {ok, checks: [{name, need, found, ok}], node|python: abs path, target: key, problem}."""
    out: dict = {"ok": True, "checks": [], "problem": None}
    reqs = lock["spec"].get("requires") or []
    for req in reqs:
        m = re.fullmatch(r"(node|python)\s*(.+)", req)
        if not m:
            continue
        name, need = m.group(1), m.group(2)
        found = None
        if name == "node":
            node = _which("node", path)
            if node:
                code, txt = _quick([node, "--version"])
                found = txt.strip().lstrip("v") if code == 0 else None
                out["node"] = node
        else:
            for cand in ["/usr/bin/python3", *(p for d in path if (p := os.path.join(d, "python3")))]:
                if os.path.isfile(cand) and os.access(cand, os.X_OK):
                    facts = python_facts(cand)
                    if facts:
                        found, out["target_platform"] = facts
                        out["python"] = cand
                        break
        ok = found is not None and satisfies(found, need)
        out["checks"].append({"name": name, "need": need, "found": found, "ok": ok})
        if not ok:
            out["ok"] = False
            out["problem"] = f"{lock['spec']['name']} needs {name} {need}; " + (
                f"this machine has {found}" if found else f"{name} was not found"
            )
    py_check = next((c for c in out["checks"] if c["name"] == "python"), None)
    if out["ok"] and lock["kind"] == "pypi" and py_check is not None:
        ver = py_check["found"]
        key = f"cp{''.join(ver.split('.')[:2])}-{out.get('target_platform')}"
        out["target"] = key
        if key not in (lock["pypi"].get("targets") or {}):
            supported = sorted(lock["pypi"].get("targets") or {})
            pys = sorted({k.split("-")[0] for k in supported})
            out["ok"] = False
            out["problem"] = (
                f"{lock['spec']['name']} has no locked build for Python {'.'.join(ver.split('.')[:2])} on "
                f"{out.get('target_platform')}. Supported: "
                f"{', '.join(p[2] + '.' + p[3:] for p in pys)} on Linux x86_64/aarch64 and macOS"
            )
    return out


# --- network isolation --------------------------------------------------------------------------------------
_netns: list[str] | None = None


def netns_prefix() -> list[str]:
    """`unshare --map-current-user --net` when it works here (same uid, no network); else [] (detected)."""
    global _netns
    if _netns is None:
        u = shutil.which("unshare", path="/usr/bin:/bin")
        ok = False
        if u:
            code, _ = _quick([u, "--map-current-user", "--net", "true"])
            ok = code == 0
        _netns = [u, "--map-current-user", "--net"] if ok and u else []
    return _netns


def minimal_env(path: list[str], home: str, extra: dict[str, str] | None = None) -> dict[str, str]:
    """A fresh environment: nothing is copied from hostprobe's own (no Switchboard secrets, no tokens)."""
    env = {
        "HOME": home,
        "PATH": ":".join(path),
        "LANG": "C.UTF-8",
        "NO_COLOR": "1",
        "TERM": "dumb",
        "CI": "1",
        "npm_config_update_notifier": "false",
        "npm_config_fund": "false",
        "npm_config_audit": "false",
        "PIP_DISABLE_PIP_VERSION_CHECK": "1",
    }
    env.update(extra or {})
    return env


def clean(text: str) -> str:
    text = "".join(ch for ch in ANSI_RE.sub("", text) if ch in "\t\n" or ch >= " ")
    return TOKENISH_RE.sub("[redacted]", text)


# --- downloads ----------------------------------------------------------------------------------------------
class _Redirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        u = urllib.parse.urlparse(newurl)
        if u.scheme != "https" or u.hostname not in DOWNLOAD_HOSTS:
            raise urllib.error.URLError(f"redirect to {u.hostname} is not allowed")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch(url: str) -> bytes:
    u = urllib.parse.urlparse(url)
    if u.scheme != "https" or u.hostname not in DOWNLOAD_HOSTS:
        raise PackError(400, f"the lock names a download host that isn't allowed ({u.hostname})")
    opener = urllib.request.build_opener(_Redirect())
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "switchboard-hostprobe"})  # noqa: S310
        with opener.open(req, timeout=DOWNLOAD_TIMEOUT_S) as r:
            data = r.read(MAX_DOWNLOAD_BYTES + 1)
    except (urllib.error.URLError, OSError) as e:
        raise PackError(502, f"couldn't download {url.rsplit('/', 1)[-1]} ({type(e).__name__})") from None
    if len(data) > MAX_DOWNLOAD_BYTES:
        raise PackError(502, f"{url.rsplit('/', 1)[-1]} is larger than allowed")
    return data


def check_integrity(data: bytes, integrity: str, label: str) -> None:
    """npm SRI (`sha512-<base64>`) or a plain sha256 hex."""
    if re.fullmatch(r"[0-9a-f]{64}", integrity):
        ok = hmac_eq(hashlib.sha256(data).hexdigest(), integrity)
    else:
        algo, _, b64 = integrity.partition("-")
        if algo not in ("sha512", "sha384", "sha256") or not b64:
            raise PackError(500, f"{label}: the lock has no usable hash")
        ok = hmac_eq(base64.b64encode(hashlib.new(algo, data).digest()).decode(), b64)
    if not ok:
        raise PackError(409, f"{label} doesn't match the hash in the lock; nothing was installed")


def hmac_eq(a: str, b: str) -> bool:
    import hmac

    return hmac.compare_digest(a.encode(), b.encode())


def pep503(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def npm_inside(data: bytes) -> tuple[str, str]:
    """(name, version) from a tarball's package.json (npm tarballs hold one top folder, usually
    `package/`)."""
    try:
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tf:
            for m in tf.getmembers():
                parts = m.name.split("/")
                if len(parts) == 2 and parts[1] == "package.json" and m.isfile():
                    f = tf.extractfile(m)
                    meta = json.loads(f.read(1_000_000)) if f else {}
                    return str(meta.get("name", "")), str(meta.get("version", ""))
    except (tarfile.TarError, OSError, ValueError, EOFError):
        pass
    return "", ""


def wheel_inside(data: bytes) -> tuple[str, str]:
    """(name, version) from a wheel's METADATA."""
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            for n in z.namelist():
                if n.count("/") == 1 and n.endswith(".dist-info/METADATA"):
                    name = version = ""
                    for line in z.read(n).decode("utf-8", "replace").splitlines():
                        if not line.strip():
                            break
                        k, _, v = line.partition(":")
                        if k == "Name":
                            name = v.strip()
                        elif k == "Version":
                            version = v.strip()
                    return name, version
    except (zipfile.BadZipFile, OSError, KeyError):
        pass
    return "", ""


def npm_files(lock: dict) -> list[dict]:
    out = []
    for key, v in lock["npm"]["lockfile"]["packages"].items():
        if not key:
            continue
        name = key.rsplit("node_modules/", 1)[-1]
        out.append(
            {"key": key, "name": name, "version": v["version"], "url": v["resolved"], "hash": v["integrity"]}
        )
    return out


def pypi_files(lock: dict, target: str) -> list[dict]:
    return [
        {
            "name": w["name"],
            "version": w["version"],
            "url": w["url"],
            "hash": w["sha256"],
            "filename": w["filename"],
        }
        for w in lock["pypi"]["targets"][target]
    ]


def verify_download(kind: str, f: dict, data: bytes) -> None:
    """Hash first, then the name and version written inside the file (a renamed or swapped file fails
    here)."""
    label = f"{f['name']} {f['version']}"
    check_integrity(data, f["hash"], label)
    name, version = npm_inside(data) if kind == "npm" else wheel_inside(data)
    same = name == f["name"] if kind == "npm" else pep503(name) == pep503(f["name"])
    if not same or version != f["version"]:
        raise PackError(
            409,
            f"the file for {label} says it is {name or '?'} {version or '?'} inside; "
            "refusing (wrong or swapped package)",
        )


# --- the store ----------------------------------------------------------------------------------------------
def pack_dir(pack_id: str) -> Path:
    return store_root() / _id(pack_id)


def version_dir(pack_id: str, version: str) -> Path:
    if not VERSION_RE.fullmatch(version):
        raise PackError(400, "invalid version")
    return pack_dir(pack_id) / version


def _pointer(pack_id: str, name: str) -> str | None:
    try:
        v = (pack_dir(pack_id) / name).read_text().strip()
    except OSError:
        return None
    return v if VERSION_RE.fullmatch(v) else None


def current(pack_id: str) -> str | None:
    return _pointer(pack_id, "current")


def previous(pack_id: str) -> str | None:
    return _pointer(pack_id, "previous")


def _write_pointer(pack_id: str, name: str, value: str | None) -> None:
    p = pack_dir(pack_id) / name
    if value is None:
        p.unlink(missing_ok=True)
        return
    tmp = p.with_suffix(".tmp")
    tmp.write_text(value + "\n")
    os.replace(tmp, p)


def _walk(root: Path) -> list[tuple[str, str]]:
    """(relative path, sha256 | "link:<target>") for every file and link under root, the manifest excluded."""
    out = []
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        rel_dir = os.path.relpath(dirpath, root)
        for name in sorted(filenames + [d for d in dirnames if os.path.islink(os.path.join(dirpath, d))]):
            full = os.path.join(dirpath, name)
            rel = name if rel_dir == "." else f"{rel_dir}/{name}"
            if rel == MANIFEST:
                continue
            st = os.lstat(full)
            if stat.S_ISLNK(st.st_mode):
                out.append((rel, "link:" + os.readlink(full)))
            elif stat.S_ISREG(st.st_mode):
                h = hashlib.sha256()
                with open(full, "rb") as fh:
                    while chunk := fh.read(1 << 20):
                        h.update(chunk)
                out.append((rel, h.hexdigest()))
        dirnames[:] = sorted(d for d in dirnames if not os.path.islink(os.path.join(dirpath, d)))
    return sorted(out)


def _tree(entries: list[tuple[str, str]]) -> str:
    return hashlib.sha256("\n".join(f"{p}\t{h}" for p, h in entries).encode()).hexdigest()


def write_manifest(vdir: Path, extra: dict) -> dict:
    entries = _walk(vdir)
    m = {"files": dict(entries), "tree": _tree(entries), "count": len(entries), **extra}
    (vdir / MANIFEST).write_text(json.dumps(m, indent=0, sort_keys=True))
    return m


def set_readonly(root: Path, writable: bool = False) -> None:
    """Every file and folder under root (and root itself) read-only, or writable again (for removal)."""
    for dirpath, dirnames, filenames in os.walk(root, topdown=not writable, followlinks=False):
        for name in filenames:
            full = os.path.join(dirpath, name)
            st = os.lstat(full)
            if stat.S_ISREG(st.st_mode):
                mode = stat.S_IMODE(st.st_mode)
                os.chmod(full, (mode | stat.S_IWUSR) if writable else (mode & ~0o222))
        for name in dirnames:
            full = os.path.join(dirpath, name)
            if not os.path.islink(full):
                os.chmod(full, 0o755 if writable else 0o555)
    os.chmod(root, 0o755 if writable else 0o555)


def remove_tree(root: Path) -> None:
    if root.is_symlink():
        root.unlink()
        return
    if not root.exists():
        return
    if root.is_dir():
        os.chmod(root, 0o755)  # noqa: S103 - our own folder, made writable again only to remove it
        set_readonly(root, writable=True)
    shutil.rmtree(root, ignore_errors=False)


def verify(pack_id: str, version: str | None = None) -> dict:
    """Re-hash an installed version against its manifest. {ok, version, ms, files, problem, bin}."""
    t0 = time.monotonic()
    version = version or current(pack_id)
    name = pack_id
    if version is None:
        return {"ok": False, "version": None, "ms": 0, "problem": f"{name} isn't installed"}
    vdir = version_dir(pack_id, version)
    try:
        m = json.loads((vdir / MANIFEST).read_text())
    except (OSError, ValueError):
        return {
            "ok": False,
            "version": version,
            "ms": 0,
            "problem": f"{name} {version} has no install record",
        }
    entries = _walk(vdir)
    ms = round((time.monotonic() - t0) * 1000)
    problem = None
    if _tree(entries) != m.get("tree"):
        have = dict(entries)
        want = m.get("files") or {}
        changed = sorted([p for p in want if have.get(p) != want[p]] + [p for p in have if p not in want])
        problem = (
            f"{name} {version} changed on disk since it was installed ({changed[0] if changed else 'files'}"
            f"{f' and {len(changed) - 1} more' if len(changed) > 1 else ''})"
            " — reinstall it in Connections → Packs"
        )
    for rt in m.get("runtime_paths") or []:
        if problem is None and not os.path.exists(rt):
            problem = (
                f"{name} {version} uses {display(rt)}, which is gone — reinstall it in Connections → Packs"
            )
    return {
        "ok": problem is None,
        "version": version,
        "ms": ms,
        "files": len(entries),
        "problem": problem,
        "bin": str(vdir / "sbbin"),
    }


def status(pack_id: str, check: bool = False) -> dict:
    cur, prev = current(pack_id), previous(pack_id)
    d = pack_dir(pack_id)
    versions = (
        sorted(p.name for p in d.iterdir() if p.is_dir() and VERSION_RE.fullmatch(p.name))
        if d.is_dir()
        else []
    )
    out: dict = {"id": pack_id, "current": cur, "previous": prev, "versions": versions}
    if cur:
        out["bin"] = str(version_dir(pack_id, cur) / "sbbin")
        if check:
            out["verify"] = verify(pack_id, cur)
    return out


def prune(pack_id: str, log: Callable[[str], None] | None = None) -> list[str]:
    keep = {current(pack_id), previous(pack_id)} - {None}
    removed = []
    d = pack_dir(pack_id)
    if not d.is_dir():
        return removed
    for p in d.iterdir():
        if p.is_dir() and not p.is_symlink() and VERSION_RE.fullmatch(p.name) and p.name not in keep:
            remove_tree(p)
            removed.append(p.name)
            if log:
                log(f"Removed old version {p.name}")
        elif p.name.startswith(".staging-"):
            remove_tree(p)
    return removed


def rollback(pack_id: str) -> dict:
    cur, prev = current(pack_id), previous(pack_id)
    if prev is None:
        raise PackError(409, "there is no previous version to roll back to")
    v = verify(pack_id, prev)
    if not v["ok"]:
        raise PackError(409, v["problem"] or "the previous version failed its check")
    _write_pointer(pack_id, "current", prev)
    _write_pointer(pack_id, "previous", cur)
    return status(pack_id)


def uninstall(pack_id: str) -> dict:
    """Remove every installed version. Already gone = success."""
    d = pack_dir(pack_id)
    if d.exists() or d.is_symlink():
        remove_tree(d)
    return {"id": pack_id, "removed": True}


# --- wrappers -----------------------------------------------------------------------------------------------
WRAPPER = """#!/bin/sh
# Switchboard pack wrapper ({pack} {version}; ADR 0018). Runs {cli} only inside a Switchboard job's
# worktree, with the tool's own state (HOME, XDG folders) kept in its git-ignored .switchboard/home.
root={root}
d=$(pwd -P)
while [ ! -f "$d/.switchboard/{marker}" ] && [ "$d" != / ]; do d=$(dirname "$d"); done
case "$d/" in
  "$root"/*) ;;
  *) echo "{cli}: Switchboard runs this only inside a job's worktree" >&2; exit 126 ;;
esac
if [ ! -f "$d/.switchboard/{marker}" ]; then
  echo "{cli}: Switchboard runs this only inside a job's worktree" >&2; exit 126
fi
h="$d/.switchboard/home"
mkdir -p "$h"
HOME="$h"; XDG_CONFIG_HOME="$h/.config"; XDG_DATA_HOME="$h/.local/share"; XDG_CACHE_HOME="$h/.cache"
PYTHONDONTWRITEBYTECODE=1
export HOME XDG_CONFIG_HOME XDG_DATA_HOME XDG_CACHE_HOME PYTHONDONTWRITEBYTECODE
{env}exec {real} "$@"
"""


def write_wrappers(lock: dict, vdir: Path, worktree_root: Path, rt: dict) -> list[str]:
    spec = lock["spec"]
    sb = vdir / "sbbin"
    sb.mkdir()
    names = []
    for cli, rel in (spec.get("bins") or {}).items():
        if not ID_RE.fullmatch(cli) or ".." in rel.split("/") or rel.startswith("/"):
            raise PackError(500, f"the lock's bin {cli} is invalid")
        target = vdir / rel
        real = [rt["node"], str(target)] if lock["kind"] == "npm" else [str(target)]
        env = "".join(
            f"{k}={shlex.quote(str(v))}; export {k}\n"
            for k, v in (spec.get("env") or {}).items()
            if re.fullmatch(r"[A-Z][A-Z0-9_]{0,60}", k)
        )
        body = WRAPPER.format(
            pack=spec["id"],
            version=lock["version"],
            cli=cli,
            root=shlex.quote(str(worktree_root.resolve())),
            marker=MARKER,
            env=env,
            real=" ".join(shlex.quote(x) for x in real),
        )
        (sb / cli).write_text(body)
        (sb / cli).chmod(0o755)
        names.append(cli)
    return names


# --- install ------------------------------------------------------------------------------------------------
def plan(lock: dict, path: list[str]) -> dict:
    """Everything the owner reads before confirming. No side effects."""
    spec = lock["spec"]
    rt = runtime(lock, path)
    kind, pkg, ver = lock["kind"], lock["package"], lock["version"]
    if kind == "npm":
        files = npm_files(lock)
        top_hash = lock["npm"]["integrity"]
        source = f"https://www.npmjs.com/package/{pkg}/v/{ver}"
        commands = [
            f"download {len(files)} packages from registry.npmjs.org, each checked against the lock's sha512",
            f"{'(no network) ' if netns_prefix() else ''}npm ci --offline --ignore-scripts",
        ]
    else:
        target = rt.get("target")
        files = pypi_files(lock, target) if target in (lock["pypi"].get("targets") or {}) else []
        top = next((f for f in files if pep503(f["name"]) == pep503(pkg)), None)
        top_hash = top["hash"] if top else None
        source = f"https://pypi.org/project/{pkg}/{ver}/"
        commands = [
            f"download {len(files)} wheels for {target or 'this machine'} "
            "from files.pythonhosted.org and pip "
            f"{lock['pypi']['pip']['version']}, each checked against the lock's sha256",
            f"{'(no network) ' if netns_prefix() else ''}python3 -m venv --without-pip",
            f"{'(no network) ' if netns_prefix() else ''}"
            "pip install --no-index --require-hashes --only-binary :all:",
            "python -m compileall (before the files are recorded)",
        ]
    vdir = version_dir(spec["id"], ver)
    commands += [
        f"write wrappers ({', '.join(spec.get('bins') or {})}) "
        "that keep the tool's state inside a job's worktree",
        "record every file's sha256, then make the folder read-only",
        " ".join(spec.get("detect") or []),
    ]
    looks = [x for x in spec.get("lookalikes") or [] if x != pkg]
    return {
        "id": spec["id"],
        "name": spec["name"],
        "trust": spec.get("trust", "community"),
        "unverified": spec.get("trust") != "verified",
        "kind": kind,
        "package": pkg,
        "version": ver,
        "source": source,
        "repository": spec.get("repository"),
        "hash": top_hash,
        "dependencies": max(0, len(files) - 1),
        "lookalikes": looks,
        "install_scripts": (lock.get("npm") or {}).get("install_scripts") or [],
        "commands": commands,
        "writes": [display(vdir)],
        "project_writes": list(spec.get("owned") or []),
        "artifacts": list(spec.get("artifacts") or []),
        "requires": rt["checks"],
        "problem": rt["problem"],
        "network_isolated": bool(netns_prefix()),
        "current": current(spec["id"]),
        "sudo": False,
    }


def _run(
    argv: list[str],
    cwd: Path,
    env: dict[str, str],
    timeout: float,
    log: Callable[[str], None] | None = None,
    isolate: bool = True,
) -> tuple[int | None, str, int]:
    """Run a fixed argv; returns (exit code or None on timeout, output, ms). Output lines go to `log`."""
    t0 = time.monotonic()
    full = [*(netns_prefix() if isolate else []), *argv]
    try:
        r = subprocess.run(  # noqa: S603 - argv comes from the lock (or fixed here)
            full,
            cwd=str(cwd),
            env=env,
            capture_output=True,
            text=True,
            timeout=timeout,
            stdin=subprocess.DEVNULL,
            check=False,
            start_new_session=True,
        )
        code, out = r.returncode, clean((r.stdout or "") + (r.stderr or ""))
    except subprocess.TimeoutExpired:
        code, out = None, f"stopped after {timeout:g} s"
    except OSError as e:
        code, out = 127, f"couldn't start ({type(e).__name__})"
    if log:
        for line in out.splitlines()[-40:]:
            if line.strip():
                log(line[:400])
    return code, out[-MAX_OUTPUT_CHARS:], round((time.monotonic() - t0) * 1000)


def install(
    lock: dict,
    path: list[str],
    worktree_root: Path,
    log: Callable[[str], None],
    fetch_fn: Callable[[str], bytes] = fetch,
) -> dict:
    """Download, verify, install offline, wrap, record, make read-only, point `current` at it.

    Raises PackError."""
    if os.geteuid() == 0:
        raise PackError(403, "refusing to install as root")
    spec = lock["spec"]
    pid, ver, kind = spec["id"], lock["version"], lock["kind"]
    rt = runtime(lock, path)
    if not rt["ok"]:
        raise PackError(400, rt["problem"])
    pdir = pack_dir(pid)
    pdir.mkdir(parents=True, exist_ok=True, mode=0o755)
    vdir = version_dir(pid, ver)
    if vdir.exists():
        v = verify(pid, ver)
        if v["ok"]:
            log(f"{spec['name']} {ver} is already installed and unchanged")
            _point_at(pid, ver, log)
            return status(pid)
        log(f"Removing a damaged copy of {ver}: {v['problem']}")
        remove_tree(vdir)
    staging = pdir / f".staging-{secrets.token_hex(4)}"
    staging.mkdir(mode=0o700)
    shim = staging / "shim"
    shim.mkdir()
    (shim / "sudo").write_text(SUDO_SHIM)
    (shim / "sudo").chmod(0o755)
    dl = staging / "dl"
    dl.mkdir()
    home = staging / "home"
    home.mkdir()
    try:
        files = npm_files(lock) if kind == "npm" else pypi_files(lock, rt["target"])
        log(f"Downloading {len(files)} files")
        names: dict[str, str] = {}
        for i, f in enumerate(files, 1):
            data = fetch_fn(f["url"])
            verify_download(kind, f, data)
            if kind == "pypi":  # pip reads a wheel's name, version and tags from its exact file name
                fname = f["filename"]
                if (
                    not re.fullmatch(r"[A-Za-z0-9._+-]{1,200}\.whl", fname)
                    or fname != f["url"].rsplit("/", 1)[-1]
                ):
                    raise PackError(500, f"the lock has an invalid wheel name for {f['name']}")
            else:
                fname = f"{i:04d}-" + re.sub(r"[^A-Za-z0-9._-]", "_", f["url"].rsplit("/", 1)[-1])[:150]
            (dl / fname).write_bytes(data)
            names[f.get("key") or f["name"]] = fname
            if i % 10 == 0 or i == len(files):
                log(f"Checked {i} of {len(files)} (hash and the name inside each file)")
        vdir.mkdir(mode=0o755)
        tool_path = [
            str(shim),
            *([os.path.dirname(rt["node"])] if rt.get("node") else []),
            "/usr/bin",
            "/bin",
        ]
        env = minimal_env(tool_path, str(home))
        if kind == "npm":
            lf = json.loads(json.dumps(lock["npm"]["lockfile"]))
            for key, v in lf["packages"].items():
                if key:
                    v["resolved"] = "file:" + str(dl / names[key])
            (vdir / "package.json").write_text(json.dumps(lock["npm"]["package_json"], indent=1))
            (vdir / "package-lock.json").write_text(json.dumps(lf, indent=1))
            npm = _which("npm", [os.path.dirname(rt["node"])])
            if npm is None:
                raise PackError(400, "npm was not found next to node")
            log("npm ci --offline --ignore-scripts" + (" (no network)" if netns_prefix() else ""))
            code, out, _ = _run(
                [
                    npm,
                    "ci",
                    "--offline",
                    "--ignore-scripts",
                    "--no-audit",
                    "--no-fund",
                    "--cache",
                    str(staging / "cache"),
                ],
                vdir,
                env,
                INSTALL_STEP_TIMEOUT_S,
                log,
            )
            if code != 0:
                raise PackError(500, f"npm ci failed (exit {code})")
            shutil.rmtree(vdir / "node_modules" / ".cache", ignore_errors=True)
        else:
            pip = lock["pypi"]["pip"]
            data = fetch_fn(pip["url"])
            check_integrity(data, pip["sha256"], f"pip {pip['version']}")
            pipwhl = dl / pip["filename"]
            pipwhl.write_bytes(data)
            req = "".join(f"{f['name']}=={f['version']} --hash=sha256:{f['hash']}\n" for f in files)
            (staging / "requirements.txt").write_text(req)
            py = rt["python"]
            log("python3 -m venv --without-pip" + (" (no network)" if netns_prefix() else ""))
            code, _, _ = _run(
                [py, "-I", "-m", "venv", "--without-pip", str(vdir / "venv")], vdir, env, 120, log
            )
            if code != 0:
                raise PackError(500, f"couldn't create the Python environment (exit {code})")
            vpy = str(vdir / "venv" / "bin" / "python")
            log("pip install --no-index --require-hashes --only-binary :all:")
            code, _, _ = _run(
                [
                    vpy,
                    "-I",
                    str(pipwhl / "pip"),
                    "install",
                    "--no-index",
                    "--find-links",
                    str(dl),
                    "--require-hashes",
                    "--only-binary",
                    ":all:",
                    "--no-cache-dir",
                    "--disable-pip-version-check",
                    "--no-warn-script-location",
                    "--quiet",
                    "-r",
                    str(staging / "requirements.txt"),
                ],
                vdir,
                env,
                INSTALL_STEP_TIMEOUT_S,
                log,
            )
            if code != 0:
                raise PackError(500, f"pip install failed (exit {code})")
            log("Compiling Python files before they are recorded")
            code, _, _ = _run(
                [vpy, "-I", "-m", "compileall", "-q", str(vdir / "venv" / "lib")], vdir, env, 300, log
            )
            if code not in (0, 1):
                raise PackError(500, f"compileall failed (exit {code})")
        clis = write_wrappers(lock, vdir, worktree_root, rt)
        log(f"Wrappers: {', '.join(clis)}")
        detect = list(spec.get("detect") or [])
        if detect:
            real = _real_argv(lock, vdir, rt, detect)
            code, out, _ = _run(
                real,
                staging,
                minimal_env(tool_path, str(home), {k: str(v) for k, v in (spec.get("env") or {}).items()}),
                DETECT_TIMEOUT_S,
            )
            if code != 0:
                raise PackError(500, f"{' '.join(detect)} failed after the install (exit {code})")
            log(f"{' '.join(detect)}: {out.strip().splitlines()[0][:120] if out.strip() else 'ok'}")
        runtime_paths = [rt[k] for k in ("node", "python") if rt.get(k)]
        m = write_manifest(
            vdir,
            {"pack": pid, "version": ver, "installed_at": int(time.time()), "runtime_paths": runtime_paths},
        )
        set_readonly(vdir)
        log(f"Recorded {m['count']} files; the folder is now read-only")
    except BaseException:
        if vdir.exists():
            try:
                remove_tree(vdir)
            except OSError:
                pass
        raise
    finally:
        remove_tree(staging)
    _point_at(pid, ver, log)
    return status(pid)


INSTALL_STEP_TIMEOUT_S = 600


def _point_at(pid: str, ver: str, log: Callable[[str], None]) -> None:
    cur = current(pid)
    if cur != ver:
        _write_pointer(pid, "previous", cur)
        _write_pointer(pid, "current", ver)
    prune(pid, log)


def _real_argv(lock: dict, vdir: Path, rt: dict, argv: list[str]) -> list[str]:
    """A lock argv (`[openspec, --version]`) with its first word as the real binary (install-time checks)."""
    rel = (lock["spec"].get("bins") or {}).get(argv[0])
    if rel is None:
        raise PackError(500, f"{argv[0]} is not one of the pack's programs")
    target = str(vdir / rel)
    return ([rt["node"], target] if lock["kind"] == "npm" else [target]) + argv[1:]


# --- per-job setup ------------------------------------------------------------------------------------------
def glob_re(pattern: str) -> re.Pattern[str]:
    out, i = "", 0
    while i < len(pattern):
        c = pattern[i]
        if pattern.startswith("**", i):
            out += ".*"
            i += 2
            continue
        out += {"*": "[^/]*", "?": "[^/]"}.get(c, re.escape(c))
        i += 1
    return re.compile(out)


def matches(path: str, patterns: list[str]) -> bool:
    return any(glob_re(p).fullmatch(path) for p in patterns)


def dir_matches(path: str, patterns: list[str]) -> bool:
    """A folder is owned when a `<x>/**` pattern's `<x>` matches it."""
    return any(p.endswith("/**") and glob_re(p[:-3]).fullmatch(path) for p in patterns)


def ensure_sb(wt: Path) -> Path:
    """`<worktree>/.switchboard/` (700) with a `.gitignore` of `*`: everything in it is never committed."""
    sb = wt / ".switchboard"
    if sb.is_symlink() or (sb.exists() and not sb.is_dir()):
        raise PackError(409, ".switchboard in the worktree isn't a plain folder")
    sb.mkdir(mode=0o700, exist_ok=True)
    ignore = sb / ".gitignore"
    if ignore.is_symlink():
        raise PackError(409, ".switchboard/.gitignore in the worktree is a link")
    ignore.write_text("# Switchboard job files (attachments, pack state): never committed\n*\n")
    return sb


def read_record(wt: Path) -> dict | None:
    p = wt / ".switchboard" / MARKER
    if p.is_symlink():
        return None
    try:
        rec = json.loads(p.read_text())
    except (OSError, ValueError):
        return None
    return rec if isinstance(rec, dict) else None


def write_record(wt: Path, rec: dict) -> None:
    p = wt / ".switchboard" / MARKER
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(rec, indent=1))
    os.replace(tmp, p)


def _sha(path: Path) -> str:
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        return "-"
    if stat.S_ISLNK(st.st_mode):
        return "link:" + os.readlink(path)
    if not stat.S_ISREG(st.st_mode):
        return "?"
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        while chunk := fh.read(1 << 20):
            h.update(chunk)
    return h.hexdigest()


GitFn = Callable[..., str]


def snapshot(wt: Path, git: GitFn) -> dict[str, tuple[str, str]]:
    """path -> (status code, content hash) for every changed or untracked file (`.switchboard/` is
    ignored)."""
    out: dict[str, tuple[str, str]] = {}
    raw = git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"], wt)
    for entry in raw.split("\0"):
        if len(entry) < 4:
            continue
        code, path = entry[:2], entry[3:]
        out[path] = (code, _sha(wt / path))
    return out


def tracked_dirs(wt: Path, git: GitFn) -> set[str]:
    dirs: set[str] = set()
    for f in git(["ls-files", "-z"], wt).split("\0"):
        parts = f.split("/")[:-1]
        for i in range(1, len(parts) + 1):
            dirs.add("/".join(parts[:i]))
    return dirs


def classify(
    wt: Path,
    before: dict[str, tuple[str, str]],
    after: dict[str, tuple[str, str]],
    existing_dirs: set[str],
    owned_globs: list[str],
    artifact_globs: list[str],
) -> dict:
    owned_files: list[str] = []
    owned_dirs: set[str] = set()
    artifacts: list[str] = []
    edits: list[dict] = []
    outside: list[str] = []
    root = os.path.realpath(wt)
    for path, (code, sha) in sorted(after.items()):
        if before.get(path) == (code, sha):
            continue
        full = wt / path
        if os.path.islink(full):
            target = os.path.realpath(full)
            if target != root and not target.startswith(root + os.sep):
                outside.append(path)
                continue
        if code == "??":
            if matches(path, owned_globs):
                owned_files.append(path)
                parts = path.split("/")[:-1]
                for i in range(1, len(parts) + 1):
                    d = "/".join(parts[:i])
                    if d not in existing_dirs and dir_matches(d, owned_globs):
                        owned_dirs.add(d)
                        break
            elif matches(path, artifact_globs):
                artifacts.append(path)
            else:
                edits.append({"path": path, "kind": "new", "post_sha": sha})
        else:
            kind = "deleted" if "D" in code else "modified"
            if matches(path, artifact_globs):
                artifacts.append(path)
            else:
                edits.append({"path": path, "kind": kind, "post_sha": sha})
    # files under an owned folder are covered by the folder
    owned_files = [f for f in owned_files if not any(f.startswith(d + "/") for d in owned_dirs)]
    return {
        "owned_files": owned_files,
        "owned_dirs": sorted(owned_dirs),
        "artifacts": artifacts,
        "edits": edits,
        "outside": outside,
    }


def rollback_writes(wt: Path, before: dict, after: dict, git: GitFn) -> None:
    """Undo what one setup step changed: remove new files, restore changed tracked ones."""
    restore, parents = [], set()
    for path, (code, sha) in after.items():
        if before.get(path) == (code, sha):
            continue
        if code == "??":
            p = wt / path
            if p.is_symlink() or p.is_file():
                p.unlink()
                parents.add(p.parent)
        else:
            restore.append(path)
    if restore:
        git(["checkout", "--", *restore], wt)
    # folders the step created and that are now empty (only parents of removed files, never above the
    # worktree)
    for d in sorted(parents, key=lambda x: -len(x.parts)):
        while d != wt and wt in d.parents:
            try:
                d.rmdir()
            except OSError:
                break
            d = d.parent


def excludes(rec: dict | None) -> list[str]:
    """Literal pathspec excludes for everything packs own in a worktree (never committed)."""
    if not rec:
        return []
    out: list[str] = []
    for p in (rec.get("packs") or {}).values():
        for path in [*(p.get("owned_dirs") or []), *(p.get("owned_files") or [])]:
            out.append(f":(exclude,literal){path}")
    return out


def setup_edits(rec: dict | None) -> list[dict]:
    out = []
    for pid, p in ((rec or {}).get("packs") or {}).items():
        for e in p.get("edits") or []:
            out.append({**e, "pack": pid, "pack_name": p.get("name", pid)})
    return out


def _subst(argv: list[str], tool_ids: list[str], one: str | None) -> list[str]:
    out = []
    for a in argv:
        if a == "{tool_ids}":
            out.append(",".join(tool_ids))
        elif a == "{tool_id}":
            out.append(one or "")
        elif "{" in a:
            raise PackError(500, f"unknown placeholder in the lock: {a}")
        else:
            out.append(a)
    return out


def setup(
    wt: Path,
    worktree_root: Path,
    requests: list[dict],
    git: GitFn,
    cache_root: Path,
    cache_key: str,
    log: Callable[[str], None] | None = None,
) -> dict:
    """Set up the requested packs in a job's worktree. `requests`: [{id, hosts: [host ids], graph: bool}].

    Idempotent: a finished record is returned as is; an interrupted one is refused (its writes can't be
    sorted)."""
    rec = read_record(wt)
    if rec and rec.get("state") == "ready":
        return rec
    if rec and rec.get("state") == "setting_up":
        raise PackError(409, "an earlier pack setup in this worktree was interrupted; start the job again")
    ensure_sb(wt)
    rec = {"version": 1, "state": "setting_up", "started_at": int(time.time()), "packs": {}, "refused": []}
    write_record(wt, rec)
    home = wt / ".switchboard" / "home"
    home.mkdir(exist_ok=True)
    edits_dir = wt / ".switchboard" / "packs"
    edits_dir.mkdir(exist_ok=True)
    plans = []
    for req in requests:
        pid = _id(req.get("id"))
        try:
            lock = load_lock(pid)
        except PackError as e:
            rec["refused"].append({"id": pid, "reason": e.message})
            continue
        hosts = req.get("hosts") or []
        mapping = lock["spec"].get("hosts") or {}
        if not isinstance(hosts, list) or not all(isinstance(h, str) and HOST_RE.fullmatch(h) for h in hosts):
            raise PackError(400, "invalid hosts")
        tool_ids = [mapping[h] for h in hosts if h in mapping]
        if not tool_ids:
            rec["refused"].append({"id": pid, "reason": f"{lock['spec']['name']} doesn't support this agent"})
            continue
        v = verify(pid)
        if not v["ok"]:
            rec["refused"].append({"id": pid, "reason": v["problem"], "verify_ms": v["ms"]})
            if log:
                log(v["problem"])
            continue
        plans.append((lock, tool_ids, bool(req.get("graph")), v))
    path = [p for _, _, _, v in plans for p in [v["bin"]]]
    node_dirs = set()
    for lock, _, _, _ in plans:
        if lock["kind"] != "npm":
            continue
        rt = runtime(lock, [*_linux_extra(), "/usr/local/bin", "/usr/bin", "/bin"])
        if rt.get("node"):
            node_dirs.add(os.path.dirname(rt["node"]))
    env_path = [*path, *sorted(node_dirs), "/usr/bin", "/bin"]
    env = minimal_env(env_path, str(home))
    existing = tracked_dirs(wt, git)
    for lock, tool_ids, graph, v in plans:
        spec = lock["spec"]
        pid = spec["id"]
        entry: dict = {
            "name": spec["name"],
            "version": v["version"],
            "tool_ids": tool_ids,
            "verify_ms": v["ms"],
            "verify_files": v.get("files"),
            "steps": [],
            "owned_files": [],
            "owned_dirs": [],
            "artifacts": [],
            "edits": [],
            "bin": v["bin"],
        }
        before = snapshot(wt, git)
        steps: list[tuple[list[str], float, str]] = []
        cache_dir = None
        if graph and spec.get("cache"):
            cache_dir = _cache_dir(cache_root, pid, cache_key)
            _copy_in(cache_dir, wt / spec["cache"])
            entry["cache_used"] = (cache_dir / spec["cache"]).is_dir()
        if graph:
            for argv in (spec.get("project") or {}).get("prepare") or []:
                steps.append((_subst(argv, tool_ids, None), PREPARE_TIMEOUT_S, "prepare"))
        for argv in (spec.get("project") or {}).get("setup") or []:
            if "{tool_id}" in argv:
                for t in tool_ids:
                    steps.append((_subst(argv, tool_ids, t), SETUP_TIMEOUT_S, "setup"))
            else:
                steps.append((_subst(argv, tool_ids, None), SETUP_TIMEOUT_S, "setup"))
        failed = None
        for argv, timeout, phase in steps:
            if argv[0] not in (spec.get("bins") or {}):
                raise PackError(500, f"{pid}: {argv[0]} is not one of the pack's programs")
            wrapper = str(Path(v["bin"]) / argv[0])
            # the wrapper needs the record to exist (it is the wrappers' marker)
            code, out, ms = _run([wrapper, *argv[1:]], wt, env, timeout, log)
            entry["steps"].append({"argv": " ".join(argv), "phase": phase, "exit": code, "ms": ms})
            if code != 0:
                failed = f"{' '.join(argv)} failed ({'timed out' if code is None else f'exit {code}'}): " + (
                    out.strip().splitlines()[-1][:200] if out.strip() else "no output"
                )
                break
        after = snapshot(wt, git)
        sorted_ = classify(wt, before, after, existing, spec.get("owned") or [], spec.get("artifacts") or [])
        if failed or sorted_["outside"] or len(sorted_["edits"]) > MAX_EDITS:
            reason = failed or (
                f"{spec['name']} created a link that points outside the worktree ({sorted_['outside'][0]})"
                if sorted_["outside"]
                else f"{spec['name']} changed more than {MAX_EDITS} files outside its own"
            )
            rollback_writes(wt, before, after, git)
            if cache_dir is not None:
                shutil.rmtree(wt / spec["cache"], ignore_errors=True)
            rec["refused"].append({"id": pid, "reason": reason, "verify_ms": v["ms"]})
            if log:
                log(reason)
            continue
        if graph and cache_dir is not None and (wt / spec["cache"]).is_dir():
            _copy_out(wt / spec["cache"], cache_dir / spec["cache"])
        for i, e in enumerate(sorted_["edits"]):
            if e["kind"] in ("modified", "deleted"):
                patch = git(
                    ["diff", "-U0", "--binary", "--no-color", "--no-ext-diff", "--", e["path"]], wt
                )  # only its own lines
                name = f"{pid}-{i}.patch"
                (edits_dir / name).write_text(patch)
                e["patch"] = name
        entry.update(
            owned_files=sorted_["owned_files"],
            owned_dirs=sorted_["owned_dirs"],
            artifacts=sorted_["artifacts"],
            edits=sorted_["edits"],
            graph=graph,
        )
        if graph and spec.get("cache"):
            entry["graph_stats"] = _graph_stats(wt / spec["cache"])
        rec["packs"][pid] = entry
        existing |= {d for d in entry["owned_dirs"]}
    rec["state"] = "ready"
    rec["finished_at"] = int(time.time())
    rec["bins"] = [e["bin"] for e in rec["packs"].values()]  # the router puts these first on the run's PATH
    write_record(wt, rec)
    return rec


def _linux_extra() -> list[str]:
    import glob

    return sorted(glob.glob(str(HOME / ".nvm/versions/node/*/bin")), reverse=True) + [
        str(HOME / ".local/bin")
    ]


def _cache_dir(root: Path, pid: str, key: str) -> Path:
    if not ID_RE.fullmatch(key):
        raise PackError(400, "invalid cache key")
    d = root / pid / key
    d.mkdir(parents=True, exist_ok=True, mode=0o700)
    return d


def _copy_in(cache: Path, dest: Path) -> None:
    src = cache / dest.name
    if not src.is_dir() or src.is_symlink() or dest.exists():
        return
    shutil.copytree(src, dest, symlinks=True)


def _copy_out(src: Path, dest: Path) -> None:
    tmp = dest.with_name(dest.name + f".tmp-{secrets.token_hex(3)}")
    shutil.copytree(src, tmp, symlinks=True)
    old = dest.with_name(dest.name + ".old")
    if dest.exists():
        os.replace(dest, old)
    os.replace(tmp, dest)
    shutil.rmtree(old, ignore_errors=True)


def _graph_stats(out_dir: Path) -> dict:
    try:
        g = json.loads((out_dir / "graph.json").read_text())
    except (OSError, ValueError):
        return {}
    nodes = g.get("nodes") if isinstance(g, dict) else None
    edges = g.get("links") or g.get("edges") if isinstance(g, dict) else None
    return {
        "nodes": len(nodes) if isinstance(nodes, list) else None,
        "edges": len(edges) if isinstance(edges, list) else None,
    }


def size(wt: Path, git: GitFn, cap: int = 500_000) -> dict:
    """Tracked files and their bytes (for graphify's Auto threshold)."""
    n, total = 0, 0
    for f in git(["ls-files", "-z"], wt).split("\0"):
        if not f:
            continue
        n += 1
        if n > cap:
            break
        try:
            total += os.lstat(wt / f).st_size
        except OSError:
            pass
    return {"files": n, "bytes": total}

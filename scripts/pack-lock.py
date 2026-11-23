#!/usr/bin/env python3
"""Generate packs/<id>/pack.lock.json from packs/<id>/pack.yaml (M4.5a, ADR 0018). Maintainers only; needs the
network.

The lock is exactly what Switchboard will download for a pack: every file's URL and hash, transitive
dependencies included, plus the manifest fields hostprobe needs (hostprobe is stdlib-only and never reads
YAML). Review its diff like code.

    python3 scripts/pack-lock.py openspec
    python3 scripts/pack-lock.py graphify            # resolves 4 Pythons x 4 platforms (~2 min)
    python3 scripts/pack-lock.py --check graphify    # exit 1 if the lock no longer matches the manifest

npm packs: `npm install --package-lock-only --ignore-scripts` in a scratch folder; the lock keeps npm's own
package-lock (URL + sha512 integrity of every package). PyPI packs: for each supported Python (3.11-3.14) and
platform (manylinux x86_64/aarch64, macOS arm64/x86_64), `pip install --dry-run --report --only-binary :all:`
picks the exact wheels; a target that can't be satisfied is recorded with pip's reason. A pinned pip wheel is
recorded too: hostprobe installs with it, so the host needs no pip, venv package or sudo.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
PACKS = ROOT / "packs"
LOCK_VERSION = 1
PIP_VERSION = "26.3"  # the pip that installs PyPI packs on the host; bump deliberately
PYTHONS = ["3.11.9", "3.12", "3.13", "3.14"]  # 3.11.9, not 3.11: pip reads "3.11" as 3.11.0, below many
# packages' requires-python (graphify needs >= 3.11.5); the wheel tags are per minor version either way
PLATFORMS = {
    "manylinux_x86_64": [f"manylinux_2_{n}_x86_64" for n in (28, 27, 26, 24, 17, 12, 5)]
    + ["manylinux2014_x86_64", "manylinux2010_x86_64", "manylinux1_x86_64"],
    "manylinux_aarch64": [f"manylinux_2_{n}_aarch64" for n in (28, 27, 26, 24, 17)]
    + ["manylinux2014_aarch64"],
    "macos_arm64": [f"macosx_{v}_0_arm64" for v in (11, 12, 13, 14, 15)]
    + [f"macosx_{v}_universal2" for v in ("10_9", "10_13", "11_0", "12_0", "13_0", "14_0")],
    "macos_x86_64": [f"macosx_10_{v}_x86_64" for v in (9, 10, 11, 12, 13, 14, 15)]
    + [f"macosx_{v}_0_x86_64" for v in (11, 12, 13, 14, 15)]
    + [f"macosx_{v}_universal2" for v in ("10_9", "10_13", "11_0", "12_0", "13_0", "14_0")],
}
# Manifest fields hostprobe needs, copied into the lock as `spec` (the router checks they still match the
# YAML).
SPEC_FIELDS = (
    "id",
    "name",
    "trust",
    "source",
    "requires",
    "scope",
    "hosts",
    "bins",
    "env",
    "detect",
    "project",
    "owned",
    "artifacts",
    "allow",
    "cache",
    "auto",
)


def cp(py: str) -> str:
    return "".join(py.split(".")[:2])


def spec_of(manifest: dict) -> dict:
    return {k: manifest[k] for k in SPEC_FIELDS if k in manifest}


def get_json(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "switchboard-pack-lock"})  # noqa: S310 - fixed https
    with urllib.request.urlopen(req, timeout=60) as r:  # noqa: S310 - fixed https registry URLs
        return json.load(r)


def lock_npm(name: str, version: str) -> dict:
    with tempfile.TemporaryDirectory(prefix="sb-pack-lock-") as d:
        pkg = {"name": "sb-pack", "private": True, "dependencies": {name: version}}
        (Path(d) / "package.json").write_text(json.dumps(pkg))
        subprocess.run(  # noqa: S603 - maintainer tool, fixed argv
            [  # noqa: S607 - the npm on your PATH
                "npm",
                "install",
                "--package-lock-only",
                "--ignore-scripts",
                "--no-audit",
                "--no-fund",
                "--registry=https://registry.npmjs.org/",
            ],
            cwd=d,
            check=True,
            capture_output=True,
            text=True,
        )
        lock = json.loads((Path(d) / "package-lock.json").read_text())
    packages = {k: v for k, v in lock["packages"].items() if k}
    for k, v in packages.items():
        if not v.get("resolved", "").startswith("https://registry.npmjs.org/") or not v.get("integrity"):
            sys.exit(f"{k}: not a registry tarball with an integrity hash ({v.get('resolved')})")
    top = packages.get(f"node_modules/{name}") or {}
    if top.get("version") != version:
        sys.exit(f"npm resolved {name} to {top.get('version')}, not {version}")
    scripts = sorted(
        k.removeprefix("node_modules/") for k, v in packages.items() if v.get("hasInstallScript")
    )
    return {
        "package_json": pkg,
        "lockfile": {
            "name": "sb-pack",
            "lockfileVersion": lock["lockfileVersion"],
            "requires": True,
            "packages": {"": lock["packages"][""], **packages},
        },
        "integrity": top["integrity"],
        "count": len(packages),
        "install_scripts": scripts,  # never run (--ignore-scripts); listed so the plan can say so
    }


def resolve_pypi(req: str, py: str, plats: list[str]) -> list[dict] | str:
    with tempfile.TemporaryDirectory(prefix="sb-pack-lock-") as d:
        report = Path(d) / "report.json"
        argv = [
            sys.executable,
            "-m",
            "pip",
            "install",
            "--dry-run",
            "--quiet",
            "--ignore-installed",
            "--disable-pip-version-check",
            "--no-cache-dir",
            "--only-binary",
            ":all:",
            "--index-url",
            "https://pypi.org/simple",
            "--report",
            str(report),
            "--python-version",
            py,
            "--implementation",
            "cp",
            "--abi",
            f"cp{cp(py)}",
            "--abi",
            "abi3",
            "--abi",
            "none",
            "--target",
            str(Path(d) / "t"),
        ]
        for p in plats:
            argv += ["--platform", p]
        r = subprocess.run([*argv, req], capture_output=True, text=True)  # noqa: S603 - fixed pip argv
        if r.returncode != 0:
            lines = [ln for ln in (r.stderr or r.stdout).strip().splitlines() if ln.strip()]
            return (lines[-1] if lines else f"pip exit {r.returncode}")[:300]
        data = json.loads(report.read_text())
    out = []
    for item in data["install"]:
        info = item["download_info"]
        sha = (info.get("archive_info") or {}).get("hashes", {}).get("sha256")
        url = info["url"]
        if not url.startswith("https://files.pythonhosted.org/") or not sha or not url.endswith(".whl"):
            return f"{item['metadata']['name']}: no hashed wheel on files.pythonhosted.org"
        out.append(
            {
                "name": item["metadata"]["name"],
                "version": item["metadata"]["version"],
                "filename": url.rsplit("/", 1)[1],
                "url": url,
                "sha256": sha,
            }
        )
    return sorted(out, key=lambda x: x["name"].lower())


def lock_pypi(name: str, version: str) -> dict:
    pip = get_json(f"https://pypi.org/pypi/pip/{PIP_VERSION}/json")
    wheel = next(u for u in pip["urls"] if u["filename"].endswith("-py3-none-any.whl"))
    targets: dict[str, list[dict]] = {}
    unsupported: dict[str, str] = {}
    for py in PYTHONS:
        for key, plats in PLATFORMS.items():
            tk = f"cp{cp(py)}-{key}"
            res = resolve_pypi(f"{name}=={version}", py, plats)
            if isinstance(res, str):
                unsupported[tk] = res
                print(f"  {tk}: unsupported ({res})", file=sys.stderr)
            else:
                targets[tk] = res
                print(f"  {tk}: {len(res)} wheels", file=sys.stderr)
    if not targets:
        sys.exit("no supported target")
    return {
        "pip": {
            "version": PIP_VERSION,
            "filename": wheel["filename"],
            "url": wheel["url"],
            "sha256": wheel["digests"]["sha256"],
        },
        "targets": targets,
        "unsupported": unsupported,
    }


def build(pack_id: str) -> dict:
    manifest = yaml.safe_load((PACKS / pack_id / "pack.yaml").read_text())
    if manifest.get("scope") != ["project"]:
        sys.exit(f"{pack_id}: only project-scoped packs get a lock (scope is {manifest.get('scope')})")
    source = manifest["source"]
    kind, _, rest = source.partition(":")
    lock: dict = {"lock_version": LOCK_VERSION, "kind": kind, "spec": spec_of(manifest)}
    if kind == "npm":
        name, _, version = rest.rpartition("@")
        lock.update(package=name, version=version, npm=lock_npm(name, version))
    elif kind == "pypi":
        name, _, version = rest.partition("==")
        lock.update(package=name, version=version, pypi=lock_pypi(name, version))
    else:
        sys.exit(f"{pack_id}: unsupported source {source}")
    return lock


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("pack")
    ap.add_argument("--check", action="store_true", help="only check the lock's spec against the manifest")
    a = ap.parse_args()
    path = PACKS / a.pack / "pack.lock.json"
    if a.check:
        manifest = yaml.safe_load((PACKS / a.pack / "pack.yaml").read_text())
        lock = json.loads(path.read_text())
        if lock.get("spec") != spec_of(manifest):
            sys.exit(f"{path} is out of date: run python3 scripts/pack-lock.py {a.pack}")
        print(f"{path}: matches its manifest")
        return
    lock = build(a.pack)
    path.write_text(json.dumps(lock, indent=1, sort_keys=False) + "\n")
    print(f"wrote {path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()

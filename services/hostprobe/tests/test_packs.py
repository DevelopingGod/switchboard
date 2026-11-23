"""Workflow pack tests (M4.5a, ADR 0018). Run: python3 -m unittest discover -s services/hostprobe/tests

The pack store, the downloads' checks, wrappers, per-job setup (what a setup writes, sorted) and how diff and
commit treat it. A fake pack (a shell script as its program) stands in for real ones; one test installs a real
npm package from local tarballs when node/npm are present. The real OpenSpec and graphify installs are proved
live (docs/m45a.md).
"""

import base64
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest
import zipfile
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from test_hostprobe import sh_git  # noqa: E402

import hostprobe  # noqa: E402
import packs  # noqa: E402

TOOL = r"""#!/bin/sh
# a fake pack program: writes what real packs write
mode="$1"
case "$mode" in
  setup)
    mkdir -p .tool/skills/fake .claude/skills
    echo skill > .tool/skills/fake/SKILL.md
    ln -sf ../../.tool/skills/fake .claude/skills/fake
    mkdir -p spec && echo "# spec" > spec/config.md
    echo "state" > "$HOME/.toolstate"
    mkdir -p "$XDG_CONFIG_HOME/fake" && echo id > "$XDG_CONFIG_HOME/fake/telemetry-id"
    [ -n "$EDIT_AGENTS" ] && printf '\n## fake\nuse the fake tool\n' >> AGENTS.md
    exit 0 ;;
  agentsedit)
    printf '\n## fake\nuse the fake tool\n' >> AGENTS.md
    mkdir -p .tool/skills/fake && echo skill > .tool/skills/fake/SKILL.md
    echo stray > stray.txt
    exit 0 ;;
  escape)
    mkdir -p .claude/skills && ln -sf /etc .claude/skills/escape
    exit 0 ;;
  fail)
    echo "boom" >&2; exit 3 ;;
  build)
    mkdir -p out && echo '{"nodes":[1,2],"links":[1]}' > out/graph.json && echo "$FAKE_ENV" > out/env.txt
    exit 0 ;;
  env)
    env | sort; exit 0 ;;
esac
exit 0
"""


def fake_lock(pid="fake", setup_mode="setup", **spec):
    s = {
        "id": pid,
        "name": "Fake",
        "trust": "verified",
        "source": f"pypi:{pid}==1.0.0",
        "scope": ["project"],
        "hosts": {"claude-code": "claude", "codex": "codex"},
        "bins": {"faketool": "bin/faketool"},
        "env": {"FAKE_ENV": "on"},
        "detect": ["faketool", "--version"],
        "project": {"setup": [["faketool", setup_mode]]},
        "owned": [".tool/**", ".claude/skills/fake"],
        "artifacts": ["spec/**"],
    }
    s.update(spec)
    return {
        "lock_version": 1,
        "kind": "pypi",
        "package": pid,
        "version": "1.0.0",
        "spec": s,
        "pypi": {"targets": {}},
    }


class PackEnv(unittest.TestCase):
    """A temp HOME with a repo, a worktree root, a packs source folder and a store."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name).resolve()
        self.base = base
        self.home = base / "home"
        self.home.mkdir()
        self.src = base / "packs-src"
        self.src.mkdir()
        self.store = self.home / ".switchboard" / "packs"
        self.root = self.home / ".switchboard" / "worktrees"
        self.data = self.home / ".switchboard" / "data"
        self.repo = base / "repo"
        self.repo.mkdir()
        sh_git(self.repo, "init", "-q")
        (self.repo / "a.py").write_text("x = 1\n")
        (self.repo / "AGENTS.md").write_text("# agents\n")
        sh_git(self.repo, "add", "-A")
        sh_git(self.repo, "commit", "-qm", "first")
        self.patches = [
            mock.patch.object(hostprobe, "HOME", self.home),
            mock.patch.object(packs, "HOME", self.home),
            mock.patch.dict(
                os.environ,
                {
                    "SWITCHBOARD_WORKTREE_ROOT": str(self.root),
                    "SWITCHBOARD_PACKS_DIR": str(self.src),
                    "SWITCHBOARD_PACKS_ROOT": str(self.store),
                    "SWITCHBOARD_DATA_DIR": str(self.data),
                },
            ),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        if self.store.exists():
            packs.remove_tree(self.store)
        self.tmp.cleanup()

    def body(self, **kw):
        return {"project": str(self.repo), "slug": "repo", "job_id": 7, **kw}

    def write_lock(self, lock):
        d = self.src / lock["spec"]["id"]
        d.mkdir(exist_ok=True)
        (d / "pack.lock.json").write_text(json.dumps(lock))
        return lock

    def install_fake(self, lock=None, version="1.0.0"):
        """A store version made the way install() makes one, with a shell script as the program."""
        lock = lock or fake_lock()
        lock["version"] = version
        self.write_lock(lock)
        pid = lock["spec"]["id"]
        vdir = packs.version_dir(pid, version)
        (vdir / "bin").mkdir(parents=True)
        tool = vdir / "bin" / "faketool"
        tool.write_text(TOOL)
        tool.chmod(0o755)
        packs.write_wrappers(lock, vdir, self.root, {})
        packs.write_manifest(vdir, {"pack": pid, "version": version, "runtime_paths": []})
        packs.set_readonly(vdir)
        packs._point_at(pid, version, lambda _t: None)
        return vdir

    def worktree(self):
        out = hostprobe.create_worktree(self.body())
        return Path(out["path"]), out["base_sha"]


class LockAndDownloadTests(PackEnv):
    def test_shipped_locks_load_and_global_only_is_refused(self):
        with mock.patch.dict(os.environ, {"SWITCHBOARD_PACKS_DIR": str(packs.SRC_ROOT)}):
            ids = packs.list_locks()
            self.assertIn("openspec", ids)
            self.assertIn("graphify", ids)
            self.assertNotIn("gstack", ids)  # global-only: no lock, refused by the router with its reason
            g = packs.load_lock("graphify")
            self.assertEqual((g["package"], g["kind"]), ("graphifyy", "pypi"))
            self.assertEqual(len(g["pypi"]["targets"]), 16)
        lock = fake_lock(scope=["global"])
        self.write_lock(lock)
        with self.assertRaises(packs.PackError) as e:
            packs.load_lock("fake")
        self.assertIn("globally", e.exception.message)
        for bad in ("../x", "Fake", "", 3):
            with self.assertRaises(packs.PackError):
                packs.load_lock(bad)

    def test_satisfies(self):
        self.assertTrue(packs.satisfies("3.12.3", ">=3.11.5,<3.15"))
        self.assertFalse(packs.satisfies("3.11.4", ">=3.11.5,<3.15"))
        self.assertFalse(packs.satisfies("3.15.0", ">=3.11.5,<3.15"))
        self.assertTrue(packs.satisfies("24.22.3", ">=22.20"))
        self.assertFalse(packs.satisfies("22.19.0", ">=22.20"))

    def test_no_locked_build_names_the_machine(self):
        lock = fake_lock(requires=["python>=3.11.5,<3.15"])
        lock["pypi"]["targets"] = {"cp313-macos_arm64": []}
        rt = packs.runtime(lock, ["/usr/bin"])
        if not rt["checks"][0]["ok"]:
            self.skipTest("no Python 3.11.5-3.14 here")
        self.assertFalse(rt["ok"])
        self.assertIn("no locked build for Python", rt["problem"])
        self.assertIn("Supported: 3.13", rt["problem"])

    def test_download_checks_hash_then_the_name_inside(self):
        def tgz(name, version):
            buf = io.BytesIO()
            with tarfile.open(fileobj=buf, mode="w:gz") as tf:
                data = json.dumps({"name": name, "version": version}).encode()
                info = tarfile.TarInfo("package/package.json")
                info.size = len(data)
                tf.addfile(info, io.BytesIO(data))
            return buf.getvalue()

        def sri(b):
            return "sha512-" + base64.b64encode(hashlib.sha512(b).digest()).decode()

        good = tgz("chalk", "6.0.1")
        f = {
            "name": "chalk",
            "version": "6.0.1",
            "hash": sri(good),
            "url": "https://registry.npmjs.org/x.tgz",
        }
        packs.verify_download("npm", f, good)
        with self.assertRaises(packs.PackError) as e:
            packs.verify_download("npm", f, good + b"x")
        self.assertIn("doesn't match the hash", e.exception.message)
        swapped = tgz("chalkk", "6.0.1")  # a lookalike under the right name in the lock
        with self.assertRaises(packs.PackError) as e:
            packs.verify_download("npm", {**f, "hash": sri(swapped)}, swapped)
        self.assertIn("says it is chalkk", e.exception.message)

        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            z.writestr(
                "graphify-1.0.dist-info/METADATA", "Metadata-Version: 2.1\nName: graphify\nVersion: 1.0\n\n"
            )
        wheel = buf.getvalue()
        w = {"name": "graphifyy", "version": "1.0", "hash": hashlib.sha256(wheel).hexdigest(), "url": "x"}
        with self.assertRaises(packs.PackError) as e:
            packs.verify_download("pypi", w, wheel)
        self.assertIn("graphify 1.0 inside", e.exception.message)

    def test_fetch_only_from_the_registries(self):
        with self.assertRaises(packs.PackError) as e:
            packs.fetch("https://evil.example/pkg.tgz")
        self.assertIn("isn't allowed", e.exception.message)
        with self.assertRaises(packs.PackError):
            packs.fetch("http://registry.npmjs.org/x.tgz")

    def test_minimal_env_has_no_secrets(self):
        with mock.patch.dict(os.environ, {"LITELLM_MASTER_KEY": "sk-secret", "HOSTPROBE_TOKEN": "t" * 32}):
            env = packs.minimal_env(["/usr/bin"], "/tmp/h", {"FAKE": "1"})
        self.assertFalse(any("KEY" in k or "TOKEN" in k for k in env))
        self.assertEqual(env["HOME"], "/tmp/h")


class StoreTests(PackEnv):
    def test_read_only_verified_tamper_refused_with_one_action(self):
        vdir = self.install_fake()
        self.assertFalse(os.access(vdir / "bin" / "faketool", os.W_OK))
        self.assertFalse(os.access(vdir, os.W_OK))
        v = packs.verify("fake")
        self.assertTrue(v["ok"], v)
        self.assertGreaterEqual(v["files"], 2)
        os.chmod(vdir / "bin", 0o755)
        os.chmod(vdir / "bin" / "faketool", 0o755)
        (vdir / "bin" / "faketool").write_text("#!/bin/sh\necho evil\n")
        v = packs.verify("fake")
        self.assertFalse(v["ok"])
        self.assertIn("changed on disk since it was installed", v["problem"])
        self.assertIn("reinstall it in Connections → Packs", v["problem"])
        (vdir / "bin" / "extra").write_text("x")
        self.assertIn("more", packs.verify("fake")["problem"])

    def test_keeps_current_and_previous_prunes_older_rollback_and_uninstall(self):
        for v in ("1.0.0", "1.1.0", "1.2.0"):
            self.install_fake(version=v)
        self.assertEqual((packs.current("fake"), packs.previous("fake")), ("1.2.0", "1.1.0"))
        self.assertEqual(packs.status("fake")["versions"], ["1.1.0", "1.2.0"])  # 1.0.0 pruned
        st = packs.rollback("fake")
        self.assertEqual((st["current"], st["previous"]), ("1.1.0", "1.2.0"))
        # a damaged previous version is not rolled back to
        prev = packs.version_dir("fake", "1.2.0")
        os.chmod(prev / "bin", 0o755)
        (prev / "bin" / "new").write_text("x")
        with self.assertRaises(packs.PackError):
            packs.rollback("fake")
        self.assertEqual(packs.uninstall("fake"), {"id": "fake", "removed": True})
        self.assertFalse((self.store / "fake").exists())
        self.assertEqual(packs.uninstall("fake"), {"id": "fake", "removed": True})  # already gone = success

    def test_rehash_time_is_reported(self):
        self.install_fake()
        v = packs.verify("fake")
        self.assertIsInstance(v["ms"], int)


class WrapperTests(PackEnv):
    def test_wrapper_keeps_state_in_the_worktree_and_refuses_outside(self):
        vdir = self.install_fake()
        wt, _ = self.worktree()
        packs.ensure_sb(wt)
        packs.write_record(wt, {"version": 1, "state": "ready", "packs": {}})
        wrapper = vdir / "sbbin" / "faketool"
        env = {"PATH": "/usr/bin:/bin", "HOME": str(self.home)}
        out = subprocess.run(
            [str(wrapper), "env"], cwd=wt / ".", env=env, capture_output=True, text=True, check=True
        )
        lines = dict(line.split("=", 1) for line in out.stdout.splitlines() if "=" in line)
        h = str(wt / ".switchboard" / "home")
        self.assertEqual(lines["HOME"], h)
        self.assertEqual(lines["XDG_CONFIG_HOME"], h + "/.config")
        self.assertEqual(lines["XDG_DATA_HOME"], h + "/.local/share")
        self.assertEqual(lines["XDG_CACHE_HOME"], h + "/.cache")
        self.assertEqual(lines["PYTHONDONTWRITEBYTECODE"], "1")
        self.assertEqual(lines["FAKE_ENV"], "on")
        # from a subfolder of the worktree too
        (wt / "sub").mkdir()
        subprocess.run([str(wrapper), "env"], cwd=wt / "sub", env=env, capture_output=True, check=True)
        # outside any worktree: refused
        r = subprocess.run([str(wrapper), "env"], cwd=self.repo, env=env, capture_output=True, text=True)
        self.assertEqual(r.returncode, 126)
        self.assertIn("only inside a job's worktree", r.stderr)
        # a folder that pretends to be one, outside the worktree root: refused
        fake = self.base / "elsewhere"
        (fake / ".switchboard").mkdir(parents=True)
        (fake / ".switchboard" / packs.MARKER).write_text("{}")
        r = subprocess.run([str(wrapper), "env"], cwd=fake, env=env, capture_output=True, text=True)
        self.assertEqual(r.returncode, 126)


class SetupTests(PackEnv):
    def setup_packs(self, wt, reqs=None):
        return packs.setup(
            wt,
            self.root,
            reqs or [{"id": "fake", "hosts": ["claude-code"]}],
            hostprobe.git,
            self.data / "packs",
            "repo",
        )

    def test_writes_are_sorted_and_state_stays_in_the_worktree(self):
        self.install_fake()
        wt, base = self.worktree()
        rec = self.setup_packs(wt)
        p = rec["packs"]["fake"]
        self.assertEqual(rec["state"], "ready")
        self.assertEqual(p["owned_dirs"], [".tool"])
        self.assertEqual(p["owned_files"], [".claude/skills/fake"])
        self.assertEqual(p["artifacts"], ["spec/config.md"])
        self.assertEqual(p["edits"], [])
        self.assertTrue((wt / ".switchboard" / "home" / ".toolstate").is_file())
        self.assertTrue((wt / ".switchboard" / "home" / ".config" / "fake" / "telemetry-id").is_file())
        self.assertFalse((self.home / ".toolstate").exists())
        self.assertEqual(rec["bins"], [str(packs.version_dir("fake", "1.0.0") / "sbbin")])
        # idempotent: asking again returns the same record
        self.assertEqual(self.setup_packs(wt)["finished_at"], rec["finished_at"])
        # the diff leaves out owned files, shows the artifacts
        (wt / "a.py").write_text("x = 2\n")
        d = hostprobe.diff_worktree(self.body(base=base))
        paths = {f["path"] for f in d["files"]}
        self.assertEqual(paths, {"a.py", "spec/config.md"})
        self.assertEqual(d["setup_edits"], [])
        c = hostprobe.commit_worktree(self.body(message="job 7"))
        self.assertTrue(c["committed"])
        shown = set(sh_git(wt, "show", "--name-only", "--format=", "HEAD").split())
        self.assertEqual(shown, {"a.py", "spec/config.md"})

    def test_a_projects_own_tracked_skills_stay_committable(self):
        (self.repo / ".claude" / "skills" / "mine").mkdir(parents=True)
        (self.repo / ".claude" / "skills" / "mine" / "SKILL.md").write_text("mine\n")
        sh_git(self.repo, "add", "-A")
        sh_git(self.repo, "commit", "-qm", "my skill")
        self.install_fake()
        wt, base = self.worktree()
        self.setup_packs(wt)
        (wt / ".claude" / "skills" / "mine" / "SKILL.md").write_text("mine, improved\n")
        (wt / ".claude" / "skills" / "new-one.md").write_text("added by the agent\n")
        d = hostprobe.diff_worktree(self.body(base=base))
        paths = {f["path"] for f in d["files"]}
        self.assertIn(".claude/skills/mine/SKILL.md", paths)
        self.assertIn(".claude/skills/new-one.md", paths)
        self.assertNotIn(".claude/skills/fake", paths)
        hostprobe.commit_worktree(self.body(message="job 7"))
        shown = set(sh_git(wt, "show", "--name-only", "--format=", "HEAD").split())
        self.assertIn(".claude/skills/mine/SKILL.md", shown)
        self.assertNotIn(".claude/skills/fake", shown)

    def test_setup_edits_are_unticked_and_the_agents_own_edit_is_kept(self):
        self.install_fake(fake_lock(setup_mode="agentsedit"))
        wt, base = self.worktree()
        rec = self.setup_packs(wt)
        edits = {e["path"]: e for e in rec["packs"]["fake"]["edits"]}
        self.assertEqual(set(edits), {"AGENTS.md", "stray.txt"})
        self.assertEqual((edits["AGENTS.md"]["kind"], edits["stray.txt"]["kind"]), ("modified", "new"))
        # the agent edits AGENTS.md elsewhere (top line) and a.py
        text = (wt / "AGENTS.md").read_text()
        (wt / "AGENTS.md").write_text(text.replace("# agents", "# agents of this repo"))
        (wt / "a.py").write_text("x = 3\n")
        d = hostprobe.diff_worktree(self.body(base=base))
        self.assertEqual({f["path"] for f in d["files"]}, {"a.py"})
        se = {e["path"]: e for e in d["setup_edits"]}
        self.assertTrue(se["AGENTS.md"]["agent_changed"])
        self.assertFalse(se["AGENTS.md"]["both"])
        self.assertIn("## fake", d["setup_diff"])
        c = hostprobe.commit_worktree(self.body(message="job 7"))  # nothing ticked
        self.assertEqual(set(c["left_out"]), {"AGENTS.md", "stray.txt"})
        committed = sh_git(wt, "show", "HEAD:AGENTS.md")
        self.assertIn("# agents of this repo", committed)  # the agent's edit
        self.assertNotIn("## fake", committed)  # the setup's edit, left out
        shown = set(sh_git(wt, "show", "--name-only", "--format=", "HEAD").split())
        self.assertNotIn("stray.txt", shown)

    def test_ticked_setup_edits_are_committed(self):
        self.install_fake(fake_lock(setup_mode="agentsedit"))
        wt, base = self.worktree()
        self.setup_packs(wt)
        c = hostprobe.commit_worktree(self.body(message="job 7", include_setup_edits=["AGENTS.md"]))
        self.assertTrue(c["committed"])
        self.assertIn("## fake", sh_git(wt, "show", "HEAD:AGENTS.md"))
        with self.assertRaises(hostprobe.GitError):
            hostprobe.commit_worktree(self.body(message="x", include_setup_edits=["a.py"]))

    def test_edited_by_both_is_flagged_and_decided_whole(self):
        self.install_fake(fake_lock(setup_mode="agentsedit"))
        wt, base = self.worktree()
        self.setup_packs(wt)
        text = (wt / "AGENTS.md").read_text()
        (wt / "AGENTS.md").write_text(text.replace("use the fake tool", "use the fake tool carefully"))
        d = hostprobe.diff_worktree(self.body(base=base))
        se = {e["path"]: e for e in d["setup_edits"]}
        self.assertTrue(se["AGENTS.md"]["both"])
        (wt / "a.py").write_text("x = 4\n")
        hostprobe.commit_worktree(self.body(message="job 7"))
        self.assertEqual(sh_git(wt, "show", "HEAD:AGENTS.md"), "# agents\n")  # left out whole

    def test_a_link_outside_the_worktree_rolls_back_and_refuses(self):
        self.install_fake(fake_lock(setup_mode="escape"))
        wt, _ = self.worktree()
        rec = self.setup_packs(wt)
        self.assertEqual(rec["packs"], {})
        self.assertIn("points outside the worktree", rec["refused"][0]["reason"])
        self.assertFalse((wt / ".claude" / "skills" / "escape").is_symlink())
        self.assertEqual(sh_git(wt, "status", "--porcelain"), "")

    def test_a_failing_setup_rolls_back(self):
        self.install_fake(fake_lock(setup_mode="fail"))
        wt, _ = self.worktree()
        rec = self.setup_packs(wt)
        self.assertIn("failed (exit 3)", rec["refused"][0]["reason"])

    def test_a_changed_store_is_refused_before_use_and_the_job_goes_on(self):
        vdir = self.install_fake()
        os.chmod(vdir / "bin", 0o755)
        (vdir / "bin" / "x").write_text("x")
        wt, _ = self.worktree()
        rec = self.setup_packs(wt)
        self.assertEqual(rec["state"], "ready")
        self.assertEqual(rec["packs"], {})
        self.assertIn("changed on disk", rec["refused"][0]["reason"])

    def test_unsupported_agent_and_interrupted_setup(self):
        self.install_fake()
        wt, _ = self.worktree()
        rec = self.setup_packs(wt, [{"id": "fake", "hosts": ["opencode"]}])
        self.assertIn("doesn't support this agent", rec["refused"][0]["reason"])
        wt2 = Path(hostprobe.create_worktree(self.body(job_id=8))["path"])
        packs.ensure_sb(wt2)
        packs.write_record(wt2, {"version": 1, "state": "setting_up", "packs": {}})
        with self.assertRaises(packs.PackError) as e:
            packs.setup(
                wt2, self.root, [{"id": "fake", "hosts": ["claude-code"]}], hostprobe.git, self.data, "repo"
            )
        self.assertIn("interrupted", e.exception.message)

    def test_graph_build_uses_and_refreshes_the_project_cache(self):
        lock = fake_lock(
            "graphy",
            owned=["out/**"],
            artifacts=[],
            cache="out",
            project={"prepare": [["faketool", "build"]], "setup": [["faketool", "noop"]]},
        )
        self.install_fake(lock)
        wt, base = self.worktree()
        rec = self.setup_packs(wt, [{"id": "graphy", "hosts": ["claude-code"], "graph": True}])
        p = rec["packs"]["graphy"]
        self.assertEqual(p["owned_dirs"], ["out"])
        self.assertEqual(p["graph_stats"], {"nodes": 2, "edges": 1})
        self.assertEqual((wt / "out" / "env.txt").read_text().strip(), "on")  # the manifest env reached it
        self.assertTrue((self.data / "packs" / "graphy" / "repo" / "out" / "graph.json").is_file())
        (wt / "out" / "more.json").write_text("{}")  # written later (the agent runs an update): still owned
        d = hostprobe.diff_worktree(self.body(base=base))
        self.assertEqual(d["files"], [])
        # the next job starts from the cache
        wt2 = Path(hostprobe.create_worktree(self.body(job_id=9))["path"])
        rec2 = packs.setup(
            wt2,
            self.root,
            [{"id": "graphy", "hosts": ["claude-code"], "graph": True}],
            hostprobe.git,
            self.data / "packs",
            "repo",
        )
        self.assertTrue(rec2["packs"]["graphy"]["cache_used"])

    def test_size_counts_tracked_files(self):
        self.worktree()
        s = hostprobe.worktree_size(self.body())
        self.assertEqual(s["files"], 2)
        self.assertGreater(s["bytes"], 0)


@unittest.skipUnless(shutil.which("npm") and shutil.which("node"), "needs node and npm")
class NpmInstallTests(PackEnv):
    """A real offline `npm ci` from verified local tarballs, through install()."""

    def test_install_offline_from_verified_tarballs(self):
        files = {}

        def pkg(name, version, deps, bin_js=None):
            buf = io.BytesIO()
            meta = {"name": name, "version": version, "dependencies": deps}
            if bin_js:
                meta["bin"] = {"faketool": "cli.js"}
            members = {"package/package.json": json.dumps(meta).encode()}
            if bin_js:
                members["package/cli.js"] = bin_js.encode()
            with tarfile.open(fileobj=buf, mode="w:gz") as tf:
                for n, data in members.items():
                    info = tarfile.TarInfo(n)
                    info.size = len(data)
                    info.mode = 0o755
                    tf.addfile(info, io.BytesIO(data))
            data = buf.getvalue()
            url = f"https://registry.npmjs.org/{name}/-/{name}-{version}.tgz"
            files[url] = data
            return url, "sha512-" + base64.b64encode(hashlib.sha512(data).digest()).decode()

        dep_url, dep_int = pkg("sb-dep", "1.0.0", {})
        top_url, top_int = pkg(
            "sb-top", "2.0.0", {"sb-dep": "1.0.0"}, "#!/usr/bin/env node\nconsole.log('2.0.0')\n"
        )
        lock = {
            "lock_version": 1,
            "kind": "npm",
            "package": "sb-top",
            "version": "2.0.0",
            "spec": {
                "id": "npmfake",
                "name": "Npm fake",
                "trust": "verified",
                "source": "npm:sb-top@2.0.0",
                "requires": ["node>=18"],
                "scope": ["project"],
                "hosts": {"claude-code": "claude"},
                "bins": {"faketool": "node_modules/sb-top/cli.js"},
                "detect": ["faketool", "--version"],
                "project": {"setup": []},
                "owned": [],
                "artifacts": [],
            },
            "npm": {
                "package_json": {"name": "sb-pack", "private": True, "dependencies": {"sb-top": "2.0.0"}},
                "lockfile": {
                    "name": "sb-pack",
                    "lockfileVersion": 3,
                    "requires": True,
                    "packages": {
                        "": {"name": "sb-pack", "dependencies": {"sb-top": "2.0.0"}},
                        "node_modules/sb-top": {
                            "version": "2.0.0",
                            "resolved": top_url,
                            "integrity": top_int,
                            "dependencies": {"sb-dep": "1.0.0"},
                            "bin": {"faketool": "cli.js"},
                        },
                        "node_modules/sb-dep": {
                            "version": "1.0.0",
                            "resolved": dep_url,
                            "integrity": dep_int,
                        },
                    },
                },
                "integrity": top_int,
                "install_scripts": [],
            },
        }
        self.write_lock(lock)
        path = [os.path.dirname(shutil.which("node")), "/usr/bin", "/bin"]
        plan = packs.plan(packs.load_lock("npmfake"), path)
        self.assertIsNone(plan["problem"])
        self.assertEqual(plan["dependencies"], 1)
        self.assertFalse(plan["sudo"])
        logs = []
        t0 = time.monotonic()
        st = packs.install(
            packs.load_lock("npmfake"), path, self.root, logs.append, fetch_fn=files.__getitem__
        )
        self.assertLess(time.monotonic() - t0, 120)
        self.assertEqual(st["current"], "2.0.0")
        v = packs.verify("npmfake")
        self.assertTrue(v["ok"], v)
        self.assertTrue(any("Recorded" in x for x in logs))
        # a swapped tarball is refused and nothing is installed
        packs.uninstall("npmfake")
        bad = dict(files)
        bad[dep_url] = files[top_url]
        with self.assertRaises(packs.PackError):
            packs.install(packs.load_lock("npmfake"), path, self.root, logs.append, fetch_fn=bad.__getitem__)
        self.assertIsNone(packs.current("npmfake"))
        self.assertFalse(packs.version_dir("npmfake", "2.0.0").exists())


class EndpointTests(PackEnv):
    def test_routes_need_the_token_and_answer(self):
        from test_hostprobe import TOKEN, ServerTests  # noqa: F401

        probe = hostprobe.Probe(TOKEN, probe_fn=lambda: {"clis": {}})
        server = hostprobe.ThreadingHTTPServer(("127.0.0.1", 0), hostprobe.make_handler(probe))
        import threading
        import urllib.error
        import urllib.request

        threading.Thread(target=server.serve_forever, daemon=True).start()
        port = server.server_address[1]
        try:
            req = urllib.request.Request(f"http://127.0.0.1:{port}/packs")
            with self.assertRaises(urllib.error.HTTPError) as e:
                urllib.request.urlopen(req, timeout=5)
            self.assertEqual(e.exception.code, 401)
            self.install_fake()
            req = urllib.request.Request(f"http://127.0.0.1:{port}/packs", headers={"X-Probe-Token": TOKEN})
            with mock.patch.object(hostprobe, "service_path", lambda: "/usr/bin:/bin"):
                data = json.load(urllib.request.urlopen(req, timeout=5))
            self.assertEqual([p["id"] for p in data["packs"]], ["fake"])
            self.assertEqual(data["packs"][0]["current"], "1.0.0")
        finally:
            server.shutdown()


if __name__ == "__main__":
    unittest.main()

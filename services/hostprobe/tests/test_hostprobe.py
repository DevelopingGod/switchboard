"""hostprobe tests (stdlib unittest; run: python3 -m unittest discover -s services/hostprobe/tests)."""

import json
import os
import stat
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import hostprobe  # noqa: E402

TOKEN = "t" * 32
SECRET = "sk-ant-oat01-SUPERSECRETTOKENVALUE"


def fake_bin(d: Path, name: str, script: str) -> None:
    p = d / name
    p.write_text("#!/bin/sh\n" + script + "\n")
    p.chmod(p.stat().st_mode | stat.S_IEXEC)


class ProbeCliTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.bin = self.home / "bin"
        self.bin.mkdir()
        self.patch = mock.patch.object(hostprobe, "HOME", self.home)
        self.patch.start()

    def tearDown(self):
        self.patch.stop()
        self.tmp.cleanup()

    def probe(self, name):
        return hostprobe.probe_cli(hostprobe.CLIS[name], [str(self.bin)])

    def test_not_installed(self):
        with mock.patch.object(hostprobe, "windows_copy", return_value=False):
            r = self.probe("grok")
        self.assertEqual(
            r,
            {
                "installed": False,
                "version": None,
                "logged_in": None,
                "windows_only": False,
                "login_method": None,
            },
        )

    def test_windows_only(self):
        with mock.patch.object(hostprobe, "windows_copy", return_value=True):
            r = self.probe("claude")
        self.assertFalse(r["installed"])
        self.assertTrue(r["windows_only"])

    def test_linux_path_excludes_mnt(self):
        self.assertFalse(any(d.startswith("/mnt/") for d in hostprobe.linux_path()))

    def test_installed_logged_in_codex(self):
        fake_bin(
            self.bin,
            "codex",
            'case "$1" in --version) echo "codex-cli 0.98.1";; '
            f'login) echo "Logged in using ChatGPT {SECRET}";; esac',
        )
        r = self.probe("codex")
        self.assertEqual((r["installed"], r["version"], r["logged_in"]), (True, "0.98.1", True))
        self.assertNotIn(SECRET, json.dumps(r))

    def test_installed_logged_out_codex(self):
        fake_bin(
            self.bin,
            "codex",
            'case "$1" in --version) echo "codex-cli 0.98.1";; login) echo "Not logged in"; exit 1;; esac',
        )
        r = self.probe("codex")
        self.assertEqual((r["installed"], r["logged_in"]), (True, False))

    def test_opencode_credentials_count(self):
        fake_bin(
            self.bin, "opencode", 'case "$1" in --version) echo "1.14.2";; auth) echo "2 credentials";; esac'
        )
        self.assertTrue(self.probe("opencode")["logged_in"])

    def test_claude_unknown_command_falls_back_to_stat(self):
        fake_bin(
            self.bin,
            "claude",
            'case "$1" in --version) echo "2.3.1 (Claude Code)";; '
            '*) echo "error: unknown command auth"; exit 1;; esac',
        )
        r = self.probe("claude")
        self.assertFalse(r["logged_in"])
        cred = self.home / ".claude/.credentials.json"
        cred.parent.mkdir()
        cred.write_text(SECRET)
        r = self.probe("claude")
        self.assertTrue(r["logged_in"])
        self.assertIn("stat only", r["login_method"])
        self.assertNotIn(SECRET, json.dumps(r))

    def test_gemini_file_is_never_opened(self):
        fake_bin(self.bin, "gemini", 'echo "0.40.0"')
        cred = self.home / ".gemini/oauth_creds.json"
        cred.parent.mkdir()
        cred.write_text(SECRET)
        real_open = open

        def guarded_open(path, *a, **kw):
            if str(path).startswith(str(self.home / ".gemini")):
                raise AssertionError("credential file opened")
            return real_open(path, *a, **kw)

        with mock.patch("builtins.open", guarded_open):
            r = self.probe("gemini")
        self.assertTrue(r["logged_in"])

    def test_command_timeout(self):
        fake_bin(self.bin, "codex", "sleep 10")
        with mock.patch.object(hostprobe, "CMD_TIMEOUT_S", 0.3):
            t = time.monotonic()
            r = self.probe("codex")
        self.assertLess(time.monotonic() - t, 3)
        self.assertTrue(r["installed"])
        self.assertIsNone(r["version"])
        self.assertFalse(r["logged_in"])  # status timed out -> unknown -> stat fallback (no file)


class ServerTests(unittest.TestCase):
    def start(self, **kw):
        calls = []

        def fake_probe():
            calls.append(1)
            return {"clis": {"codex": {"installed": True}}, "at": 0}

        probe = hostprobe.Probe(TOKEN, probe_fn=fake_probe, **kw)
        server = ThreadingHTTPServer(("127.0.0.1", 0), hostprobe.make_handler(probe))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return f"http://127.0.0.1:{server.server_address[1]}", calls

    def get(self, url, token=TOKEN, method="GET"):
        req = urllib.request.Request(url, method=method, headers={"X-Probe-Token": token} if token else {})
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def test_requires_token(self):
        base, _ = self.start()
        self.assertEqual(self.get(base + "/cli", token=None)[0], 401)
        self.assertEqual(self.get(base + "/cli", token="wrong" * 8)[0], 401)
        self.assertEqual(self.get(base + "/health")[0], 200)

    def test_only_get_cli_and_health(self):
        base, _ = self.start()
        self.assertEqual(self.get(base + "/run?cmd=ls")[0], 404)
        self.assertEqual(self.get(base + "/cli", method="POST")[0], 405)

    def test_cache_and_probe_rate_limit(self):
        base, calls = self.start(probe_limit=(1, 3600.0))
        self.assertEqual(self.get(base + "/cli")[0], 200)
        self.assertEqual(self.get(base + "/cli")[0], 200)  # served from cache
        self.assertEqual(len(calls), 1)
        with mock.patch.object(hostprobe, "CACHE_TTL_S", 0):
            self.assertEqual(self.get(base + "/cli")[0], 429)

    def test_request_rate_limit(self):
        base, _ = self.start(request_limit=(2, 3600.0))
        codes = [self.get(base + "/health")[0] for _ in range(3)]
        self.assertEqual(codes, [200, 200, 429])

    def test_short_token_rejected(self):
        with self.assertRaises(ValueError):
            hostprobe.Probe("short")


class EnvFileTests(unittest.TestCase):
    def test_reads_only_named_value(self):
        with tempfile.NamedTemporaryFile("w", suffix=".env", delete=False) as f:
            f.write("GROQ_API_KEY=gsk_x\nHOSTPROBE_TOKEN=abc123\n")
        try:
            self.assertEqual(hostprobe.read_env_value(Path(f.name), "HOSTPROBE_TOKEN"), "abc123")
        finally:
            os.unlink(f.name)


if __name__ == "__main__":
    unittest.main()

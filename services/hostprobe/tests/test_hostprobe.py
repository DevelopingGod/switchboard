"""hostprobe tests (stdlib unittest; run: python3 -m unittest discover -s services/hostprobe/tests)."""

import hashlib
import json
import os
import shutil
import stat
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.parse
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

    def test_unknown_paths_and_methods(self):
        base, _ = self.start()
        self.assertEqual(self.get(base + "/run?cmd=ls")[0], 404)
        self.assertEqual(self.get(base + "/cli", method="POST")[0], 404)
        self.assertEqual(self.get(base + "/install/rm/plan", method="POST")[0], 404)  # not in INSTALLS
        self.assertEqual(self.get(base + "/cli", method="PUT")[0], 405)
        self.assertEqual(self.get(base + "/cli", method="DELETE")[0], 405)

    def test_fresh_bypasses_cache_but_spends_a_probe(self):
        base, calls = self.start()
        self.get(base + "/cli")
        self.get(base + "/cli")
        self.assertEqual(len(calls), 1)
        self.get(base + "/cli?fresh=1")
        self.assertEqual(len(calls), 2)

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


SCRIPT_OK = (
    b"#!/bin/sh\necho installing $1\necho \"token sk-abcdefghijklmnopqrstuv\"\nprintf 'a\\rb\\n'\nexit 0\n"
)
SCRIPT_FAIL = b"#!/bin/sh\necho boom >&2\nexit 3\n"
SCRIPT_SLOW = b"#!/bin/sh\necho start\nsleep 30\n"
SCRIPT_SUDO = b"#!/bin/sh\nsudo true && echo ROOT_OK\nexit 0\n"


def texts(job) -> list[str]:
    return [e["t"] for e in job.lines]


def spec(**kw):
    base = {
        "method": "script",
        "source": "https://example.test/install.sh",
        "version": "1.2.3",
        "docs": "https://example.test/docs",
        "effects": ("installs a thing",),
        "interpreter": "sh",
        "args": ("1.2.3",),
        "hosts": ("example.test",),
    }
    return hostprobe.InstallSpec(**{**base, **kw})


class InstallerTests(unittest.TestCase):
    def installer(self, body=SCRIPT_OK, **kw):
        done = []
        specs = {"opencode": spec(), "gemini": spec(method="npm", source="@g/cli", version="0.1.0", args=())}
        inst = hostprobe.Installer(
            specs=specs,
            fetch=lambda url, hosts: body,
            path_fn=lambda: ["/usr/bin", "/bin"],
            on_success=lambda: done.append(1),
            **kw,
        )
        return inst, done

    def wait(self, job, state=None):
        end = time.monotonic() + 10
        while job.state == "running" and time.monotonic() < end:
            time.sleep(0.02)
        return job

    def test_plan_shows_commands_hash_and_source(self):
        inst, _ = self.installer()
        p = inst.plan("opencode")
        self.assertEqual(p["source"], "https://example.test/install.sh")
        self.assertEqual(len(p["sha256"]), 64)
        self.assertFalse(p["sudo"])
        self.assertIn("sh install.sh 1.2.3", p["commands"][1])
        self.assertTrue(p["plan_id"])

    def test_run_streams_cleaned_log_and_succeeds(self):
        inst, done = self.installer()
        plan = inst.plan("opencode")
        job = self.wait(inst.job(inst.start("opencode", plan["plan_id"])["id"]))
        self.assertEqual((job.state, job.exit_code), ("ok", 0))
        self.assertEqual(done, [1])
        lines = texts(job)
        self.assertIn("installing 1.2.3", lines)
        self.assertIn("token [redacted]", lines)
        # "a\rb\n": "a" is a redraw (replaced in the UI) and "b" is the final line.
        self.assertEqual(
            [(e["t"], e["r"]) for e in job.lines if e["t"] in ("a", "b")], [("a", True), ("b", False)]
        )

    def test_failure_is_reported(self):
        inst, done = self.installer(SCRIPT_FAIL)
        job = self.wait(inst.job(inst.start("opencode", inst.plan("opencode")["plan_id"])["id"]))
        self.assertEqual((job.state, job.exit_code), ("failed", 3))
        self.assertEqual(done, [])

    def test_plan_is_single_use_and_bound_to_its_cli(self):
        inst, _ = self.installer()
        plan_id = inst.plan("opencode")["plan_id"]
        with self.assertRaises(hostprobe.InstallError) as e:
            inst.start("gemini", plan_id)  # another CLI's plan id
        self.assertEqual(e.exception.status, 410)
        inst2, _ = self.installer()
        plan_id = inst2.plan("opencode")["plan_id"]
        self.wait(inst2.job(inst2.start("opencode", plan_id)["id"]))
        with self.assertRaises(hostprobe.InstallError) as e:
            inst2.start("opencode", plan_id)
        self.assertEqual(e.exception.status, 410)

    def test_expired_plan_rejected(self):
        inst, _ = self.installer()
        plan_id = inst.plan("opencode")["plan_id"]
        with mock.patch.object(hostprobe.time, "monotonic", return_value=time.monotonic() + 10_000):
            with self.assertRaises(hostprobe.InstallError) as e:
                inst.start("opencode", plan_id)
        self.assertEqual(e.exception.status, 410)

    def test_one_install_at_a_time_and_cancel(self):
        inst, _ = self.installer(SCRIPT_SLOW)
        first = inst.start("opencode", inst.plan("opencode")["plan_id"])
        with self.assertRaises(hostprobe.InstallError) as e:
            inst.start("opencode", inst.plan("opencode")["plan_id"])
        self.assertEqual(e.exception.status, 409)
        inst.cancel(first["id"])
        job = self.wait(inst.job(first["id"]))
        self.assertEqual(job.state, "cancelled")

    def test_timeout_stops_the_install(self):
        inst, done = self.installer(SCRIPT_SLOW, timeout_s=0.3)
        job = self.wait(inst.job(inst.start("opencode", inst.plan("opencode")["plan_id"])["id"]))
        self.assertEqual(job.state, "timeout")
        self.assertEqual(done, [])

    def test_sudo_is_blocked(self):
        inst, _ = self.installer(SCRIPT_SUDO)
        job = self.wait(inst.job(inst.start("opencode", inst.plan("opencode")["plan_id"])["id"]))
        self.assertNotIn("ROOT_OK", texts(job))
        self.assertTrue(any("sudo is not allowed" in line for line in texts(job)))

    def test_refuses_to_run_as_root(self):
        inst, _ = self.installer()
        plan_id = inst.plan("opencode")["plan_id"]
        with mock.patch.object(hostprobe.os, "geteuid", return_value=0):
            with self.assertRaises(hostprobe.InstallError) as e:
                inst.start("opencode", plan_id)
        self.assertEqual(e.exception.status, 403)

    def test_npm_refuses_global_prefix_outside_home(self):
        inst, _ = self.installer()
        with (
            mock.patch.object(hostprobe, "which", return_value="/usr/bin/npm"),
            mock.patch.object(hostprobe, "run", return_value=(0, "/usr\n")),
        ):
            with self.assertRaises(hostprobe.InstallError) as e:
                inst.plan("gemini")
        self.assertIn("home directory", e.exception.message)

    def test_plan_rate_limited(self):
        inst, _ = self.installer(plan_limit=(1, 3600.0))
        inst.plan("opencode")
        with self.assertRaises(hostprobe.InstallError) as e:
            inst.plan("opencode")
        self.assertEqual(e.exception.status, 429)


FIXTURES = Path(__file__).resolve().parent / "fixtures"


class LineAssemblerTests(unittest.TestCase):
    def feed_all(self, data: bytes, clock=None, chunk: int = 7):
        asm = hostprobe.LineAssembler(
            clock or (lambda: 0.0)
        )  # a frozen clock: only percent changes get through
        out = []
        for i in range(0, len(data), chunk):  # awkward chunk size on purpose
            out += asm.feed(data[i : i + chunk])
        return out + asm.feed(b"", final=True)

    def test_recorded_curl_progress_is_redraws_then_one_final_line(self):
        # Real `curl -#` output (recorded from x.ai/cli/install.sh): redraws separated by \r.
        raw = (FIXTURES / "curl_progress.bin").read_bytes()
        self.assertGreater(raw.count(b"\r"), 3)
        entries = self.feed_all(raw, clock=iter(range(0, 10_000, 1)).__next__)
        self.assertTrue(entries[-1]["t"].endswith("100.0%"))
        self.assertFalse(entries[-1]["r"])  # the closing "\n" makes it final
        self.assertTrue(all(e["r"] for e in entries[:-1]))  # everything before is a redraw
        self.assertEqual(entries[-1]["p"], 100.0)
        percents = [e["p"] for e in entries if e["p"] is not None]
        self.assertEqual(percents, sorted(percents))  # progress only moves forward

    def test_carriage_return_replaces_and_crlf_is_a_normal_newline(self):
        out = self.feed_all(b"one\r\ntwo\rthree\r\nfour\n")
        self.assertEqual(
            [(e["t"], e["r"]) for e in out],
            [("one", False), ("two", True), ("three", False), ("four", False)],
        )

    def test_ansi_control_codes_and_secrets_are_stripped(self):
        out = self.feed_all(b"\x1b[0m\x1b[90mhello\x1b[0m \x07sk-abcdefghijklmnop\n")
        self.assertEqual(out[0]["t"], "hello [redacted]")

    def test_clear_line_redraw_with_nothing_left_is_dropped(self):
        self.assertEqual(self.feed_all(b"\r\x1b[K\r\x1b[K\n"), [])

    def test_utf8_split_across_chunks(self):
        out = self.feed_all("└  1 credentials\n".encode(), chunk=1)
        self.assertEqual(out[0]["t"], "└  1 credentials")

    def test_unterminated_last_line_is_flushed(self):
        self.assertEqual(self.feed_all(b"done")[0]["t"], "done")

    def test_a_big_download_cannot_flood_the_log(self):
        # 500 redraws, 0.2 % apart (0 -> 100 %), 1 ms apart: only whole-percent changes get through.
        data = b"".join(f"{'#' * int(i / 7)} {i * 0.2:.1f}%\r".encode() for i in range(500)) + b"x\n"
        clock = iter(i / 1000 for i in range(10_000)).__next__
        entries = self.feed_all(data, clock=clock)
        self.assertLess(len(entries), 105)  # about one per whole percent, not 500
        self.assertEqual(entries[-1]["t"], "x")

    def test_percent_detection(self):
        p = hostprobe.percent_of
        self.assertEqual(p("######## 45.2%"), 45.2)
        self.assertEqual(p("100.0%"), 100.0)
        self.assertEqual(
            p("  7 15443    7  1024    0     0   5000      0  0:00:03 --:--:--"), 7.0
        )  # curl's table row
        self.assertIsNone(p("Installing opencode"))
        self.assertIsNone(p("#=#=#"))


class UserPathTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        (self.home / ".opencode/bin").mkdir(parents=True)
        fake_bin(self.home / ".opencode/bin", "opencode", 'echo "1.19.6"')
        patch = mock.patch.object(hostprobe, "HOME", self.home)
        patch.start()
        self.addCleanup(patch.stop)
        self.addCleanup(self.tmp.cleanup)
        self.path = [str(self.home / ".opencode/bin")]

    def probe(self, user_path):
        with mock.patch.object(hostprobe, "parse_auth", return_value=True):
            return hostprobe.probe_cli(hostprobe.CLIS["opencode"], self.path, user_path)

    def test_on_path_when_a_new_terminal_has_the_directory(self):
        r = self.probe(f"/usr/bin:{self.home}/.opencode/bin:/bin")
        self.assertTrue(r["on_user_path"])
        self.assertEqual((r["bin_dir"], r["bin_path"]), ("~/.opencode/bin", "~/.opencode/bin/opencode"))

    def test_not_on_path_is_reported(self):
        self.assertFalse(self.probe("/usr/bin:/bin")["on_user_path"])

    def test_unknown_when_the_login_shell_could_not_be_read(self):
        self.assertIsNone(self.probe(None)["on_user_path"])

    def test_home_relative_display_never_leaks_the_absolute_home(self):
        r = self.probe("/usr/bin")
        self.assertNotIn(str(self.home), json.dumps(r))
        self.assertEqual(hostprobe.display_path("/usr/bin"), "/usr/bin")

    def test_bash_path_reads_only_the_delimited_value(self):
        fake = mock.Mock(
            stdout="bash: cannot set terminal process group\nhello from .bashrc\n<</a:/b/c>>", returncode=0
        )
        with mock.patch.object(hostprobe.subprocess, "run", return_value=fake) as run:
            self.assertEqual(hostprobe.bash_path(["/usr/bin", "/bin"]), "/a:/b/c")
        argv = run.call_args.args[0]
        self.assertEqual(argv[1:], ["-lic", 'printf "<<%s>>" "$PATH"'])  # fixed argv, nothing from a request

    def test_bash_path_failure_is_unknown(self):
        with mock.patch.object(
            hostprobe.subprocess, "run", side_effect=hostprobe.subprocess.TimeoutExpired("bash", 8)
        ):
            self.assertIsNone(hostprobe.bash_path(["/usr/bin", "/bin"]))


class OpenCodeStatusTests(unittest.TestCase):
    """Real `opencode auth list` output (v1.19.6, recorded 2026-11-17 inside the hostprobe environment:
    NO_COLOR=1, no tty). It still contains ANSI codes and box-drawing characters."""

    HEAD = "\x1b[0m\n\u250c  Credentials \x1b[90m~/.local/share/opencode/auth.json\n\u2502\n"
    LOGGED_IN = HEAD + "\u25cf  OpenCode \x1b[90mapi\n\u2502\n\u2514  1 credentials\n\n"
    LOGGED_OUT = HEAD + "\u2514  0 credentials\n\n"

    def test_parses_the_real_output(self):
        parse = hostprobe.parse_auth
        self.assertIs(parse("opencode", 0, self.LOGGED_IN), True)
        self.assertIs(parse("opencode", 0, self.LOGGED_OUT), False)

    def test_a_format_we_do_not_recognise_is_unknown_not_logged_out(self):
        self.assertIsNone(hostprobe.parse_auth("opencode", 0, "something else entirely"))


class ClaudeStatusTests(unittest.TestCase):
    """Real `claude auth status --json` (claude 2.1.326, recorded 2026-11-19). The account fields are
    placeholders here: only `loggedIn` is ever read."""

    LOGGED_IN = (
        '{\n  "loggedIn": true,\n  "authMethod": "claude.ai",\n  "apiProvider": "firstParty",\n'
        '  "email": "someone@example.com",\n  "subscriptionType": "pro"\n}\n'
    )

    def test_logged_in(self):
        self.assertIs(hostprobe.parse_auth("claude", 0, self.LOGGED_IN), True)

    def test_logged_out_is_false_whatever_the_exit_code(self):
        for code in (0, 1):
            self.assertIs(hostprobe.parse_auth("claude", code, '{"loggedIn": false}'), False)

    def test_unrecognised_output_is_unknown_not_logged_out(self):
        for out in ("", "Not logged in", "[]", '{"loggedIn": "yes"}', '{"authMethod": "x"}'):
            self.assertIsNone(hostprobe.parse_auth("claude", 0, out), out)

    def test_the_account_details_are_not_returned(self):
        d = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, d, True)
        fake_bin(
            d,
            "claude",
            'case "$1" in --version) echo "2.1.326 (Claude Code)";; auth) cat <<\'J\'\n'
            + self.LOGGED_IN
            + "J\n;; esac",
        )
        r = hostprobe.probe_cli(hostprobe.CLIS["claude"], [str(d)])
        self.assertIs(r["logged_in"], True)
        self.assertNotIn("someone@example.com", json.dumps(r))


class CodexStatusTests(unittest.TestCase):
    """Real `codex login status` (codex-cli 0.170.0, Linux build, recorded 2026-11-19)."""

    def test_logged_in(self):
        self.assertIs(hostprobe.parse_auth("codex", 0, "Logged in using ChatGPT\n"), True)

    def test_logged_out_exits_1(self):
        self.assertIs(hostprobe.parse_auth("codex", 1, "Not logged in\n"), False)


class InstallTableTests(unittest.TestCase):
    """The real allowlist: never sudo, never unsafe-perm, https from a known host, pinned versions."""

    def test_table_is_safe(self):
        # hermes is detected only (M4a): there is no verified installer to pin yet.
        self.assertEqual(set(hostprobe.INSTALLS), set(hostprobe.CLIS) - {"hermes"})
        for name, s in hostprobe.INSTALLS.items():
            words = [s.source, s.interpreter, *s.args, *(f"{k}={v}" for k, v in s.env)]
            for w in words:
                self.assertNotIn("sudo", w, name)
                self.assertNotIn("unsafe-perm", w, name)
            self.assertRegex(s.version, r"^\d+\.\d+\.\d+$", name)
            self.assertTrue(s.docs.startswith("https://"), name)
            if s.method == "script":
                self.assertTrue(s.source.startswith("https://"), name)
                self.assertIn(urllib.parse.urlparse(s.source).hostname, s.hosts, name)
                self.assertIn(
                    s.version, " ".join([*s.args, *(v for _, v in s.env)]), f"{name}: version not passed"
                )
            else:
                self.assertEqual(s.method, "npm", name)

    def test_claude_uses_the_official_native_installer_and_never_skips_scripts(self):
        """The npm package needs its postinstall to fetch the native binary ("native binary not
        installed" when it is skipped). Claude Code installs only through Anthropic's own installer."""
        s = hostprobe.INSTALLS["claude"]
        self.assertEqual((s.method, s.source), ("script", "https://claude.ai/install.sh"))
        self.assertEqual(s.interpreter, "bash")
        for words in (s.source, s.interpreter, *s.args, *(f"{k}={v}" for k, v in s.env)):
            for banned in ("npm", "ignore-scripts", "@anthropic-ai", "sudo", "unsafe-perm"):
                self.assertNotIn(banned, words)
        # the plan is downloaded, hashed and shown like the others
        body = b"#!/bin/bash\necho claude installer\n"
        inst = hostprobe.Installer(
            specs={"claude": s}, fetch=lambda url, hosts: body, path_fn=lambda: ["/usr/bin", "/bin"]
        )
        plan = inst.plan("claude")
        self.assertEqual(plan["method"], "script")
        self.assertEqual(plan["source"], "https://claude.ai/install.sh")
        self.assertEqual(plan["sha256"], hashlib.sha256(body).hexdigest())
        self.assertEqual(plan["size"], len(body))
        self.assertIn("bash install.sh", plan["commands"][1])
        self.assertNotIn("npm", " ".join(plan["commands"]))
        self.assertFalse(plan["sudo"])

    def test_fetch_rejects_other_hosts_and_non_scripts(self):
        with self.assertRaises(hostprobe.InstallError):
            hostprobe.fetch_script("http://claude.ai/install.sh", ("claude.ai",))
        with self.assertRaises(hostprobe.InstallError):
            hostprobe.fetch_script("https://evil.test/x.sh", ("claude.ai",))


class InstallEndpointTests(ServerTests):
    def test_plan_run_events_over_http(self):
        inst = hostprobe.Installer(
            specs={"opencode": spec()}, fetch=lambda u, h: SCRIPT_OK, path_fn=lambda: ["/usr/bin", "/bin"]
        )
        probe = hostprobe.Probe(TOKEN, probe_fn=lambda: {}, installer=inst)
        server = ThreadingHTTPServer(("127.0.0.1", 0), hostprobe.make_handler(probe))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        base = f"http://127.0.0.1:{server.server_address[1]}"

        def post(path, body=None, token=TOKEN):
            req = urllib.request.Request(
                base + path,
                data=json.dumps(body or {}).encode(),
                method="POST",
                headers={"X-Probe-Token": token},
            )
            try:
                with urllib.request.urlopen(req, timeout=5) as r:
                    return r.status, json.loads(r.read())
            except urllib.error.HTTPError as e:
                return e.code, json.loads(e.read())

        with mock.patch.dict(hostprobe.INSTALLS, {"opencode": spec()}):
            self.assertEqual(post("/install/opencode/plan", token="x" * 32)[0], 401)
            code, plan = post("/install/opencode/plan")
            self.assertEqual(code, 200)
            self.assertEqual(post("/install/opencode/run", {"plan_id": 5})[0], 400)
            self.assertEqual(post("/install/opencode/run", {"plan_id": "nope"})[0], 410)
            code, job = post("/install/opencode/run", {"plan_id": plan["plan_id"]})
            self.assertEqual(code, 202)
            req = urllib.request.Request(
                f"{base}/install/jobs/{job['id']}/events", headers={"X-Probe-Token": TOKEN}
            )
            with urllib.request.urlopen(req, timeout=10) as r:
                body = r.read().decode()
        self.assertIn("event: log", body)
        self.assertIn("installing 1.2.3", body)
        self.assertIn('event: exit\ndata: {"state": "ok", "exit_code": 0}', body)


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


class HardwareTests(unittest.TestCase):
    """M3a: GPU memory + RAM for the local-model profile."""

    def test_parse_nvidia_smi_takes_the_largest_gpu(self):
        out = "NVIDIA GeForce RTX 3050 Laptop GPU, 4096\nNVIDIA RTX 4090, 24564\n"
        self.assertEqual(hostprobe.parse_nvidia_smi(out), ("NVIDIA RTX 4090", 24564))
        self.assertEqual(hostprobe.parse_nvidia_smi("garbage"), (None, None))

    def test_parse_meminfo(self):
        self.assertEqual(hostprobe.parse_meminfo("MemTotal:       14235296 kB\nMemFree: 1 kB\n"), 13901)
        self.assertIsNone(hostprobe.parse_meminfo(""))

    def test_probe_hw_runs_one_fixed_argv(self):
        with tempfile.TemporaryDirectory() as d:
            fake_bin(Path(d), "nvidia-smi", 'echo "Test GPU, 8192"')
            with mock.patch.object(hostprobe, "NVIDIA_SMI_DIRS", [d]):
                hw = hostprobe.probe_hw()
        self.assertEqual((hw["gpu"], hw["vram_mb"], hw["source"]), ("Test GPU", 8192, "nvidia-smi"))

    def test_no_gpu(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.object(hostprobe, "NVIDIA_SMI_DIRS", [d]):
            hw = hostprobe.probe_hw()
        self.assertIsNone(hw["vram_mb"])
        self.assertIn("nvidia-smi missing", hw["error"])

    def test_hw_endpoint_needs_token_and_is_cached(self):
        probe = hostprobe.Probe(TOKEN)
        calls = []
        probe.hw_fn = lambda: calls.append(1) or {"gpu": "G", "vram_mb": 4096, "ram_mb": 1, "source": "x"}
        server = ThreadingHTTPServer(("127.0.0.1", 0), hostprobe.make_handler(probe))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        url = f"http://127.0.0.1:{server.server_address[1]}/hw"
        with self.assertRaises(urllib.error.HTTPError) as e:
            urllib.request.urlopen(url, timeout=5)
        self.assertEqual(e.exception.code, 401)
        for _ in range(2):
            req = urllib.request.Request(url, headers={"X-Probe-Token": TOKEN})
            with urllib.request.urlopen(req, timeout=5) as r:
                self.assertEqual(json.loads(r.read())["vram_mb"], 4096)
        self.assertEqual(len(calls), 1)


# --- M4a: job worktrees (ADR 0008) -----------------------------------------------------------------
def sh_git(cwd: Path, *args: str) -> str:
    import subprocess

    env = {"HOME": str(cwd), "PATH": "/usr/bin:/bin", "GIT_CONFIG_NOSYSTEM": "1"}
    return subprocess.run(  # noqa: S603 - fixed test argv
        ["/usr/bin/git", "-c", "user.name=T", "-c", "user.email=t@x", "-c", "init.defaultBranch=main", *args],
        cwd=cwd,
        env=env,
        capture_output=True,
        text=True,
        check=True,
    ).stdout


class GitWorktreeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name).resolve()
        self.home = base / "home"
        self.home.mkdir()
        self.repo = base / "repo"
        self.repo.mkdir()
        sh_git(self.repo, "init", "-q")
        (self.repo / "a.py").write_text("x = 1\n")
        sh_git(self.repo, "add", "-A")
        sh_git(self.repo, "commit", "-qm", "first")
        self.root = self.home / ".switchboard" / "worktrees"
        self.patches = [
            mock.patch.object(hostprobe, "HOME", self.home),
            mock.patch.dict(os.environ, {"SWITCHBOARD_WORKTREE_ROOT": str(self.root)}),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    def body(self, **kw):
        return {"project": str(self.repo), "slug": "repo", "job_id": 7, **kw}

    def test_inspect(self):
        info = hostprobe.inspect_repo(str(self.repo))
        self.assertTrue(info["is_repo"] and info["is_top"] and info["has_commits"])
        self.assertEqual(info["head_branch"], "main")
        self.assertFalse(info["is_self"])
        (self.repo / "sub").mkdir()
        self.assertFalse(hostprobe.inspect_repo(str(self.repo / "sub"))["is_top"])
        plain = Path(self.tmp.name) / "plain"
        plain.mkdir()
        self.assertFalse(hostprobe.inspect_repo(str(plain))["is_repo"])
        self.assertTrue(hostprobe.inspect_repo(str(hostprobe.SELF_REPO))["is_self"])
        for bad in ("relative/path", "/no/such/folder", 5, "/nonexistent/\0x", "~other/repo"):
            with self.assertRaises(hostprobe.GitError):
                hostprobe.inspect_repo(bad)

    def test_inspect_expands_a_home_relative_path(self):
        mine = self.home / "code"
        mine.mkdir()
        sh_git(mine, "init", "-q")
        info = hostprobe.inspect_repo("~/code")
        self.assertEqual(info["path"], str(mine))
        self.assertTrue(info["is_repo"] and info["is_top"])
        with self.assertRaises(hostprobe.GitError) as e:
            hostprobe.inspect_repo("code")
        self.assertIn("full path", e.exception.message)

    def test_create_is_a_new_branch_outside_the_repo_and_idempotent(self):
        out = hostprobe.create_worktree(self.body())
        wt = self.root / "repo" / "job-7"
        self.assertEqual((out["path"], out["branch"], out["created"]), (str(wt), "switchboard/job-7", True))
        self.assertEqual(sh_git(wt, "branch", "--show-current").strip(), "switchboard/job-7")
        self.assertEqual(sh_git(self.repo, "branch", "--show-current").strip(), "main")  # yours untouched
        self.assertEqual(sh_git(self.repo, "status", "--porcelain"), "")  # nothing appears in your checkout
        again = hostprobe.create_worktree(self.body())
        self.assertEqual(
            (again["path"], again["created"], again["base_sha"]), (str(wt), False, out["base_sha"])
        )

    def test_refusals(self):
        cases = [
            (self.body(slug="../evil"), 400),
            (self.body(slug="Repo"), 400),
            (self.body(job_id=0), 400),
            (self.body(job_id="7"), 400),
            (self.body(job_id=True), 400),
            (self.body(project=str(self.repo / "nope")), 404),
            (self.body(project="repo"), 400),
        ]
        for body, status in cases:
            with self.assertRaises(hostprobe.GitError) as e:
                hostprobe.create_worktree(body)
            self.assertEqual(e.exception.status, status, body)
        empty = Path(self.tmp.name) / "empty"
        empty.mkdir()
        sh_git(empty, "init", "-q")
        with self.assertRaises(hostprobe.GitError) as e:
            hostprobe.create_worktree(self.body(project=str(empty)))
        self.assertIn("no commits", e.exception.message)

    def test_never_the_switchboard_repo_itself(self):
        with self.assertRaises(hostprobe.GitError) as e:
            hostprobe.create_worktree(self.body(project=str(hostprobe.SELF_REPO)))
        self.assertEqual(e.exception.status, 403)

    def test_diff_commit_list_remove(self):
        out = hostprobe.create_worktree(self.body())
        wt = Path(out["path"])
        (wt / "a.py").write_text("x = 2\n")
        (wt / "new.py").write_text("y = 3\n")
        d = hostprobe.diff_worktree(self.body(base=out["base_sha"]))
        self.assertEqual({f["path"] for f in d["files"]}, {"a.py", "new.py"})
        self.assertIn("+x = 2", d["diff"])
        self.assertIn("+y = 3", d["diff"])
        with self.assertRaises(hostprobe.GitError):
            hostprobe.diff_worktree(self.body(base="HEAD; rm -rf /"))
        listed = hostprobe.list_worktrees(str(self.repo), "repo")["worktrees"]
        self.assertEqual([(w["job_id"], w["merged"]) for w in listed], [(7, True)])  # tip == base so far
        c = hostprobe.commit_worktree(self.body(message="Switchboard job 7: change x"))
        self.assertTrue(c["committed"])
        self.assertEqual(
            sh_git(self.repo, "log", "-1", "--format=%s", "switchboard/job-7").strip(),
            "Switchboard job 7: change x",
        )
        self.assertEqual(
            sh_git(self.repo, "log", "-1", "--format=%s", "main").strip(), "first"
        )  # main unchanged
        self.assertFalse(hostprobe.commit_worktree(self.body(message="again"))["committed"])
        listed = hostprobe.list_worktrees(str(self.repo), "repo")
        self.assertFalse(listed["worktrees"][0]["merged"])
        self.assertGreater(listed["bytes"], 0)
        sh_git(self.repo, "merge", "-q", "--ff-only", "switchboard/job-7")
        self.assertTrue(hostprobe.list_worktrees(str(self.repo), "repo")["worktrees"][0]["merged"])
        self.assertTrue(hostprobe.remove_worktree(self.body())["removed"])
        self.assertFalse(wt.exists())
        self.assertIn("switchboard/job-7", sh_git(self.repo, "branch", "--list", "switchboard/job-7"))  # kept
        self.assertTrue(hostprobe.remove_worktree(self.body())["removed"])  # already gone = success
        wt.mkdir(parents=True)  # an empty leftover folder is cleared; a non-empty one is never touched
        self.assertTrue(hostprobe.remove_worktree(self.body())["removed"])
        self.assertFalse(wt.exists())
        wt.mkdir(parents=True)
        (wt / "keep.txt").write_text("x")
        hostprobe.remove_worktree(self.body())
        self.assertTrue((wt / "keep.txt").exists())
        with self.assertRaises(hostprobe.GitError) as e:
            hostprobe.diff_worktree(self.body(base=out["base_sha"]))
        self.assertEqual(e.exception.status, 404)

    def test_listening_reads_proc_net(self):
        tcp = (
            "  sl  local_address rem_address   st\n"
            "   0: 0100007F:0C1C 00000000:0000 0A 0\n"  # 127.0.0.1:3100 LISTEN
            "   1: 00000000:1F90 00000000:0000 0A 0\n"  # 0.0.0.0:8080 LISTEN
        )
        with mock.patch.object(
            hostprobe, "read_proc", side_effect=lambda n: tcp if n.endswith("tcp") else ""
        ):
            self.assertEqual(
                hostprobe.listening("3100"), {"port": 3100, "addresses": ["127.0.0.1"], "loopback_only": True}
            )
            self.assertFalse(hostprobe.listening("8080")["loopback_only"])
            self.assertEqual(hostprobe.listening("9")["addresses"], [])
        with self.assertRaises(hostprobe.GitError):
            hostprobe.listening("3100; ls")

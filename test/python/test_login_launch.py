"""/bb init --login: the agent's shell has no terminal for the hidden password prompt, so SKILL.md has the agent
run `bb.py init --login --launch --format table`. That opens a real terminal (tab, else window) running the
installed `bb.py init --login --pause`, and returns at once. It never claims a sign-in that did not start, never
opens a second one, and never carries a password or API secret.

Terminals are fakes (shell scripts on PATH, or injected functions); nothing here opens a real window or contacts a
real Brewboard server.
"""
import json
import os
import select
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from support import BB_PY, ROOT, TempHome, clean_env, run, write_config
from bbclient import config, signin, terminal  # noqa: E402  (support puts dist/skill/scripts on sys.path)
from bbclient.errors import BBError  # noqa: E402

TERMS = terminal.load_terminals()
BY_NAME = {t["name"]: t for t in TERMS}
SECRET = "s-test-not-real-0123456789"
PASSWORD = "Pa55-word-never-logged"
LAUNCH = ["init", "--login", "--launch"]


def has(*bins):
    return lambda b: f"/usr/bin/{b}" if b in bins else None


class FakeProc:
    def __init__(self, code=None):
        self.code = code

    def poll(self):
        return self.code


class Env:
    """BB_HOME pointed at a temporary directory for in-process tests of bbclient.signin."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="bb-launch-")
        self.home = self._tmp.name
        self._old = os.environ.get("BB_HOME")
        os.environ["BB_HOME"] = self.home
        self.sleepers = []

    def tearDown(self):
        for p in self.sleepers:
            p.kill()
            p.wait()
        if self._old is None:
            os.environ.pop("BB_HOME", None)
        else:
            os.environ["BB_HOME"] = self._old
        self._tmp.cleanup()

    def live_pid(self) -> int:
        p = subprocess.Popen(["sleep", "30"])
        self.sleepers.append(p)
        return p.pid

    def lock(self):
        return Path(self.home) / "login.lock"


class Choosing(unittest.TestCase):
    def test_python_and_the_installer_read_the_same_terminal_table(self):
        self.assertEqual(terminal.ASSET, ROOT / "dist" / "skill" / "assets" / "terminals.json")
        modes = {t["name"]: t["mode"] for t in TERMS}
        self.assertEqual([n for n, m in modes.items() if m == "tab"], ["ptyxis", "gnome-terminal", "konsole", "xfce4-terminal"])
        self.assertEqual(TERMS[-1]["name"], "x-terminal-emulator")
        for t in TERMS:
            self.assertEqual(t["args"].count("{command}"), 1, t["name"])

    def test_tab_terminal_preferred_through_the_distribution_default(self):
        real = lambda p: "/usr/bin/ptyxis" if p.endswith("x-terminal-emulator") else p  # noqa: E731
        t = terminal.find_terminal({}, has("x-terminal-emulator", "ptyxis", "xterm"), real)
        self.assertEqual((t["name"], t["mode"]), ("ptyxis", "tab"))
        self.assertEqual(terminal.find_terminal({}, has("gnome-terminal", "xterm"), real)["name"], "gnome-terminal")

    def test_the_terminal_the_user_is_in_wins_when_it_is_installed(self):
        real = lambda p: "/usr/bin/ptyxis"  # noqa: E731
        both = has("x-terminal-emulator", "ptyxis", "konsole")
        self.assertEqual(terminal.find_terminal({"KONSOLE_VERSION": "250401"}, both, real)["name"], "konsole")
        self.assertEqual(terminal.find_terminal({"KITTY_WINDOW_ID": "1"}, both, real)["name"], "ptyxis")  # kitty absent

    def test_without_a_tab_terminal_a_window_terminal_is_used(self):
        for name in ("kitty", "alacritty", "foot", "xterm"):
            t = terminal.find_terminal({}, has(name), lambda p: p)
            self.assertEqual((t["name"], t["mode"]), (name, "window"))
        # an x-terminal-emulator we do not know is still usable through its -T / -e convention
        t = terminal.find_terminal({}, has("x-terminal-emulator"), lambda p: "/usr/bin/some-terminal")
        self.assertEqual((t["name"], t["mode"]), ("x-terminal-emulator", "window"))

    def test_none_installed_or_disabled(self):
        self.assertIsNone(terminal.find_terminal({}, has(), lambda p: p))
        self.assertIsNone(terminal.find_terminal({"BB_TERMINAL": "none"}, has("ptyxis"), lambda p: p))
        self.assertEqual(terminal.find_terminal({"BB_TERMINAL": "xterm"}, has("ptyxis", "xterm"), lambda p: p)["name"],
                         "xterm")

    def test_no_graphical_terminal_in_ssh_containers_headless_or_other_platforms(self):
        none = lambda p: False  # noqa: E731
        self.assertRegex(terminal.no_gui_reason({"DISPLAY": ":0", "SSH_TTY": "/dev/pts/1"}, none, "linux"), "SSH")
        self.assertRegex(terminal.no_gui_reason({"DISPLAY": ":0"}, lambda p: p == "/.dockerenv", "linux"), "container")
        self.assertRegex(terminal.no_gui_reason({}, none, "linux"), "no graphical session")
        self.assertRegex(terminal.no_gui_reason({"DISPLAY": ":0"}, none, "darwin"), "Linux desktops only")
        self.assertIsNone(terminal.no_gui_reason({"WAYLAND_DISPLAY": "wayland-0"}, none, "linux"))

    def test_argv_keeps_paths_with_spaces_as_single_arguments(self):
        cmd = ["/opt/My Python/bin/python3", "/home/First Last/.bb/skill/scripts/bb.py", "init", "--login", "--pause"]
        self.assertEqual(terminal.argv(BY_NAME["ptyxis"], "Brewboard sign-in", cmd),
                         ["ptyxis", "--tab", "-T", "Brewboard sign-in", "--", *cmd])
        self.assertEqual(terminal.argv(BY_NAME["gnome-terminal"], "T", cmd)[:3], ["gnome-terminal", "--tab", "--title=T"])
        self.assertEqual(terminal.argv(BY_NAME["xterm"], "T", cmd), ["xterm", "-T", "T", "-e", *cmd])
        for t in TERMS:
            a = terminal.argv(t, "T", cmd)
            i = a.index(cmd[0])
            self.assertEqual(a[i:i + len(cmd)], cmd, t["name"])


class Launching(Env, unittest.TestCase):
    def launch(self, *, find=lambda env: BY_NAME["ptyxis"], start=None, wait=1.0, env=None, no_gui=lambda env: None):
        self.calls = []

        def default_start(term, title, command, env_):
            self.calls.append((term["name"], title, command, env_))
            return FakeProc(None)
        return signin.launch(env if env is not None else {"BB_HOME": self.home, "PATH": "/usr/bin"}, find=find,
                             no_gui=no_gui, start=start or default_start, wait=wait, sleep=lambda s: time.sleep(0.01))

    def test_started_when_the_new_terminal_takes_over_the_lock(self):
        def start(term, title, command, env_):
            self.calls.append(command)
            self.lock().write_text(json.dumps({"pid": self.live_pid(), "started": signin._now()}))
            return FakeProc(0)
        out = self.launch(start=start)
        self.assertEqual((out["status"], out["terminal"], out["mode"]), ("started", "ptyxis", "tab"))
        self.assertEqual(self.calls[0][-5:], [sys.executable, config.script_path(), "init", "--login", "--pause"])
        self.assertEqual(self.calls[0][:2], ["env", f"BB_HOME={self.home}"])

    def test_requested_is_not_started_and_a_retry_opens_nothing(self):
        out = self.launch(wait=0.2)
        self.assertEqual(out["status"], "requested")
        self.assertTrue(signin.inspect()["pending"])
        again = self.launch(wait=0.2)
        self.assertEqual(again["status"], "already_running")
        self.assertEqual(self.calls, [], "a retried /bb init --login must not open a second terminal")

    def test_an_open_sign_in_is_never_duplicated(self):
        self.lock().write_text(json.dumps({"pid": self.live_pid(), "started": signin._now()}))
        out = self.launch()
        self.assertEqual(out["status"], "already_running")
        self.assertEqual(self.calls, [])

    def test_a_stale_lock_does_not_block(self):
        self.lock().write_text(json.dumps({"pid": 999999, "started": "2020-01-01T00:00:00.000Z"}))
        self.assertEqual(self.launch(wait=0.1)["status"], "requested")
        self.lock().write_text(json.dumps({"pid": None, "pending": True, "started": "2020-01-01T00:00:00.000Z"}))
        self.assertEqual(self.launch(wait=0.1)["status"], "requested")

    def test_a_terminal_that_fails_is_reported_and_leaves_no_lock(self):
        with self.assertRaises(BBError) as cm:
            self.launch(start=lambda *a: FakeProc(1))
        e = cm.exception.as_dict()
        self.assertEqual(e["error"], "terminal_unavailable")
        self.assertIn("exited with code 1", e["message"])
        self.assertIn("init --login", e["command"])
        self.assertFalse(self.lock().exists())

        def missing(*a):
            raise FileNotFoundError(2, "No such file or directory")
        with self.assertRaises(BBError) as cm:
            self.launch(start=missing)
        self.assertIn("could not be started", cm.exception.message)
        self.assertFalse(self.lock().exists())

    def test_no_terminal_gives_the_manual_command_and_starts_nothing(self):
        with self.assertRaises(BBError) as cm:
            self.launch(find=lambda env: None)
        e = cm.exception.as_dict()
        self.assertEqual(e["error"], "terminal_unavailable")
        self.assertIn("no supported terminal is installed (ptyxis, gnome-terminal", e["reason"])
        self.assertEqual(e["command"], signin.manual_command())
        self.assertEqual(self.calls, [])
        with self.assertRaises(BBError) as cm:
            self.launch(no_gui=lambda env: "this is an SSH session")
        self.assertEqual(cm.exception.extra["reason"], "this is an SSH session")
        self.assertEqual(self.calls, [])
        self.assertFalse(self.lock().exists())

    def test_no_secret_reaches_the_new_terminal(self):
        env = {"BB_HOME": self.home, "PATH": "/usr/bin", "BB_API_SECRET": SECRET, "BB_API_KEY": "k",
               "BB_URL": "https://bb.example.test", "BB_AUTH_SOURCE": "x", "LANG": "C"}
        self.launch(env=env, wait=0.1)
        _, _, command, term_env = self.calls[0]
        self.assertNotIn(SECRET, " ".join(command))
        self.assertFalse({"BB_API_SECRET", "BB_API_KEY", "BB_URL", "BB_AUTH_SOURCE"} & set(term_env))
        self.assertEqual(term_env, {"BB_HOME": self.home, "PATH": "/usr/bin", "LANG": "C"})
        self.assertFalse([a for a in command if "pass" in a.lower() or "secret" in a.lower()])

    def test_manual_command_quotes_paths_with_spaces(self):
        orig = config.script_path
        config.script_path = lambda: "/home/First Last/.bb/skill/scripts/bb.py"
        try:
            self.assertEqual(signin.manual_command(), "python3 '/home/First Last/.bb/skill/scripts/bb.py' init --login")
        finally:
            config.script_path = orig


FAKE_TERMINAL = """#!/bin/sh
# A fake terminal: records its arguments (NUL-separated), then behaves as FAKE_MODE says.
for a in "$@"; do printf '%s\\0' "$a"; done > "$FAKE_LOG"
case "$FAKE_MODE" in
  fail) exit 1 ;;
  start)  # the sign-in in the "new terminal" takes over the lock, as bb.py init --login does
    sleep 30 >/dev/null 2>&1 &
    printf '{"pid": %s, "started": "%s"}' "$!" "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" > "$BB_HOME/login.lock" ;;
esac
exit 0
"""


class Command(unittest.TestCase):
    """bb.py itself, as the agent runs it (pipes, no terminal), with fake terminals on PATH."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="bb launch ")  # a space in every path
        self.home = os.path.join(self._tmp.name, "home dir")
        os.mkdir(self.home)
        self.bin = os.path.join(self._tmp.name, "fake bin")
        os.mkdir(self.bin)
        self.log = os.path.join(self._tmp.name, "terminal.log")
        for name in ("ptyxis", "xterm"):
            p = os.path.join(self.bin, name)
            Path(p).write_text(FAKE_TERMINAL)
            os.chmod(p, 0o755)

    def tearDown(self):
        lock = signin.inspect(Path(self.home) / "login.lock")
        if lock and lock.get("pid"):
            try:
                os.kill(lock["pid"], signal.SIGTERM)
            except OSError:
                pass
        self._tmp.cleanup()

    def bb(self, args, terminal_name="ptyxis", mode="start", **env):
        path = f"{self.bin}:/usr/bin:/bin"
        return run(args, self.home, PATH=path, DISPLAY=":0", BB_TERMINAL=terminal_name, FAKE_LOG=self.log,
                   FAKE_MODE=mode, **env)

    def recorded(self):
        return Path(self.log).read_bytes().decode().split("\0")[:-1] if os.path.exists(self.log) else None

    def test_bb_init_login_opens_a_tab_with_the_installed_sign_in_command(self):
        write_config(self.home)
        r = self.bb([*LAUNCH, "--format", "table"], BB_API_SECRET=SECRET)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("### Brewboard sign-in", r.stdout)
        self.assertIn("Opened in a new ptyxis tab.", r.stdout)
        self.assertIn("run `/bb init` to check the connection", r.stdout)
        self.assertNotIn("signed in as", r.stdout.lower())  # never claims the sign-in itself
        argv = self.recorded()
        self.assertEqual(argv[:4], ["--tab", "-T", "Brewboard sign-in", "--"])
        self.assertEqual(argv[4:], ["env", f"BB_HOME={self.home}", sys.executable, str(BB_PY), "init", "--login",
                                    "--pause"])
        for text in (" ".join(argv), r.stdout, r.stderr):
            self.assertNotIn(SECRET, text)
            self.assertNotIn("s-test-not-real", text)

    def test_window_terminal_and_json(self):
        r = self.bb([*LAUNCH, "--format", "json"], terminal_name="xterm")
        self.assertEqual(r.returncode, 0, r.stderr)
        out = json.loads(r.stdout)
        self.assertEqual((out["status"], out["terminal"], out["mode"]), ("started", "xterm", "window"))
        self.assertEqual(self.recorded()[:4], ["-T", "Brewboard sign-in", "-e", "env"])

    def test_retry_while_open_opens_nothing(self):
        self.assertEqual(self.bb([*LAUNCH, "--format", "json"]).returncode, 0)
        os.remove(self.log)
        r = self.bb([*LAUNCH, "--format", "table"])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("already open in another terminal", r.stdout)
        self.assertIsNone(self.recorded())

    def test_terminal_failure_is_an_error_not_a_sign_in(self):
        r = self.bb([*LAUNCH, "--format", "table"], mode="fail")
        self.assertEqual(r.returncode, 1)
        self.assertEqual(r.stdout, "")
        err = json.loads(r.stderr)
        self.assertEqual(err["error"], "terminal_unavailable")
        self.assertIn("ptyxis exited with code 1", err["message"])
        self.assertFalse((Path(self.home) / "login.lock").exists())

    def test_no_terminal_is_an_actionable_error(self):
        r = self.bb([*LAUNCH, "--format", "table"], terminal_name="none")
        self.assertEqual(r.returncode, 1)
        self.assertEqual(r.stdout, "")
        err = json.loads(r.stderr)
        self.assertEqual(err["error"], "terminal_unavailable")
        self.assertIn("init --login", err["command"])
        self.assertIn(f"'{BB_PY}'" if " " in str(BB_PY) else str(BB_PY), err["command"])
        self.assertEqual(err["next_steps"], [f"Run this in your own terminal: {err['command']}"])

    def test_launch_takes_no_sign_in_values_and_needs_login(self):
        for args in (["init", "--launch"], [*LAUNCH, "--url", "https://x.test"], [*LAUNCH, "--user", "a@b.test"]):
            r = self.bb(args)
            self.assertEqual(r.returncode, 1, args)
            self.assertEqual(json.loads(r.stderr)["error"], "bad_input")
        self.assertIsNone(self.recorded())

    def test_init_login_without_a_terminal_points_to_bb_init_login(self):
        r = self.bb(["init", "--login"])
        self.assertEqual(r.returncode, 1)
        err = json.loads(r.stderr)
        self.assertEqual(err["error"], "bad_input")
        self.assertIn("/bb init --login", err["message"])
        self.assertIsNone(self.recorded())
        self.assertFalse((Path(self.home) / "login.lock").exists())

    def test_bb_init_checks_the_connection_without_opening_a_terminal(self):
        r = self.bb(["auth-check", "--format", "table"])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("### Brewboard connection", r.stdout)
        self.assertIn("Run `/bb init --login` to sign in", r.stdout)
        self.assertIsNone(self.recorded())

    def test_bb_init_logout_is_unchanged_and_opens_nothing(self):
        r = self.bb(["init", "--logout", "--format", "table"])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("Already signed out", r.stdout)
        self.assertIsNone(self.recorded())


# ---------------------------------------------------------------- the sign-in the new terminal runs

KEY = "ck-launch"
USER = {"name": "dev@example.test", "full_name": "Dev Test", "roles": ["BB Project User"]}


class MockBrewboard:
    """ping, the per-client capability probe, login_and_get_keys and get_current_user."""

    def __init__(self):
        mock = self
        self.logins = []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def reply(self, status, body):
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def handle_any(self):
                path = self.path.split("?")[0].replace("/api/method/brewboard_backend.api.", "")
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length).decode() if length else ""
                if path == "health.ping":
                    return self.reply(200, {"message": {"status": "ok", "app": "brewboard_backend"}})
                if path == "auth.list_credentials":
                    return self.reply(401, {"exc_type": "AuthenticationError"})
                if path == "auth.login_and_get_keys":
                    mock.logins.append(body)
                    return self.reply(200, {"message": {"api_key": KEY, "api_secret": SECRET, "auth_source": "cli",
                                                        "credential": "CRED-0001", "expires_on": "2027-01-25"}})
                if self.headers.get("Authorization") != f"token {KEY}:{SECRET}":
                    return self.reply(401, {"exc_type": "AuthenticationError"})
                if path == "auth.get_current_user":
                    return self.reply(200, {"message": USER})
                return self.reply(404, {"exc_type": "DoesNotExistError"})

            do_GET = do_POST = handle_any

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def converse(args, home, script, timeout=25):
    """Run bb.py on a pseudo-terminal and answer prompts: script is [(text to wait for, bytes to type, check)].
    Answers are typed only once their prompt is shown (getpass discards anything typed ahead)."""
    import pty
    import warnings
    with warnings.catch_warnings():  # the mock server's thread: harmless, the child only calls execve
        warnings.simplefilter("ignore", DeprecationWarning)
        pid, fd = pty.fork()
    if pid == 0:
        try:
            os.execve(sys.executable, [sys.executable, "-B", str(BB_PY), *args], clean_env(home, COLUMNS="100"))
        finally:
            os._exit(127)
    out, step, t0 = b"", 0, time.time()
    while time.time() - t0 < timeout:
        if step < len(script) and script[step][0].encode() in out:
            _, typed, check = script[step]
            if check:
                check(pid)
            os.write(fd, typed)
            step += 1
        ready, _, _ = select.select([fd], [], [], 0.1)
        if ready:
            try:
                chunk = os.read(fd, 4096)
            except OSError:
                break
            if not chunk:
                break
            out += chunk
    _, status = os.waitpid(pid, 0)
    os.close(fd)
    code = os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else status >> 8
    return code, out.decode("utf-8", "replace").replace("\r\n", "\n"), step


class TheLaunchedSignIn(unittest.TestCase):
    """What the new terminal runs (`init --login --pause`) is the existing sign-in, on a real terminal."""

    def test_existing_login_saves_a_private_config_holds_the_lock_and_waits_for_enter(self):
        mock = MockBrewboard()
        try:
            with TempHome() as home:
                write_config(home, url=mock.url)
                held = []

                def lock_is_mine(pid):
                    held.append(signin.inspect(Path(home) / "login.lock"))
                    self.assertEqual(held[-1]["pid"], pid)

                code, shown, steps = converse(["init", "--login", "--pause"], home, [
                    ("Brewboard URL", b"\n", None),
                    ("login (email)", USER["name"].encode() + b"\n", None),
                    ("Password:", PASSWORD.encode() + b"\n", lock_is_mine),
                    ("Press Enter to close", b"\n", None),
                ])
                self.assertEqual(steps, 4, shown)
                self.assertEqual(code, 0, shown)
                self.assertTrue(held and held[0]["active"])
                self.assertIn("Signed in", shown)
                self.assertIn("run /bb init", shown)
                self.assertNotIn(PASSWORD, shown, "the password is never echoed")
                cfg_path = Path(home) / "config.json"
                cfg = json.loads(cfg_path.read_text())
                self.assertEqual((cfg["api_key"], cfg["credential"]), (KEY, "CRED-0001"))
                self.assertNotIn(PASSWORD, cfg_path.read_text())
                self.assertEqual(stat.S_IMODE(cfg_path.stat().st_mode), 0o600)
                self.assertEqual(len(mock.logins), 1)
                self.assertFalse((Path(home) / "login.lock").exists(), "the lock is released after sign-in")
        finally:
            mock.close()

    def test_a_second_sign_in_is_refused_while_one_is_running(self):
        with TempHome() as home:
            sleeper = subprocess.Popen(["sleep", "30"])
            try:
                (Path(home) / "login.lock").write_text(json.dumps({"pid": sleeper.pid, "started": signin._now()}))
                code, shown, _ = converse(["init", "--login", "--pause"], home, [("Press Enter to close", b"\n", None)])
                self.assertEqual(code, 1)
                self.assertIn("Another Brewboard sign-in is already running", shown)
                self.assertTrue((Path(home) / "login.lock").exists(), "someone else's lock is left alone")
            finally:
                sleeper.kill()
                sleeper.wait()


class Routing(unittest.TestCase):
    """Every agent's instructions send /bb init --login to the launcher, never to an interactive command."""

    def read(self, rel):
        return (ROOT / "dist" / rel).read_text(encoding="utf-8")

    def test_skill_and_all_adapters_route_login_to_the_launcher(self):
        skill = self.read("skill/SKILL.md")
        init = skill[skill.index("### init"):skill.index("### list_projects")]
        self.assertIn("Run only `bb.py init --login --launch --format table`", init)
        self.assertIn("`/bb init [--login | --logout]`", skill)
        self.assertIn("Run only `bb.py init --logout --format table`", init)
        self.assertIn("1. Run `bb.py auth-check --format table`", init)
        for rel in ("adapters/claude-code/bb-init.md", "adapters/opencode/bb-init.md", "adapters/agent-skill/bb.md"):
            self.assertIn("`bb.py init --login --launch --format table`", self.read(rel), rel)
        self.assertIn('argument-hint: "[--login | --logout]"', self.read("adapters/claude-code/bb-init.md"))
        self.assertIn("init [--login | --logout]", self.read("adapters/claude-code/bb.md"))
        self.assertIn("`$bb` in Codex", self.read("adapters/agent-skill/bb.md"))

    def test_nothing_tells_the_agent_to_run_the_interactive_sign_in_itself(self):
        for path in [ROOT / "dist" / "skill" / "SKILL.md", *sorted((ROOT / "dist" / "adapters").rglob("*.md"))]:
            text = path.read_text(encoding="utf-8")
            self.assertNotIn("! python3", text, path)
            self.assertNotIn("type `!", text, path)

    def test_the_launcher_ships_with_the_skill(self):
        manifest = {f["path"] for f in json.loads(self.read("manifest.json"))["files"]}
        for rel in ("skill/assets/terminals.json", "skill/scripts/bbclient/terminal.py",
                    "skill/scripts/bbclient/signin.py", "skill/scripts/bb.py"):
            self.assertIn(rel, manifest)


if __name__ == "__main__":
    unittest.main()

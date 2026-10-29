"""/bb init --logout: SKILL.md has the agent run `bb.py init --logout --format table` and print it verbatim.

It must go through the same sign_out() as `bb.py logout`: revoke this CLI's own credential on the server when it is
one, remove the credential keys from config.json, keep the URL and the working context, never sign in, never
report success that did not happen, and be fine to run when already signed out.
"""
import json
import os
import re
import stat
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from support import ROOT, TempHome, run, write_state
from test_init_view import blank_header, table_rows

PREFIX = "/api/method/brewboard_backend.api."
KEY, SECRET = "ck-test", "s-test-not-real-0123456789"
USER = {"name": "kartik@example.test", "full_name": "Kartik Test", "roles": ["BB Project User"]}
STATE = {"user": USER["name"], "project": {"identifier": "BrewT", "title": "Brew Test"},
         "task": {"name": "TASK-2026-00811", "title": "Fix login"}, "tickets": [{"name": "ISS-2026-00191", "title": "Crash"}]}


class MockBrewboard:
    """health.ping, auth.get_current_user and auth.revoke_credential, with per-client token auth."""

    def __init__(self):
        mock = self
        self.requests, self.valid = [], True

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

            def authed(self):
                return mock.valid and self.headers.get("Authorization") == f"token {KEY}:{SECRET}"

            def handle_any(self):
                path = self.path.split("?")[0]
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length).decode() if length else ""
                mock.requests.append((self.command, path.replace(PREFIX, ""), body))
                if path == PREFIX + "health.ping":
                    return self.reply(200, {"message": {"status": "ok", "app": "brewboard_backend"}})
                if not self.authed():
                    return self.reply(401, {"exc_type": "AuthenticationError"})
                if path == PREFIX + "auth.get_current_user":
                    return self.reply(200, {"message": USER})
                if path == PREFIX + "auth.revoke_credential":
                    mock.valid = False  # revoked: the credential no longer works
                    return self.reply(200, {"message": {"revoked": ["cred1"]}})
                return self.reply(404, {"exc_type": "DoesNotExistError"})

            do_GET = do_POST = handle_any

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def endpoints(self):
        return [r[1] for r in self.requests]

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def save_config(home, url, per_client=True):
    data = {"url": url, "api_key": KEY, "api_secret": SECRET, "user": USER["name"], "obtained_via": "login",
            "saved_at": "2026-10-14T10:00:00"}
    if per_client:
        data.update(auth_source="Brewboard API Credential", credential="cred1", expires_on="2027-01-12 00:00:00")
    p = Path(home) / "config.json"
    p.write_text(json.dumps(data))
    os.chmod(p, 0o600)
    return p


def load(home, name):
    return json.loads((Path(home) / name).read_text())


class InitLogout(unittest.TestCase):
    def setUp(self):
        self.mock = MockBrewboard()

    def tearDown(self):
        self.mock.close()

    def test_removes_credentials_keeps_url_and_context_and_revokes_this_cli_credential(self):
        with TempHome() as home:
            save_config(home, self.mock.url)
            write_state(home, STATE)
            r = run(["init", "--logout", "--format", "table"], home)
            self.assertEqual(r.returncode, 0, r.stderr)
            cfg = load(home, "config.json")
            self.assertEqual(cfg, {"url": self.mock.url}, "credential keys gone, the server address kept")
            self.assertEqual(stat.S_IMODE(os.stat(Path(home) / "config.json").st_mode), 0o600)
            state = load(home, "state.json")
            for k in ("project", "task", "tickets"):
                self.assertEqual(state[k], STATE[k], f"{k} kept")
            self.assertEqual(self.mock.endpoints(), ["auth.revoke_credential"], "revokes, nothing else, never signs in")
            out = r.stdout
            self.assertTrue(out.startswith("### Brewboard\n\n✓ Signed out successfully.\n"))
            self.assertIn("Saved authentication credentials removed from this computer.", out)
            self.assertIn("The Brewboard server revoked this CLI's credential (cred1).", out)
            self.assertTrue(out.rstrip().endswith("Run `/bb init` to sign in again."))
            for secret in (KEY, SECRET):
                self.assertNotIn(secret, out + r.stderr)
            self.assertNotIn("\x1b", out)
            self.assertTrue(Path(home).is_dir() and Path(home, "state.json").is_file(), "~/.bb itself is never removed")

    def test_account_key_pair_is_described_as_local_sign_out_only(self):
        with TempHome() as home:
            save_config(home, self.mock.url, per_client=False)
            r = run(["init", "--logout", "--format", "table"], home)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertEqual(self.mock.endpoints(), [], "nothing is sent for an account key pair")
            self.assertIn("only removed locally", r.stdout)
            self.assertNotIn("revoked", r.stdout.lower().replace("removed locally", ""))

    def test_repeated_logout_is_safe_and_says_already_signed_out(self):
        with TempHome() as home:
            save_config(home, self.mock.url)
            write_state(home, STATE)
            self.assertEqual(run(["init", "--logout", "--format", "table"], home).returncode, 0)
            before = (Path(home) / "config.json").read_text()
            r = run(["init", "--logout", "--format", "table"], home)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn("Already signed out", r.stdout)
            self.assertNotIn("Signed out successfully", r.stdout)
            self.assertEqual((Path(home) / "config.json").read_text(), before)
            self.assertEqual(self.mock.endpoints(), ["auth.revoke_credential"], "the second run sends nothing")
            data = json.loads(run(["init", "--logout", "--format", "json"], home).stdout)
            self.assertEqual((data["signed_out"], data["already_signed_out"]), (True, True))
        with TempHome() as home:  # never signed in at all: no config.json
            r = run(["init", "--logout", "--format", "table"], home)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn("Already signed out", r.stdout)

    def test_a_file_that_cannot_be_written_is_reported_and_not_called_a_sign_out(self):
        if os.geteuid() == 0:
            self.skipTest("root can write anywhere")
        with TempHome() as home:
            save_config(home, self.mock.url, per_client=False)
            os.chmod(home, 0o500)  # config.json can no longer be replaced
            try:
                r = run(["init", "--logout", "--format", "table"], home)
            finally:
                os.chmod(home, 0o700)
            self.assertEqual(r.returncode, 1)
            self.assertEqual(r.stdout, "", "no success text")
            err = json.loads(r.stderr)
            self.assertEqual(err["error"], "file_error")
            self.assertIn("were not removed", err["message"])
            self.assertEqual(load(home, "config.json")["api_key"], KEY, "credentials still there, as reported")
            self.assertNotIn(SECRET, r.stderr)

    def test_server_failure_is_reported_and_nothing_is_removed(self):
        with TempHome() as home:
            save_config(home, "http://127.0.0.1:9")  # nothing listens: revocation cannot happen
            r = run(["init", "--logout", "--format", "table"], home)
            self.assertEqual(r.returncode, 1)
            self.assertEqual(r.stdout, "")
            self.assertEqual(json.loads(r.stderr)["error"], "unreachable")
            self.assertEqual(load(home, "config.json")["api_secret"], SECRET, "kept, so the user can retry")

    def test_logout_is_not_mixed_with_sign_in_options(self):
        with TempHome() as home:
            for extra in (["--login"], ["--url", "http://x"], ["--key", "k"], ["--user", "u"]):
                with self.subTest(extra):
                    r = run(["init", "--logout", *extra], home)
                    self.assertEqual(r.returncode, 1)
                    self.assertEqual(json.loads(r.stderr)["error"], "bad_input")
            self.assertEqual(self.mock.endpoints(), [])
            r = run(["init", "--format", "table"], home)
            self.assertEqual(json.loads(r.stderr)["error"], "bad_input", "table output is only for --logout")

    def test_after_logout_bb_init_reports_signed_out_and_keeps_the_blank_header_fix(self):
        with TempHome() as home:
            save_config(home, self.mock.url)
            write_state(home, STATE)
            ok = run(["auth-check", "--format", "table"], home).stdout
            self.assertFalse(blank_header(ok))
            self.assertEqual(table_rows(ok)[0], ["Name", "Kartik Test"])
            run(["init", "--logout", "--format", "table"], home)
            after = run(["auth-check", "--format", "table"], home)
            self.assertEqual(after.returncode, 0)
            self.assertIn("Not signed in · status `not_configured`", after.stdout)
            self.assertFalse(blank_header(after.stdout))


class ExistingLogout(unittest.TestCase):
    """`bb.py logout` keeps its contract: JSON, revocation for a CLI credential, not_configured when signed out."""

    def setUp(self):
        self.mock = MockBrewboard()

    def tearDown(self):
        self.mock.close()

    def test_unchanged_contract(self):
        with TempHome() as home:
            save_config(home, self.mock.url)
            write_state(home, STATE)
            r = run(["logout"], home)
            self.assertEqual(r.returncode, 0, r.stderr)
            data = json.loads(r.stdout)
            self.assertEqual(set(data), {"credential", "revoked", "config_file"})
            self.assertEqual((data["credential"], data["revoked"]), ("cred1", ["cred1"]))
            self.assertEqual(load(home, "config.json"), {"url": self.mock.url})
            self.assertEqual(load(home, "state.json")["project"], STATE["project"])
            r = run(["logout"], home)
            self.assertEqual(r.returncode, 1)
            self.assertEqual(json.loads(r.stderr)["error"], "not_configured")


class Routing(unittest.TestCase):
    def test_skill_and_adapters_route_init_logout_to_bb_py(self):
        skill = (ROOT / "dist" / "skill" / "SKILL.md").read_text(encoding="utf-8")
        init = skill.split("### init", 1)[1].split("\n### ", 1)[0]
        self.assertIn("`bb.py init --logout --format table`", init)
        self.assertIn("print its output verbatim", init)
        self.assertIn("never sign in again", init)
        self.assertIn("`/bb init [--login | --logout]`", skill)
        for agent in ("claude-code", "opencode"):
            with self.subTest(agent):
                command = (ROOT / "dist" / "adapters" / agent / "bb.md").read_text(encoding="utf-8")
                self.assertIn("$ARGUMENTS", command, "/bb init --logout passes the flag on")
                self.assertIn("bb.py init --logout --format table", command)
        self.assertIn("init [--login | --logout]", (ROOT / "dist" / "adapters" / "claude-code" / "bb.md").read_text())

    def test_parser_has_init_logout_with_table_output(self):
        from support import BB_PY  # noqa: F401
        import importlib.util
        spec = importlib.util.spec_from_file_location("bb_cli", str(ROOT / "dist" / "skill" / "scripts" / "bb.py"))
        bb = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(bb)
        a = bb.build_parser().parse_args(["init", "--logout", "--format", "table"])
        self.assertTrue(a.logout)
        self.assertEqual((a.fn.__name__, a.format), ("cmd_init", "table"))
        self.assertFalse(re.search(r"--logout", " ".join(
            o for act in bb.build_parser()._subparsers._group_actions[0].choices["auth-check"]._actions
            for o in act.option_strings)), "not an option of other commands")


if __name__ == "__main__":
    unittest.main()

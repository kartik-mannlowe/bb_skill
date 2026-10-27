"""bb.py end to end: what agents get through pipes (unchanged JSON contracts) and what people see on a terminal."""
import json
import os
import unittest

from support import TempHome, run, run_tty, strip_ansi, write_config, write_state

HAS_PTY = os.name == "posix"


class AgentOutput(unittest.TestCase):
    """Captured output: JSON stays JSON, errors stay JSON on stderr, no colour or banner leaks in."""

    def test_errors_are_json_on_stderr_with_exit_1(self):
        with TempHome() as home:
            r = run(["tasks", "--format", "table"], home)
            self.assertEqual(r.returncode, 1)
            self.assertEqual(r.stdout, "")
            err = json.loads(r.stderr)
            self.assertEqual(err["error"], "not_configured")
            self.assertNotIn("\x1b", r.stderr)

    def test_auth_check_keeps_its_json_contract_for_the_installer(self):
        with TempHome() as home:
            r = run(["auth-check"], home)
            self.assertEqual(r.returncode, 0)
            data = json.loads(r.stdout)
            self.assertEqual(data["status"], "not_configured")
            self.assertIn("config_file", data["credentials"])

    def test_text_can_be_asked_for_and_is_plain_when_captured(self):
        with TempHome() as home:
            r = run(["auth-check", "--format", "text"], home)
            self.assertIn("Not signed in", r.stdout)
            self.assertNotIn("\x1b", r.stdout)

    def test_home_is_local_json_by_default(self):
        with TempHome() as home:
            write_config(home)  # points at a closed port: any network use would fail
            write_state(home, {"user": "dev@bb.local", "full_name": "Aarav Mehta",
                               "project": {"identifier": "CP", "title": "Customer Portal Revamp"}})
            r = run(["home"], home)
            self.assertEqual(r.returncode, 0, r.stderr)
            data = json.loads(r.stdout)
            self.assertEqual((data["signed_in"], data["user"], data["full_name"]), (True, "dev@bb.local", "Aarav Mehta"))
            self.assertEqual(data["context"]["project"]["identifier"], "CP")
            self.assertIsNone(data["version"], "a checkout is not an installed copy")
            self.assertNotIn("s-test-not-real", r.stdout)

    def test_home_table_is_the_banner_plus_saved_state(self):
        with TempHome() as home:
            r = run(["home", "--format", "table"], home, COLUMNS="80")
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertTrue(r.stdout.startswith("```text\n"))
            self.assertEqual(r.stdout.count("Your workspace. Your workflow."), 1)
            self.assertIn("**Account** not signed in", r.stdout)
            self.assertNotIn("\x1b", r.stdout)
            write_config(home)
            r = run(["home", "--format", "table"], home)
            self.assertIn("**Account** dev@bb.local · http://127.0.0.1:9 · saved sign-in", r.stdout)

    def test_ctx_table_is_unchanged_in_shape(self):
        with TempHome() as home:
            r = run(["ctx", "show", "--format", "table"], home)
            self.assertTrue(r.stdout.startswith("### Brewboard status\n\n| User | none |\n|---|---|\n"))

    def test_write_commands_accept_table_output_and_keep_json_as_default(self):
        with TempHome() as home:
            for cmd in ("log-time", "create-task", "create-mom", "update", "delete"):
                with self.subTest(cmd):
                    h = run([cmd, "--help"], home).stdout
                    self.assertIn("--format {json,table}", h)

    def test_help_is_conventional(self):
        with TempHome() as home:
            r = run(["--help"], home)
            self.assertEqual(r.returncode, 0)
            self.assertTrue(r.stdout.startswith("usage: bb.py"))
            self.assertNotIn("Your workspace", r.stdout)
            self.assertIn("home", r.stdout)

    def test_unsupported_operation_is_refused_before_sending_anything(self):
        with TempHome() as home:
            r = run(["submit", "timesheet", "TS-1"], home)
            self.assertEqual(r.returncode, 1)
            self.assertEqual(json.loads(r.stderr)["error"], "api_unsupported")

    def test_noninteractive_init_without_arguments_is_a_clean_error(self):
        with TempHome() as home:
            r = run(["init"], home, stdin_text="")
            self.assertEqual(r.returncode, 1)
            self.assertEqual(json.loads(r.stderr)["error"], "bad_input")
            self.assertNotIn("Your workspace", r.stdout, "no banner without a person at a terminal")


@unittest.skipUnless(HAS_PTY, "needs a POSIX pseudo-terminal")
class PersonAtATerminal(unittest.TestCase):
    def test_sign_in_command_errors_are_readable_and_coloured(self):
        with TempHome() as home:
            code, out = run_tty(["whoami"], home)
            self.assertEqual(code, 1)
            self.assertIn("\x1b[31m", out)
            text = strip_ansi(out)
            self.assertIn("✗ Not signed in: Brewboard connection is not set up.", text)
            self.assertIn("code: not_configured", text)
            self.assertNotIn('"error"', text, "no JSON for people")

    def test_agent_commands_keep_json_even_on_a_pseudo_terminal(self):
        """Some agent harnesses run commands in a pseudo-terminal: list commands and explicit --format json
        must still give the JSON SKILL.md parses."""
        with TempHome() as home:
            for args in (["tasks", "--format", "table"], ["tasks"], ["whoami", "--format", "json"]):
                with self.subTest(args=args):
                    code, out = run_tty(args, home)
                    self.assertEqual(code, 1)
                    self.assertEqual(json.loads(out)["error"], "not_configured")
            _, out = run_tty(["auth-check", "--format", "json"], home)
            self.assertEqual(json.loads(out)["status"], "not_configured")

    def test_no_color_and_ascii_fallbacks(self):
        with TempHome() as home:
            _, out = run_tty(["whoami"], home, NO_COLOR="1", BB_ASCII="1")
            self.assertNotIn("\x1b[", out)
            self.assertIn("XX Not signed in", out)
            _, out = run_tty(["whoami"], home, TERM="dumb")
            self.assertNotIn("\x1b[", out)

    def test_text_mode_with_piped_stdout_gets_no_banner(self):
        import pty
        import subprocess
        import sys
        from support import BB_PY, clean_env
        with TempHome() as home:
            master, slave = pty.openpty()
            try:
                os.write(master, b"http://127.0.0.1:9\n")
                r = subprocess.run([sys.executable, "-B", str(BB_PY), "init", "--format", "text"], stdin=slave,
                                   capture_output=True, text=True, env=clean_env(home), timeout=30)
            finally:
                os.close(master)
                os.close(slave)
            self.assertEqual(r.returncode, 1)
            self.assertNotIn("Your workspace", r.stdout, "stdout is a pipe: no banner in it")

    def test_interactive_init_shows_the_banner_once_then_the_problem(self):
        with TempHome() as home:
            code, out = run_tty(["init"], home, typed=b"http://127.0.0.1:9\r", cols=100, NO_COLOR="1")
            self.assertEqual(code, 1)
            self.assertEqual(out.count("Your workspace. Your workflow."), 1)
            self.assertIn("| _ )| _ \\| __|", out, "full wordmark at 100 columns")
            self.assertIn("Sign in to Brewboard", out)
            self.assertIn("Connection failed", out)
            self.assertNotIn("\x1b[2J", out)

    def test_narrow_terminal_gets_the_compact_wordmark(self):
        with TempHome() as home:
            _, out = run_tty(["init"], home, typed=b"http://127.0.0.1:9\r", cols=45, NO_COLOR="1")
            self.assertIn("|_) |_) |_", out)
            self.assertNotIn("| _ )| _ \\", out)
            banner = out.split("Brewboard URL")[0]
            self.assertTrue(all(len(line) <= 45 for line in banner.splitlines()), banner)

    def test_auth_check_reads_as_text_on_a_terminal(self):
        with TempHome() as home:
            _, out = run_tty(["auth-check"], home, NO_COLOR="1")
            self.assertIn("! Not signed in: no Brewboard sign-in is saved.", out)
            self.assertNotIn("{", out)
            _, out = run_tty(["auth-check", "--format", "json"], home, NO_COLOR="1")
            self.assertEqual(json.loads(out)["status"], "not_configured")

    def test_help_has_no_banner_or_colour(self):
        with TempHome() as home:
            _, out = run_tty(["--help"], home)
            self.assertNotIn("\x1b[", out)
            self.assertNotIn("Your workspace", out)


if __name__ == "__main__":
    unittest.main()

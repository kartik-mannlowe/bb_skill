"""Terminal presentation for people: capability detection, banner art and layout, errors, account summaries."""
import io
import json
import os
import tempfile
import unittest
from pathlib import Path

from support import BB_PY, strip_ansi

from bbclient import ui

UTF8 = {"LANG": "en_US.UTF-8", "TERM": "xterm-256color"}


class FakeTTY(io.StringIO):
    def __init__(self, tty=True):
        super().__init__()
        self._tty = tty

    def isatty(self):
        return self._tty


class Capabilities(unittest.TestCase):
    def test_colour_only_on_a_tty_and_never_with_no_color_or_dumb_terminals(self):
        self.assertTrue(ui.color_enabled(FakeTTY(), UTF8))
        self.assertFalse(ui.color_enabled(FakeTTY(tty=False), UTF8))
        self.assertFalse(ui.color_enabled(FakeTTY(), {**UTF8, "NO_COLOR": "1"}))
        self.assertTrue(ui.color_enabled(FakeTTY(), {**UTF8, "NO_COLOR": ""}), "an empty NO_COLOR does not count")
        self.assertFalse(ui.color_enabled(FakeTTY(), {**UTF8, "TERM": "dumb"}))

    def test_unicode_symbols_only_in_utf8_locales(self):
        self.assertTrue(ui.unicode_enabled(UTF8))
        self.assertTrue(ui.unicode_enabled({"LC_ALL": "C.utf8"}))
        self.assertFalse(ui.unicode_enabled({"LANG": "C"}))
        self.assertFalse(ui.unicode_enabled({**UTF8, "BB_ASCII": "1"}))
        self.assertFalse(ui.unicode_enabled({**UTF8, "TERM": "dumb"}))

    def test_status_lines_stay_readable_without_colour_or_unicode(self):
        plain = ui.Style(FakeTTY(tty=False), {"LANG": "C"})
        self.assertEqual(plain.status("error", "Failed"), "XX Failed")
        self.assertEqual(plain.status("ok", "Done"), "ok Done")
        self.assertEqual(plain.status("warn", "Careful"), "!! Careful")
        rich = ui.Style(FakeTTY(), UTF8)
        self.assertEqual(rich.status("ok", "Done"), "\x1b[32m✓\x1b[0m Done")
        self.assertEqual(strip_ansi(rich.status("error", "Failed")), "✗ Failed")

    def test_terminal_width_honours_columns(self):
        self.assertEqual(ui.terminal_width({"COLUMNS": "42"}), 42)
        self.assertGreater(ui.terminal_width({"COLUMNS": "junk"}), 0)

    def test_fields_leave_out_empty_values_and_align(self):
        lines = ui.Style(FakeTTY(tty=False), {}).fields([("Site", "https://s"), ("Roles", None), ("Credential", "cli")])
        self.assertEqual(lines, ["  Site        https://s", "  Credential  cli"])


class Banner(unittest.TestCase):
    def test_art_file_is_plain_ascii_without_trailing_spaces(self):
        art = ui.load_art()
        self.assertEqual(list(art), ["small", "mini", "tagline"])
        self.assertEqual(art["tagline"], "Your workspace. Your workflow.")
        for name in ("small", "mini"):
            for line in art[name]:
                self.assertTrue(all(ord(c) < 128 for c in line), line)
                self.assertEqual(line, line.rstrip())
        self.assertEqual((len(art["small"]), max(map(len, art["small"]))), (4, 55))
        self.assertEqual((len(art["mini"]), max(map(len, art["mini"]))), (3, 36))

    def test_widest_wordmark_that_fits(self):
        self.assertEqual(len(ui.logo(80)), 4)
        self.assertEqual(len(ui.logo(55)), 4)
        self.assertEqual(len(ui.logo(54)), 3)
        self.assertEqual(ui.logo(20), [ui.WORDMARK])
        self.assertEqual(ui.logo(12), ["BREWBOARD"])

    def test_no_line_is_wider_than_the_terminal(self):
        for width in (120, 80, 60, 57, 50, 40, 36, 30, 29, 24, 20, 16):
            with self.subTest(width=width):
                lines = ui.banner_lines(width, "0.2.0", ["status"])
                self.assertTrue(all(len(line) <= width for line in lines), lines)
                self.assertIn("v0.2.0", "\n".join(lines))

    def test_version_sits_at_the_right_edge_when_it_fits(self):
        lines = ui.banner_lines(80, "0.2.0")
        self.assertEqual(len(lines[-1]), 55)
        self.assertTrue(lines[-1].endswith("v0.2.0") and lines[-1].startswith("Your workspace."))
        self.assertEqual(ui.banner_lines(40, "0.2.0")[-1], "v0.2.0", "on its own line under the compact mark")

    def test_missing_art_falls_back_to_the_wordmark(self):
        self.assertEqual(ui.load_art(Path("/nonexistent/banner.txt")), {})
        self.assertEqual(ui.banner_lines(80, None, art={})[:2], [ui.WORDMARK, ui.TAGLINE])

    def test_printed_once_per_process(self):
        ui._banner_shown = False
        out = FakeTTY()
        self.assertTrue(ui.print_banner(out, "0.2.0", env={**UTF8, "COLUMNS": "80"}))
        self.assertFalse(ui.print_banner(out, "0.2.0", env={**UTF8, "COLUMNS": "80"}))
        self.assertEqual(out.getvalue().count("Your workspace. Your workflow."), 1)
        self.assertIn("\x1b[1;36m", out.getvalue(), "coloured on a TTY")
        self.assertNotIn("\x1b[2J", out.getvalue(), "never clears the screen")
        ui._banner_shown = False
        out = FakeTTY()
        ui.print_banner(out, None, env={**UTF8, "NO_COLOR": "1", "COLUMNS": "80"})
        self.assertNotIn("\x1b", out.getvalue())

    def test_installed_version_only_for_the_installed_copy(self):
        with tempfile.TemporaryDirectory() as home:
            old = os.environ.get("BB_HOME")
            os.environ["BB_HOME"] = home
            try:
                self.assertIsNone(ui.installed_version(), "this checkout is not the installed copy")
                scripts = Path(home, "skill", "scripts")
                scripts.mkdir(parents=True)
                (scripts / "bb.py").symlink_to(BB_PY)
                Path(home, "installed.json").write_text(json.dumps({"version": "9.9.9"}))
                self.assertEqual(ui.installed_version(), "9.9.9")
                Path(home, "installed.json").write_text("not json")
                self.assertIsNone(ui.installed_version())
            finally:
                if old is None:
                    os.environ.pop("BB_HOME")
                else:
                    os.environ["BB_HOME"] = old


class Errors(unittest.TestCase):
    def plain(self):
        return ui.Style(FakeTTY(tty=False), {"LANG": "C"})

    def test_problem_context_and_next_step(self):
        text = ui.error_text({"error": "bad_input", "message": "Unknown status 'Doing'", "valid": ["Open", "Working"]},
                             self.plain())
        lines = text.splitlines()
        self.assertEqual(lines[0], "XX Invalid input: Unknown status 'Doing'")
        self.assertIn("  Valid  Open, Working", lines)
        self.assertEqual(lines[-1], "  code: bad_input")

    def test_known_codes_get_a_corrective_step(self):
        text = ui.error_text({"error": "unreachable", "message": "Cannot reach http://x"}, self.plain())
        self.assertIn("> Check the URL, your VPN", text)
        self.assertIn("Connection failed", text)

    def test_fix_it_command_is_shell_safe(self):
        real = ui.config.script_path
        ui.config.script_path = lambda: "/home/First Last/.bb/skill/scripts/bb.py"
        try:
            self.assertEqual(ui.hint("not_configured"), "Sign in: python3 '/home/First Last/.bb/skill/scripts/bb.py' init --login")
        finally:
            ui.config.script_path = real

    def test_server_next_steps_win_and_init_hints_are_not_repeated(self):
        text = ui.error_text({"error": "credentials_rejected", "message": "Revoked.", "next_steps": ["Run init --login"]},
                             self.plain())
        self.assertIn("> Run init --login", text)
        self.assertNotIn("Sign in again", text)
        text = ui.error_text({"error": "not_configured", "message": "Not set up. Run in a terminal: python3 x init"},
                             self.plain())
        self.assertNotIn("> Sign in", text)

    def test_colour_is_optional_information(self):
        rich = ui.error_text({"error": "forbidden", "message": "No"}, ui.Style(FakeTTY(), UTF8))
        self.assertIn("\x1b[31m", rich)
        self.assertEqual(strip_ansi(rich).splitlines()[0], "✗ Not allowed: No")


class AccountSummaries(unittest.TestCase):
    style = ui.Style(FakeTTY(tty=False), {"LANG": "C"})

    def test_auth_check_states(self):
        ok = ui.account_text("auth-check", {"status": "ok", "user": "dev@bb.local", "url": "https://s",
                                            "roles": ["BB Project User", "Employee"],
                                            "credentials": {"auth_source": "Brewboard API Credential",
                                                            "credential": "cred1", "expires_on": "2027-01-10",
                                                            "key_fp": "abc", "secret_fp": "def"}}, self.style)
        self.assertIn("ok Brewboard accepts the saved sign-in for dev@bb.local.", ok)
        self.assertIn("Roles       BB Project User", ok)
        self.assertIn("this CLI only (cred1)", ok)
        self.assertNotIn("Employee", ok)
        missing = ui.account_text("auth-check", {"status": "not_configured", "credentials": {}}, self.style)
        self.assertIn("!! Not signed in", missing)
        self.assertIn("init --login", missing)
        rejected = ui.account_text("auth-check", {"status": "credentials_rejected", "message": "Revoked.",
                                                  "next_steps": ["Ask before signing in again."], "credentials": {}},
                                   self.style)
        self.assertIn("XX Saved sign-in no longer accepted: Revoked.", rejected)
        self.assertIn("> Ask before signing in again.", rejected)

    def test_init_summary_never_shows_credentials(self):
        text = ui.account_text("init", {"ok": True, "config_file": "/h/.bb/config.json", "user": "dev@bb.local",
                                        "full_name": "Aarav Mehta", "roles": [], "site": "https://s",
                                        "context": {"project": None}, "notes": ["Signed in with a credential."],
                                        "api_secret": "s-test-not-real"}, self.style)
        self.assertIn("ok Signed in to https://s as Aarav Mehta (dev@bb.local).", text)
        self.assertIn("/h/.bb/config.json (private)", text)
        self.assertIn("!! This account has no Brewboard role", text)
        self.assertIn("> Open your coding agent and type /bb.", text)
        self.assertNotIn("s-test-not-real", text)


if __name__ == "__main__":
    unittest.main()

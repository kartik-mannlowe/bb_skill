"""/bb init: SKILL.md has the agent run `bb.py auth-check --format table` and print it verbatim.

Regression: the agent used to compose its own two-column table from auth-check's JSON, with an empty header row
(rendered by Claude Code as a blank first box). bb.py now renders the summary itself; like /bb status, the first
data row doubles as the table header, so a key/value summary never has an empty header row.
"""
import json
import re
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from support import ROOT, TempHome, run, write_config, write_state

from bbclient import render

PREFIX = "/api/method/brewboard_backend.api."
TOKEN = "token k-test:s-test-not-real"  # the dummy pair support.write_config saves
USER = {"name": "kartik@example.test", "full_name": "Kartik Test", "email": "kartik@example.test",
        "roles": ["BB Project User", "Employee"]}


class MockBrewboard:
    """The two endpoints auth-check calls: health.ping (no auth) and auth.get_current_user (token auth)."""

    def __init__(self, user=USER, accept=True):
        mock = self

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

            def do_GET(self):
                path = self.path.split("?")[0]
                if path == PREFIX + "health.ping":
                    return self.reply(200, {"message": {"status": "ok", "app": "brewboard_backend"}})
                if path == PREFIX + "auth.get_current_user":
                    if mock.accept and self.headers.get("Authorization") == TOKEN:
                        return self.reply(200, {"message": mock.user})
                    return self.reply(401, {"exc_type": "AuthenticationError"})
                return self.reply(404, {"exc_type": "DoesNotExistError"})

        self.user, self.accept = user, accept
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def table_rows(markdown: str) -> list:
    """Each Markdown table row as its list of (stripped) cells; separator rows (|---|) left out."""
    rows = []
    for line in markdown.splitlines():
        if line.startswith("|") and not re.fullmatch(r"\|(\s*:?-{3,}:?\s*\|)+", line):
            rows.append([c.strip() for c in line.strip().strip("|").split("|")])
    return rows


def blank_header(markdown: str) -> bool:
    """True when a table's header row (the line before a |---| separator) has no text in any cell."""
    lines = markdown.splitlines()
    return any(re.fullmatch(r"\|(\s*:?-{3,}:?\s*\|)+", lines[i]) and re.fullmatch(r"\|(\s*\|)+", lines[i - 1].strip())
               for i in range(1, len(lines)))


class InitView(unittest.TestCase):
    def setUp(self):
        self.mock = MockBrewboard()

    def tearDown(self):
        self.mock.close()

    def test_detector_catches_the_reported_shape(self):
        reported = "| | |\n|---|---|\n| Name | Kartik Deshpande |\n| User ID | kartik@example.test |\n"
        self.assertTrue(blank_header(reported), "the table the agent composed before the fix")

    def test_bb_init_summary_has_no_blank_header_row(self):
        """The exact command and formatter /bb init uses (SKILL.md init step 1), end to end."""
        with TempHome() as home:
            write_config(home, url=self.mock.url, user=USER["name"])
            write_state(home, {"user": USER["name"], "project": {"identifier": "BrewT", "title": "Brew Test"},
                               "task": {"name": "TASK-2026-00811", "title": "Fix login"},
                               "tickets": [{"name": "ISS-2026-00191", "title": "Crash"}]})
            r = run(["auth-check", "--format", "table"], home)
        self.assertEqual(r.returncode, 0, r.stderr)
        out = r.stdout
        self.assertFalse(blank_header(out), out)
        rows = table_rows(out)
        self.assertEqual(rows[0], ["Name", "Kartik Test"], "the first row is a real field, not an empty header")
        self.assertTrue(all(any(c for c in row) for row in rows), "no row without text")
        self.assertIn(["User ID", "kartik@example.test"], rows)
        self.assertIn(["Brewboard roles", "BB Project User"], rows)
        self.assertIn(["Site", self.mock.url], rows)
        self.assertTrue(out.startswith("### Brewboard connection\nSigned in · checked just now\n"))
        self.assertIn("**Project** BrewT · Brew Test · **Task** TASK-2026-00811 · Fix login · "
                      "**Tickets** ISS-2026-00191 · Crash", out)
        self.assertNotIn("s-test-not-real", out)
        self.assertNotIn("\x1b", out)

    def test_json_contract_is_kept(self):
        with TempHome() as home:
            write_config(home, url=self.mock.url, user=USER["name"])
            data = json.loads(run(["auth-check"], home).stdout)
        self.assertEqual((data["status"], data["user"], data["roles"]), ("ok", USER["name"], ["BB Project User"]))
        self.assertEqual(data["full_name"], "Kartik Test", "additive field used by the table")

    def test_problem_states_say_what_and_how_to_fix(self):
        with TempHome() as home:
            out = run(["auth-check", "--format", "table"], home).stdout
            self.assertIn("Not signed in · status `not_configured`", out)
            self.assertIn("init --login", out)
            self.assertNotIn("|", out, "no table when there is nothing to show")
            self.mock.accept = False
            write_config(home, url=self.mock.url, user=USER["name"])
            out = run(["auth-check", "--format", "table"], home).stdout
            self.assertRegex(out, r"status `(credentials_rejected|auth_failed)`")

    def test_without_a_full_name_the_user_id_leads_and_is_not_repeated(self):
        text = render.connection({"status": "ok", "user": "u@x", "full_name": None, "roles": [], "url": "https://s",
                                  "credentials": {}}, {})
        rows = table_rows(text)
        self.assertEqual(rows[0], ["User ID", "u@x"])
        self.assertEqual(sum(r[0] == "User ID" for r in rows), 1)
        self.assertIn("no Brewboard role", text)
        self.assertFalse(blank_header(text))

    def test_skill_md_init_prints_bb_py_output_instead_of_composing_a_table(self):
        skill = (ROOT / "dist" / "skill" / "SKILL.md").read_text(encoding="utf-8")
        init = skill.split("### init", 1)[1].split("\n### ", 1)[0]
        self.assertIn("`bb.py auth-check --format table`", init)
        self.assertIn("print its output verbatim", init)
        self.assertIn("do not re-type it as another table", init)
        self.assertNotIn("On success show name, user ID", init)


class NoBlankHeadersAnywhere(unittest.TestCase):
    def test_no_view_has_an_empty_header_row(self):
        from test_render import all_views  # every list, record, status, home and write view
        for name, text in all_views().items():
            with self.subTest(name):
                self.assertFalse(blank_header(text))


if __name__ == "__main__":
    unittest.main()

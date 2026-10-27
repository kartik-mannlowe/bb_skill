"""Markdown views (`--format table`): structure, empty states, contracts SKILL.md relies on, no terminal codes."""
import re
import unittest

import fixtures as f
from support import BOX, squash  # noqa: F401  (support sets the import path)

from bbclient import render


def gfm_cells(row: str) -> list:
    """Split a Markdown table row the way GFM does: a pipe ends a cell unless an odd number of backslashes
    precedes it."""
    cells, cur, i = [], "", 0
    body = row.strip()[1:-1] if row.strip().endswith("|") and not re.search(r"(?<!\\)(\\\\)*\\\|$", row.strip()) else row.strip()[1:]
    while i < len(body):
        ch = body[i]
        if ch == "\\" and i + 1 < len(body):
            cur += body[i:i + 2]
            i += 2
            continue
        if ch == "|":
            cells.append(cur.strip())
            cur = ""
        else:
            cur += ch
        i += 1
    cells.append(cur.strip())
    return cells


def all_views():
    st = f.state()
    return {
        "projects": render.projects(f.projects()), "projects_empty": render.projects(f.projects(rows=False)),
        "tasks": render.tasks(f.tasks(total=12)), "tasks_empty": render.tasks(f.tasks(rows=False)),
        "tickets": render.tickets(f.tickets()), "tickets_empty": render.tickets(f.tickets(rows=False)),
        "cycles": render.cycles(f.cycles()), "cycles_empty": render.cycles(f.cycles(rows=False)),
        "moms": render.moms(f.moms()), "moms_empty": render.moms(f.moms(rows=False)),
        "timesheets": render.timesheets(f.timesheets()), "timesheets_empty": render.timesheets(f.timesheets(False)),
        "find": render.find(f.find()), "find_empty": render.find(f.find(rows=False)),
        "task": render.record("Task", f.task_record()),
        "status": render.context(st, {"project": st["project"], "task": None, "tickets": []}),
        "home": render.home({"version": "0.2.0", "signed_in": True, "user": "dev@bb.local",
                             "full_name": "Aarav Mehta", "site": "https://brewboard.example.com",
                             "context": {"project": st["project"], "task": None, "tickets": []}}),
        "log_time": render.log_time(f.log_time_result()),
    }


class ViewContracts(unittest.TestCase):
    def test_plain_markdown_only(self):
        for name, text in all_views().items():
            with self.subTest(name):
                self.assertNotIn("\x1b", text, "no ANSI colour in agent output")
                self.assertIsNone(BOX.search(text), "no box-drawing characters")
                self.assertNotRegex(text, r"<\w+[^>]*>", "no HTML")
                self.assertTrue(text.endswith("\n") and not text.endswith("\n\n"))

    def test_every_list_view_has_one_heading_a_summary_and_the_fetched_line(self):
        for name in ("projects", "tasks", "tickets", "cycles", "moms", "timesheets", "find"):
            with self.subTest(name):
                text = all_views()[name]
                self.assertEqual(text.count("\n### "), 0, "exactly one heading, at the top")
                self.assertTrue(text.startswith("### "))
                self.assertIn("_Fetched from Brewboard at 2026-10-26 14:05:12._", text)

    def test_selection_contract(self):
        text = render.tasks(f.tasks(total=12))
        rows = [r for r in text.splitlines() if r.startswith("| ")][1:]
        self.assertTrue(rows[0].startswith("| * | `TASK-2026-00009` |"), "Sel marker and the exact ID, as code")
        self.assertTrue(rows[1].startswith("|  | `TASK-2026-00011` |"), "unselected rows have a blank Sel cell")
        self.assertIn("Showing 2 of 12. For more: `/bb list_tasks 12`", text)
        self.assertTrue(text.rstrip().endswith("**Enter the task ID to select.**"))
        self.assertNotRegex(text, r"\|\s*1\s*\|", "no row-number column")

    def test_missing_values_are_dashes_in_lists_and_pipes_are_escaped(self):
        text = render.tasks(f.tasks())
        self.assertIn("Fix \\| pipe in subject", text)
        self.assertRegex(text, r"\| Medium \| — \| — \| — \|")

    def test_overdue_dates_and_identifiers_stand_out(self):
        text = render.tasks(f.tasks())
        self.assertIn("**2026-10-05 (overdue)**", text)
        self.assertIn("`TASK-2026-00009`", text)

    def test_ticket_prompt_allows_several(self):
        self.assertIn("**Enter the ticket ID(s) to select (comma-separated, or `all`).**", render.tickets(f.tickets()))

    def test_no_prompt_option(self):
        self.assertNotIn("Enter the", render.projects(f.projects(), prompt=False))


class AwkwardValues(unittest.TestCase):
    """Values that can corrupt Markdown: the row must keep its columns and the text must survive."""

    def row_of(self, text, marker):
        return next(r for r in text.splitlines() if marker in r)

    def test_pipes_backslashes_backticks_newlines_and_non_ascii_keep_the_columns(self):
        for subject in ["grep 'foo\\|bar' fails", "a | b", "trailing \\", "x\\\\|y", "two\nlines\r\nhere",
                        "uses `code` and **stars**", "Überprüfung – 日本語 – emoji 🚀", "x" * 300]:
            with self.subTest(subject=subject[:30]):
                data = f.tasks()
                data["tasks"][0]["subject"] = subject
                row = self.row_of(render.tasks(data), "TASK-2026-00009")
                self.assertEqual(len(gfm_cells(row)), 8, row)
                self.assertNotIn("\n", row)

    def test_identifier_with_a_backtick_stays_one_code_span(self):
        self.assertEqual(render.code("TA`SK-2"), "`` TA`SK-2 ``")
        self.assertEqual(render.code("TASK-2"), "`TASK-2`")

    def test_code_fence_in_free_text_cannot_swallow_the_view(self):
        rec = f.task_record()
        rec["description"] = "<p>```sql</p><p>SELECT 1;</p>"
        text = render.record("Task", rec)
        self.assertNotRegex(text, r"(?m)^\s*```")
        self.assertIn("\\`\\`\\`sql", text)
        mom = {"name": "MOM-1", "meeting_topic": "t", "meeting_notes": "~~~\nnotes", "decisions": "Ship it",
               "action_items": [{"name": "r1", "actions": "Do it"}]}
        text = render.record("Minutes of Meeting", mom)
        self.assertNotRegex(text, r"(?m)^\s*~~~")
        self.assertIn("**Decisions**", text)
        self.assertIn("**Action items**", text)

    def test_missing_time_log_values_are_dashes_not_zero(self):
        ts = f.timesheets()
        ts["logs"][0].update(hours=None, from_time=None, to_time=None)
        cells = gfm_cells(self.row_of(render.timesheets(ts), "TL-0091"))
        self.assertEqual(cells[3:5], ["—", "—"], "Time and Hours")
        ts["logs"][0].update(from_time="2026-10-07 09:00:00")
        self.assertIn("09:00–?", render.timesheets(ts))


class MoreHints(unittest.TestCase):
    """The "For more" command must be valid /bb syntax that lists the same thing, or be left out."""

    def hint(self, text):
        line = next((r for r in text.splitlines() if r.startswith("Showing")), None)
        return line

    def test_several_statuses_are_comma_separated(self):
        self.assertIn("For more: `/bb list_tasks Open,Working 12`",
                      self.hint(render.tasks(f.tasks(total=12, status=["Open", "Working"]))))
        data = f.tickets(total=7)
        data["status"] = ["On Hold", "Replied"]
        self.assertIn("For more: `/bb list_tickets On Hold,Replied 7`", self.hint(render.tickets(data)))

    def test_filters_the_syntax_cannot_express_get_no_hint(self):
        cases = [("all statuses", dict(status="all")), ("search", dict(search="login")), ("mine", dict(mine=True)),
                 ("cycle", dict(cycle="CYC-1"))]
        for name, over in cases:
            with self.subTest(name):
                data = f.tasks(total=9)
                data.update(over)
                self.assertEqual(self.hint(render.tasks(data)), "Showing 2 of 9.")
        data = f.tickets(total=4)
        data["priority"] = ["High"]
        self.assertEqual(self.hint(render.tickets(data)), "Showing 1 of 4.")

    def test_lists_without_a_limit_argument_get_no_hint(self):
        self.assertEqual(self.hint(render.projects(f.projects(total=23))), "Showing 2 of 23.")
        data = f.cycles()
        data["total"] = 14
        self.assertEqual(self.hint(render.cycles(data)), "Showing 1 of 14.")

    def test_showing_and_fetched_are_separate_paragraphs(self):
        lines = render.tasks(f.tasks(total=12)).splitlines()
        i = next(n for n, line in enumerate(lines) if line.startswith("Showing"))
        self.assertEqual(lines[i + 1], "")
        self.assertTrue(lines[i + 2].startswith("_Fetched"))


class EmptyResults(unittest.TestCase):
    def test_empty_lists_explain_and_suggest_a_real_next_step(self):
        cases = {
            "tasks_empty": ("No open tasks in MA · Mobile App v2.", "`/bb list_tasks Completed`"),
            "tickets_empty": ("No open tickets in MA · Mobile App v2.", "`/bb list_tickets Resolved`"),
            "moms_empty": ("No minutes of meeting in MA · Mobile App v2 yet.", "`/bb create_mom`"),
            "timesheets_empty": ("No time logs from 2026-10-01.", "`/bb log_time`"),
            "find_empty": ("No matches for 'payment gateway'.", "Try other keywords"),
            "projects_empty": ("No open projects are visible to your Brewboard account.", "project manager"),
        }
        views = all_views()
        for name, (message, step) in cases.items():
            with self.subTest(name):
                text = views[name]
                self.assertIn(message, text)
                self.assertIn(step, text)
                self.assertNotIn("| Sel |", text, "no empty table")
                self.assertNotRegex(text.lower(), r"error|failed", "an empty result is not a failure")
                self.assertNotIn("Enter the", text, "nothing to pick")

    def test_empty_list_of_all_statuses_does_not_say_open(self):
        for view, data in ((render.tasks, f.tasks(rows=False, status="all")),
                           (render.tickets, {**f.tickets(rows=False), "status": "all"})):
            text = view(data)
            self.assertNotIn("open", text.split("\n\n")[1].lower())
            self.assertRegex(text, r"No (tasks|tickets) in MA · Mobile App v2\.")

    def test_search_everywhere_does_not_suggest_searching_everywhere(self):
        data = f.find(rows=False)
        data["scope"] = "all projects"
        self.assertNotIn("search all projects", render.find(data))

    def test_filtered_empty_list_says_matching(self):
        data = f.tasks(rows=False, status=["Completed"])
        self.assertIn("No matching tasks", render.tasks(data))
        self.assertIn("Completed · 0 tasks", render.tasks(data))

    def test_search_without_results_names_the_search(self):
        data = f.projects(rows=False)
        data["search"] = "zzz"
        self.assertIn("No projects match 'zzz'.", render.projects(data))


class Records(unittest.TestCase):
    def test_record_view_leaves_out_fields_the_backend_did_not_return(self):
        text = render.record("Task", f.task_record())
        self.assertNotIn("| Parent task |", text)
        self.assertNotIn("| Ticket |", text)
        self.assertNotIn("—", text)
        self.assertIn("| Task | `TASK-2026-00009` Investigate Android crash on app start |", text)
        self.assertIn("Crash on start", text)
        self.assertNotIn("<b>", text)

    def test_empty_description_says_so(self):
        rec = f.task_record()
        rec["description"] = None
        self.assertIn("_No description._", render.record("Task", rec))

    def test_find_uses_user_facing_type_names(self):
        text = render.find(f.find())
        self.assertIn("**Meetings** (1)", text)
        self.assertIn("Searched: Tasks: subject and description; Meetings: topic.", text)
        self.assertNotIn("\n\n\n", text)

    def test_status_view_keeps_its_contract(self):
        text = all_views()["status"]
        lines = text.splitlines()
        self.assertEqual(lines[0], "### Brewboard status")
        self.assertEqual(lines[2], "| User | Aarav Mehta (dev@bb.local) |", "first row is User")
        self.assertIn("| Task | none |", text)


class Home(unittest.TestCase):
    def test_banner_version_account_and_context(self):
        text = all_views()["home"]
        self.assertTrue(text.startswith("```text\n"))
        block = text.split("```")[1]
        self.assertIn("Your workspace. Your workflow.", block)
        self.assertRegex(block, r"Your workspace\. Your workflow\.\s+v0\.2\.0\n")
        self.assertIn("**Account** Aarav Mehta (dev@bb.local) · https://brewboard.example.com · saved sign-in", text)
        self.assertIn("**Project** CP · Customer Portal Revamp · **Task** none · **Tickets** none", text)

    def test_never_claims_a_live_connection(self):
        for signed_in in (True, False):
            text = render.home({"signed_in": signed_in, "user": "u", "site": "https://s", "context": {}})
            self.assertNotRegex(text.lower(), r"\bconnected\b|\bonline\b|\bverified\b")
        self.assertIn("not signed in", render.home({"signed_in": False, "context": {}}))

    def test_account_and_context_are_separate_paragraphs_and_titles_are_escaped(self):
        ctx = {"project": {"identifier": "CP", "title": "Portal\nRevamp | x"}, "task": None, "tickets": []}
        text = render.home({"signed_in": False, "context": ctx})
        tail = text.split("```\n")[1].strip().split("\n")
        self.assertEqual(tail[1], "", "a blank line keeps Account and Project apart")
        self.assertIn("**Project** CP · Portal Revamp \\| x ·", tail[2])

    def test_version_is_omitted_when_unknown(self):
        self.assertNotRegex(render.home({"signed_in": False, "context": {}}), r"v\d")

    def test_banner_fits_the_width(self):
        for width, rows in ((80, 4), (56, 4), (50, 3), (37, 3), (35, 1), (20, 1)):
            with self.subTest(width=width):
                block = render.home({"signed_in": False, "context": {}}, width).split("```text\n")[1].split("```")[0]
                art = [line for line in block.splitlines() if not line.startswith("Your work")]
                self.assertEqual(len(art), rows)
                self.assertTrue(all(len(line) <= width for line in block.splitlines()), block)


class WriteResults(unittest.TestCase):
    def test_time_log_confirmation(self):
        text = render.log_time(f.log_time_result(new_task=True))
        self.assertTrue(text.startswith("### Time logged · 1.5h"))
        self.assertIn("| Time log | `TL-0091` |", text)
        self.assertIn("| When | 2026-10-07 09:00–10:30 (1.5h) |", text)
        self.assertIn("(new task)", text)
        self.assertIn("Saved as **Draft**", text)
        self.assertNotIn("| Meeting |", text, "no meeting was given, so no row")

    def test_time_log_warnings_are_listed(self):
        r = f.log_time_result()
        r["warnings"] = ["TS-2026-00012 was created but its log is not visible yet in get_timesheet_logs."]
        r["entry"] = None
        text = render.log_time(r)
        self.assertIn("**Warnings**", text)
        self.assertIn("created; entry not visible yet", text)

    def test_minutes_update_shows_people_not_raw_rows(self):
        text = render.update({"doctype": "Minutes of Meeting", "name": "MOM-1", "project": "MA", "changed": {
            "attendees": {"from": [{"name": "r1", "user": "a@x.com", "full_name": "A"}],
                          "to": [{"name": "r1", "user": "a@x.com", "full_name": "A"}, {"name": "r2", "user": "b@x.com"}]},
            "minutes": {"from": [], "to": [{"name": "m1", "topic": "Budget"}]}}})
        self.assertIn("| attendees | A | A, b@x.com |", text)
        self.assertIn("| minutes | — | Budget |", text)
        self.assertNotIn("{", text)

    def test_update_shows_before_and_after_or_no_change(self):
        text = render.update({"doctype": "Issue", "name": "ISS-1", "changed": {"priority": {"from": "Low", "to": "High"}},
                              "status": "Open"})
        self.assertIn("### Ticket updated · ISS-1", text)
        self.assertIn("| priority | Low | High |", text)
        self.assertIn("No change", render.update({"entry": "TL-1", "timesheet": "TS-1", "changed": {}}))
        self.assertIn("### Time log updated · TL-1", render.update({"entry": "TL-1", "timesheet": "TS-1", "changed": {}}))

    def test_minutes_with_created_tasks_and_warnings(self):
        text = render.create_mom({"mom": "MOM-2026-00003", "meeting_topic": "Sprint review", "project": "MA",
                                  "from_time": "2026-10-07 10:00:00", "to_time": "2026-10-07 11:00:00",
                                  "meeting_type": "Status Review", "attendees": ["Aarav Mehta"],
                                  "external_attendees": [], "minutes": ["a", "b"], "action_items": [{}],
                                  "tasks_created": [{"name": "TASK-2026-00020", "subject": "Fix login",
                                                     "assigned_to": [], "due_date": None}],
                                  "warnings": ["'Bob' is not a project member user; the task was created unassigned."]})
        self.assertIn("### Minutes recorded · MOM-2026-00003", text)
        self.assertIn("| `TASK-2026-00020` | Fix login | — | — |", text)
        self.assertIn("| Minutes | 2 points |", text)
        self.assertIn("**Warnings**", text)
        self.assertNotIn("| External |", text)

    def test_delete_says_what_is_kept(self):
        text = render.delete({"deleted": True, "doctype": "Minutes of Meeting", "name": "MOM-1", "project": "MA"})
        self.assertIn("Tasks and time logs created from the meeting are kept.", text)


if __name__ == "__main__":
    unittest.main()

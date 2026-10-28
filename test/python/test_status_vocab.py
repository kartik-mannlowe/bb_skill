"""Task and ticket statuses follow the project's Status Type: a Custom project's own stages, else the standard ones."""
import unittest

import support  # noqa: F401  (sets the import path)

from bbclient import render, service
from bbclient.errors import BBError

TASK_META = {"statuses": ["Open", "Working", "Pending Review", "Overdue", "Template", "Completed", "Cancelled"]}
TICKET_META = {"statuses": ["Open", "Replied", "On Hold", "Resolved", "Closed"]}
CUSTOM_META = {
    "status_type": "Custom",
    "task_statuses": [{"status": "Backlog", "native_status": "Open"}, {"status": "In Progress", "native_status": "Working"},
                      {"status": "QA In Progress", "native_status": "Working"},
                      {"status": "Cancelled", "native_status": "Cancelled"},
                      {"status": "Closed", "native_status": "Completed"}],
    "issue_statuses": [{"status": "Open", "native_status": "Open"}, {"status": "Approved", "native_status": "Resolved"},
                       {"status": "Closed", "native_status": "Closed"}],
}
DEFAULT_META = {"status_type": "Default", "task_statuses": CUSTOM_META["task_statuses"],
                "issue_statuses": CUSTOM_META["issue_statuses"]}


class FakeAPI:
    site = "https://bb.example"

    def __init__(self, meta, tasks=(), tickets=()):
        self.meta, self.calls = meta, []
        self.task_rows = {t["name"]: dict(t) for t in tasks}
        self.ticket_rows = {t["name"]: dict(t) for t in tickets}

    def project_status_meta(self, identifier):
        return self.meta

    def task_meta(self):
        return TASK_META

    def ticket_meta(self):
        return TICKET_META

    def tasks(self, identifier, include_subtasks=False):
        return [dict(t) for t in self.task_rows.values()]

    def tickets(self, identifier, status=None, priority=None):
        self.calls.append(("tickets", status))
        return [dict(t) for t in self.ticket_rows.values() if not status or t["status"] == status]

    def task(self, identifier, name):
        return dict(self.task_rows[name])

    def ticket(self, identifier, name):
        return dict(self.ticket_rows[name])

    def linked_tasks(self, name):
        return []

    def update_task(self, name, field, value, completed_by=None):
        self.calls.append(("update_task", field, value, completed_by))
        self.task_rows[name][field] = value
        return dict(self.task_rows[name])

    def update_ticket(self, name, field, value):
        self.calls.append(("update_ticket", field, value))
        self.ticket_rows[name][field] = value
        return dict(self.ticket_rows[name])

    def create_task(self, identifier, subject, **fields):
        self.calls.append(("create_task", fields))
        return {"name": "TASK-NEW", "subject": subject, "status": fields.get("status"),
                "custom_task_status": fields.get("custom_task_status")}


ST = {"project": {"identifier": "BR", "title": "Brew"}, "user": "me@x.com", "site": FakeAPI.site}


def task(name, status, stage=None):
    return {"name": name, "subject": name, "status": status, "custom_task_status": stage, "priority": "Medium"}


def ticket(name, status, stage=None):
    return {"name": name, "subject": name, "status": status, "custom_issue_status": stage, "priority": "High"}


class CustomProject(unittest.TestCase):
    def test_lists_and_validates_only_the_projects_own_stages(self):
        api = FakeAPI(CUSTOM_META, tasks=[task("T1", "Open", "Backlog"), task("T2", "Working", "In Progress")])
        out = service.list_tasks(api, ST, status="in progress")
        self.assertEqual(out["status_type"], "Custom")
        self.assertEqual(out["statuses"], ["Backlog", "In Progress", "QA In Progress", "Cancelled", "Closed"])
        self.assertEqual([t["name"] for t in out["tasks"]], ["T2"])
        with self.assertRaises(BBError) as e:
            service.list_tasks(api, ST, status="Working")  # a standard status, not one of this project's stages
        self.assertEqual(e.exception.extra["valid"], out["statuses"])
        self.assertEqual(e.exception.extra["candidates"], ["In Progress", "QA In Progress"])

    def test_default_open_list_reads_the_stage_mapping(self):
        # ISS-2 sits in the Closed stage while its stored native status still says Open
        api = FakeAPI(CUSTOM_META, tickets=[ticket("ISS-1", "Open", "Open"), ticket("ISS-2", "Open", "Closed")])
        out = service.list_tickets(api, ST)
        self.assertEqual([t["name"] for t in out["tickets"]], ["ISS-1"])
        service.list_tickets(api, ST, status="Closed")
        self.assertIn(("tickets", None), api.calls)  # a custom stage is never sent as a native server filter

    def test_status_change_is_written_to_the_custom_field(self):
        api = FakeAPI(CUSTOM_META, tasks=[task("T1", "Open", "Backlog")])
        out = service.update_record(api, ST, "task", "T1", {"status": "cancelled"})
        self.assertEqual(api.calls, [("update_task", "custom_task_status", "Cancelled", None)])
        self.assertEqual(out["changed"]["custom_task_status"], {"from": "Backlog", "to": "Cancelled"})

    def test_a_stage_that_completes_the_task_needs_completed_by_before_anything_is_sent(self):
        api = FakeAPI(CUSTOM_META, tasks=[task("T1", "Open", "Backlog")])
        with self.assertRaises(BBError) as e:
            service.update_record(api, ST, "task", "T1", {"custom_task_status": "Closed"})
        self.assertEqual(e.exception.code, "bad_input")
        self.assertEqual(api.calls, [])
        service.update_record(api, ST, "task", "T1", {"status": "Closed"}, completed_by="me@x.com")
        self.assertEqual(api.calls, [("update_task", "custom_task_status", "Closed", "me@x.com")])

    def test_ticket_resolution_is_saved_before_the_closing_stage(self):
        api = FakeAPI(CUSTOM_META, tickets=[ticket("ISS-1", "Open", "Open")])
        service.update_record(api, ST, "issue", "ISS-1", {"status": "Closed", "resolution_details": "Fixed"})
        self.assertEqual([c[1] for c in api.calls], ["resolution_details", "custom_issue_status"])

    def test_empty_list_hint_suggests_one_of_the_projects_stages(self):
        api = FakeAPI(CUSTOM_META, tasks=[task("T1", "Open", "Backlog")])
        md = render.tasks(service.list_tasks(api, ST, status="In Progress"))
        self.assertIn("`/bb list_tasks Closed`", md)
        self.assertNotIn("Completed", md)
        md = render.tickets(service.list_tickets(FakeAPI(CUSTOM_META), ST, status="Approved"))
        self.assertIn("`/bb list_tickets Closed`", md)
        self.assertNotIn("Resolved", md)

    def test_create_task_with_a_stage(self):
        api = FakeAPI(CUSTOM_META)
        service.create_task(api, ST, "New", status="in progress", assign_to_me=False)
        fields = api.calls[0][1]
        self.assertEqual((fields["status"], fields["custom_task_status"]), ("Working", "In Progress"))
        api.calls.clear()
        service.create_task(api, ST, "New", assign_to_me=False)
        self.assertEqual((api.calls[0][1]["status"], api.calls[0][1]["custom_task_status"]), ("Open", None))


class DefaultProject(unittest.TestCase):
    def test_only_standard_statuses_and_no_stale_stage(self):
        api = FakeAPI(DEFAULT_META, tasks=[task("T1", "Working", "Backlog")])
        out = service.list_tasks(api, ST, status="working")
        self.assertEqual(out["status_type"], "Default")
        self.assertEqual(out["statuses"], TASK_META["statuses"])
        self.assertIsNone(out["tasks"][0]["custom_task_status"])  # leftover stage from an earlier Custom period
        with self.assertRaises(BBError):
            service.list_tasks(api, ST, status="Backlog")

    def test_status_change_goes_to_status_and_custom_field_is_refused(self):
        api = FakeAPI(DEFAULT_META, tasks=[task("T1", "Open")])
        service.update_record(api, ST, "task", "T1", {"status": "Cancelled"})
        self.assertEqual(api.calls, [("update_task", "status", "Cancelled", None)])
        with self.assertRaises(BBError):
            service.update_record(api, ST, "task", "T1", {"custom_task_status": "Backlog"})
        with self.assertRaises(BBError):  # Completed still needs who did it
            service.update_record(api, ST, "task", "T1", {"status": "Completed"})

    def test_single_ticket_status_is_filtered_by_the_server(self):
        api = FakeAPI(DEFAULT_META, tickets=[ticket("ISS-1", "Open"), ticket("ISS-2", "Closed")])
        out = service.list_tickets(api, ST, status="closed")
        self.assertEqual([t["name"] for t in out["tickets"]], ["ISS-2"])
        self.assertIn(("tickets", "Closed"), api.calls)


if __name__ == "__main__":
    unittest.main()

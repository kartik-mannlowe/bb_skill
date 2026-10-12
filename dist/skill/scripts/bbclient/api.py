"""The Brewboard HTTP API: whitelisted methods of the `brewboard_backend` Frappe app.

Every endpoint bb.py calls is listed in ENDPOINTS with its HTTP method and the source file
it was verified against (brewboard_backend, branch uat, commit 2493939; auth.*_credential(s) and the
`client` login parameter from the per-client credentials change, 2026-10-12). Nothing else is
called: no generic /api/resource access, no MCP. An operation without an endpoint here is
reported as `api_unsupported` by the service layer.

Methods return the endpoint's `message` value unchanged; shaping happens in service.py.
"""
from __future__ import annotations

from .errors import BBError
from .transport import Transport

PREFIX = "brewboard_backend.api."

# name -> (HTTP method, dotted path under PREFIX, source file::function)
ENDPOINTS = {
    "ping":                ("GET",  "health.ping",                        "api/health.py::ping"),
    "login":               ("POST", "auth.login_and_get_keys",            "api/auth.py::login_and_get_keys"),
    "current_user":        ("GET",  "auth.get_current_user",              "api/auth.py::get_current_user"),
    "list_credentials":    ("GET",  "auth.list_credentials",              "api/auth.py::list_credentials"),
    "revoke_credential":   ("POST", "auth.revoke_credential",             "api/auth.py::revoke_credential"),
    "revoke_other_credentials": ("POST", "auth.revoke_other_credentials", "api/auth.py::revoke_other_credentials"),
    "projects":            ("GET",  "projects.get_projects",              "api/projects.py::get_projects"),
    "project":             ("GET",  "projects.get_project",               "api/projects.py::get_project"),
    "project_status_meta": ("GET",  "meta.get_project_status_meta",       "api/meta.py::get_project_status_meta"),
    "task_meta":           ("GET",  "meta.get_task_meta",                 "api/meta.py::get_task_meta"),
    "ticket_meta":         ("GET",  "meta.get_ticket_meta",               "api/meta.py::get_ticket_meta"),
    "meeting_meta":        ("GET",  "meta.get_meeting_meta",              "api/meta.py::get_meeting_meta"),
    "tasks":               ("GET",  "tasks.get_tasks",                    "api/tasks.py::get_tasks"),
    "task":                ("GET",  "tasks.get_task",                     "api/tasks.py::get_task"),
    "create_task":         ("POST", "tasks.create_task",                  "api/tasks.py::create_task"),
    "update_task":         ("POST", "tasks.update_task",                  "api/tasks.py::update_task"),
    "tickets":             ("GET",  "tickets.get_tickets",                "api/tickets.py::get_tickets"),
    "ticket":              ("GET",  "tickets.get_ticket",                 "api/tickets.py::get_ticket"),
    "update_ticket":       ("POST", "tickets.update_ticket",              "api/tickets.py::update_ticket"),
    "linked_tasks":        ("GET",  "tickets.get_linked_tasks",           "api/tickets.py::get_linked_tasks"),
    "activity_types":      ("GET",  "timesheets.get_activity_types",      "api/timesheets.py::get_activity_types"),
    "timesheet_logs":      ("GET",  "timesheets.get_timesheet_logs",      "api/timesheets.py::get_timesheet_logs"),
    "create_log":          ("POST", "timesheets.create_timesheet_log",    "api/timesheets.py::create_timesheet_log"),
    "update_log":          ("POST", "timesheets.update_timesheet_log",    "api/timesheets.py::update_timesheet_log"),
    "cycles":              ("GET",  "cycles.get_cycles",                  "api/cycles.py::get_cycles"),
    "cycle":               ("GET",  "cycles.get_cycle",                   "api/cycles.py::get_cycle"),
    "minutes":             ("GET",  "minutes.get_minutes",                "api/minutes.py::get_minutes"),
    "minutes_meeting":     ("GET",  "minutes.get_minutes_meeting",        "api/minutes.py::get_minutes_meeting"),
    "create_minutes":      ("POST", "minutes.create_minutes",             "api/minutes.py::create_minutes"),
    "update_minutes":      ("POST", "minutes.update_minutes",             "api/minutes.py::update_minutes"),
    "delete_minutes":      ("POST", "minutes.delete_minutes",             "api/minutes.py::delete_minutes"),
    "task_from_action":    ("POST", "minutes.create_task_from_action_point",
                            "api/minutes.py::create_task_from_action_point"),
    "search":              ("GET",  "search.search",                      "api/search.py::search"),
    "attachments":         ("GET",  "attachments.get_attachments",        "api/attachments.py::get_attachments"),
    "download_attachment": ("GET",  "attachments.download_attachment",    "api/attachments.py::download_attachment"),
    "members":             ("GET",  "settings.get_workspace_members",     "api/settings.py::get_workspace_members"),
}


class BrewboardAPI:
    def __init__(self, transport: Transport):
        self.t = transport

    @property
    def site(self) -> str:
        return self.t.base_url

    def call(self, endpoint: str, /, *, raw: bool = False, auth: bool = True, **args):
        """`endpoint` is positional-only: several endpoints take a parameter called `name`."""
        http_method, dotted, _src = ENDPOINTS[endpoint]
        return self.t.method(http_method, PREFIX + dotted, {k: v for k, v in args.items() if v is not None},
                             raw=raw, auth=auth)

    def _list(self, endpoint: str, /, **args) -> list:
        out = self.call(endpoint, **args)
        if out is None:
            return []
        if not isinstance(out, list):
            raise BBError("bad_response", f"{ENDPOINTS[endpoint][1]} returned {type(out).__name__}, expected a list")
        return out

    def _dict(self, endpoint: str, /, **args) -> dict:
        out = self.call(endpoint, **args)
        if not isinstance(out, dict):
            raise BBError("bad_response",
                          f"{ENDPOINTS[endpoint][1]} returned {type(out).__name__}, expected an object")
        return out

    # identity
    def ping(self) -> dict:
        return self._dict("ping", auth=False)

    def login(self, usr: str, pwd: str, client: str | None = None, label: str | None = None) -> dict:
        """client="cli" asks for a per-client credential (reply carries auth_source); an older
        backend ignores nothing and answers with the account's single key pair instead."""
        return self._dict("login", auth=False, usr=usr, pwd=pwd, client=client, label=label)

    def list_credentials(self) -> list:
        return self._list("list_credentials")

    def revoke_credential(self, credential: str | None = None) -> dict:
        return self._dict("revoke_credential", credential=credential)

    def revoke_other_credentials(self) -> dict:
        return self._dict("revoke_other_credentials")

    def current_user(self) -> dict:
        return self._dict("current_user")

    # projects
    def projects(self, include_archived: bool = False) -> list:
        return self._list("projects", include_archived=1 if include_archived else 0)

    def project(self, identifier: str) -> dict:
        return self._dict("project", project_identifier=identifier)

    def project_status_meta(self, identifier: str) -> dict:
        return self._dict("project_status_meta", project_identifier=identifier)

    # vocabularies
    def task_meta(self) -> dict:
        return self._dict("task_meta")

    def ticket_meta(self) -> dict:
        return self._dict("ticket_meta")

    def meeting_meta(self) -> dict:
        return self._dict("meeting_meta")

    # tasks
    def tasks(self, identifier: str, include_subtasks: bool = False) -> list:
        return self._list("tasks", project_identifier=identifier, include_subtasks=1 if include_subtasks else 0)

    def task(self, identifier: str, task_name: str) -> dict:
        return self._dict("task", project_identifier=identifier, task_name=task_name)

    def create_task(self, identifier: str, subject: str, **fields) -> dict:
        return self._dict("create_task", project_identifier=identifier, subject=subject, **fields)

    def update_task(self, task_name: str, field: str, value, completed_by: str | None = None) -> dict:
        return self._dict("update_task", task_name=task_name, field=field, value=value, completed_by=completed_by)

    # tickets
    def tickets(self, identifier: str, status: str | None = None, priority: str | None = None) -> list:
        return self._list("tickets", project_identifier=identifier, status=status, priority=priority)

    def ticket(self, identifier: str, ticket_name: str) -> dict:
        return self._dict("ticket", project_identifier=identifier, ticket_name=ticket_name)

    def update_ticket(self, ticket_name: str, field: str, value) -> dict:
        return self._dict("update_ticket", ticket_name=ticket_name, field=field, value=value)

    def linked_tasks(self, ticket_name: str) -> list:
        return self._list("linked_tasks", ticket_name=ticket_name)

    # time
    def activity_types(self) -> list:
        return self._list("activity_types")

    def timesheet_logs(self, user: str = "me", identifier: str | None = None, from_date: str | None = None,
                       to_date: str | None = None, is_billable: int | None = None) -> list:
        return self._list("timesheet_logs", user=user, project_identifier=identifier, from_date=from_date,
                          to_date=to_date, is_billable=is_billable)

    def create_log(self, **row) -> str:
        out = self.call("create_log", **row)
        if not isinstance(out, str) or not out:
            raise BBError("bad_response", "create_timesheet_log did not return a Timesheet name")
        return out

    def update_log(self, **row) -> str:
        out = self.call("update_log", **row)
        if not isinstance(out, str) or not out:
            raise BBError("bad_response", "update_timesheet_log did not return the entry name")
        return out

    # cycles
    def cycles(self, identifier: str) -> list:
        return self._list("cycles", project_identifier=identifier)

    def cycle(self, cycle_id: str) -> dict:
        return self._dict("cycle", cycle_id=cycle_id)

    # minutes of meeting
    def minutes(self, identifier: str) -> list:
        return self._list("minutes", project_identifier=identifier)

    def minutes_meeting(self, identifier: str, mom_name: str) -> dict:
        return self._dict("minutes_meeting", project_identifier=identifier, mom_name=mom_name)

    def create_minutes(self, identifier: str, meeting_topic: str, **fields) -> dict:
        return self._dict("create_minutes", project_identifier=identifier, meeting_topic=meeting_topic, **fields)

    def update_minutes(self, identifier: str, mom_name: str, meeting_topic: str, **fields) -> dict:
        return self._dict("update_minutes", project_identifier=identifier, mom_name=mom_name,
                          meeting_topic=meeting_topic, **fields)

    def delete_minutes(self, identifier: str, mom_name: str) -> dict:
        return self._dict("delete_minutes", project_identifier=identifier, mom_name=mom_name)

    def task_from_action(self, identifier: str, mom_name: str, row_name: str, assignees: list | None = None) -> dict:
        return self._dict("task_from_action", project_identifier=identifier, mom_name=mom_name,
                          row_name=row_name, assignees=assignees)

    # search, attachments, people
    def search(self, query: str) -> list:
        return self._list("search", query=query)

    def attachments(self, doctype: str, name: str) -> list:
        return self._list("attachments", doctype=doctype, name=name)

    def download_attachment(self, file_name: str | None = None, file_url: str | None = None):
        return self.call("download_attachment", raw=True, file_name=file_name, file_url=file_url)

    def members(self) -> list:
        return self._list("members")

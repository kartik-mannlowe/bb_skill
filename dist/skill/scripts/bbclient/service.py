"""The /bb operations on top of BrewboardAPI: input validation, filters, normalised output.

Every list operation makes a fresh API call; nothing here caches records. The Brewboard
list endpoints have no pagination or limit parameters and return every row the caller may
see, so filters the API lacks (task status, multi-value ticket status, search) and the
display limit are applied to that complete, fresh result. Outputs carry `total` (rows
matching after filtering) next to `count` (rows returned), so a shortened list is never
presented as complete.
"""
from __future__ import annotations

import html
import json
import re
import sys
from collections import defaultdict
from datetime import date, datetime, time, timedelta
from pathlib import Path

from . import config
from .api import BrewboardAPI
from .errors import BBError, unsupported
from .transport import strip_html

OPEN_TASK = ["Open", "Working", "Pending Review", "Overdue"]
CLOSED_TASK = {"Completed", "Cancelled"}
OPEN_ISSUE = ["Open", "Replied", "On Hold"]
# Custom-mode status field and get_project_status_meta list per doctype (helpers/project_helpers.py)
STATUS_FIELD = {"Task": "custom_task_status", "Issue": "custom_issue_status"}
STATUS_ROWS = {"Task": "task_statuses", "Issue": "issue_statuses"}
PRIORITY_RANK = {"Urgent": 0, "High": 1, "Medium": 2, "Low": 3}
DOCSTATUS = {0: "Draft", 1: "Submitted", 2: "Cancelled"}
MOM = "Minutes of Meeting"

DOCTYPE_ALIASES = {
    "project": "Project", "projects": "Project",
    "task": "Task", "tasks": "Task",
    "issue": "Issue", "issues": "Issue", "ticket": "Issue", "tickets": "Issue",
    "timesheet": "Timesheet", "timesheets": "Timesheet", "ts": "Timesheet",
    "log": "Timesheet Detail", "time-log": "Timesheet Detail", "timesheet-log": "Timesheet Detail",
    "mom": MOM, "moms": MOM, "minutes": MOM,
    "cycle": "Cycle", "cycles": "Cycle",
}

# update_task / update_ticket allow-lists (api/tasks.py, api/tickets.py)
TASK_FIELDS = {"subject", "status", "priority", "exp_start_date", "exp_end_date", "description", "parent_task",
               "custom_assignees", "custom_minutes_of_meeting", "custom_task_status", "type"}
TICKET_FIELDS = {"subject", "status", "priority", "issue_type", "custom_target_date", "description",
                 "resolution_details", "custom_assignees", "custom_issue_status"}
# update_timesheet_log row fields (api/timesheets.py)
LOG_FIELDS = {"project_identifier", "task_name", "from_time", "to_time", "hours", "description", "is_billable",
              "activity_type", "minutes_of_meeting", "workstream"}
LOG_ALIASES = {"task": "task_name", "project": "project_identifier", "billable": "is_billable",
               "activity": "activity_type", "mom": "minutes_of_meeting", "desc": "description"}
# create_minutes / update_minutes (api/minutes.py _SCALAR_FIELDS + child tables)
MOM_SCALARS = ("meeting_topic", "meeting_type", "location", "from_time", "to_time", "meeting_notes",
               "assessment_observations", "decisions")
MOM_TABLES = ("attendees", "external_attendees", "minutes", "action_items")
DATA_MAX = 140  # Frappe Data field length: Meeting Points.topic, Action Points.actions


# =============================================================== parsing helpers

def now_stamp() -> str:
    return datetime.now().isoformat(timespec="seconds")


def split_csv(s) -> list:
    return [x.strip() for x in (s or "").split(",") if x.strip()]


def parse_day(s: str | None) -> date:
    t = (s or "today").strip().lower()
    rel = {"today": 0, "yesterday": -1, "tomorrow": 1}
    if t in rel:
        return date.today() + timedelta(days=rel[t])
    try:
        return date.fromisoformat(t)
    except ValueError:
        raise BBError("bad_input", f"Bad date '{s}'. Use YYYY-MM-DD, today, yesterday or tomorrow.") from None


def parse_clock(s: str) -> time:
    m = re.fullmatch(r"(\d{1,2})(?::?(\d{2}))?\s*(am|pm)?", str(s).strip().lower())
    if not m:
        raise BBError("bad_input", f"Bad time '{s}'. Use HH:MM (24h) or e.g. 2:30pm.")
    h, mi = int(m.group(1)), int(m.group(2) or 0)
    if m.group(3) == "pm" and h < 12:
        h += 12
    if m.group(3) == "am" and h == 12:
        h = 0
    if h > 23 or mi > 59:
        raise BBError("bad_input", f"Bad time '{s}'.")
    return time(h, mi)


def parse_dt(s) -> datetime:
    t = str(s).strip().replace("T", " ")
    for fmt in ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
        try:
            return datetime.strptime(t, fmt)
        except ValueError:
            pass
    raise BBError("bad_input", f"Bad datetime '{s}'. Use 'YYYY-MM-DD HH:MM'.")


def fmt_dt(d: datetime) -> str:
    return d.strftime("%Y-%m-%d %H:%M:%S")


def parse_hours(s) -> float:
    """'2', '2.5', '2h', '90m', '1h30', '1h 30m', '1:30' -> hours as float."""
    t = str(s).strip().lower().replace(" ", "")
    m = re.fullmatch(r"(\d+(?:\.\d+)?)(?:h|hr|hrs|hour|hours)?", t)
    if m:
        return float(m.group(1))
    m = re.fullmatch(r"(\d+):(\d{1,2})", t)
    if m:
        return int(m.group(1)) + int(m.group(2)) / 60
    m = re.fullmatch(r"(?:(\d+(?:\.\d+)?)(?:h|hr|hrs|hours?))?(?:(\d+)(?:m|min|mins|minutes?)?)?", t)
    if m and (m.group(1) or m.group(2)):
        return float(m.group(1) or 0) + int(m.group(2) or 0) / 60
    raise BBError("bad_input", f"Bad duration '{s}'. Use e.g. 2, 2.5, 2h, 90m, 1h30.")


def coerce(v: str):
    s = v.strip()
    if s in ("true", "false", "null") or re.fullmatch(r"-?\d+(\.\d+)?", s) or s[:1] in "[{":
        try:
            return json.loads(s)
        except ValueError:
            pass
    return v


def read_json_input(path: str):
    try:
        raw = sys.stdin.read() if path == "-" else Path(path).expanduser().read_text(encoding="utf-8")
    except OSError as e:
        raise BBError("bad_input", f"Cannot read {path}: {e}") from None
    try:
        return json.loads(raw)
    except ValueError as e:
        raise BBError("bad_input", f"{path} is not valid JSON: {e}") from None


def doctype_of(s: str) -> str:
    return DOCTYPE_ALIASES.get(s.strip().lower(), s.strip())


def text_html(value, ordered: bool = False) -> str | None:
    """A Text Editor value from plain text or a list of strings (escaped, never raw HTML)."""
    if value in (None, "", []):
        return None
    if isinstance(value, list):
        tag = "ol" if ordered else "ul"
        return f"<{tag}>" + "".join(f"<li>{html.escape(str(x))}</li>" for x in value if str(x).strip()) + f"</{tag}>"
    lines = [html.escape(x) for x in str(value).splitlines()]
    return "<p>" + "<br>".join(lines) + "</p>"


def short(s, n: int = 80) -> str:
    s = strip_html(str(s or ""))
    return s if len(s) <= n else s[: n - 1].rstrip() + "…"


# =============================================================== identity + context

def whoami(api: BrewboardAPI) -> dict:
    u = api.current_user()
    if not u.get("name"):
        raise BBError("bad_response", "get_current_user returned no user name")
    return {"user": u["name"], "full_name": u.get("full_name") or u["name"], "email": u.get("email"),
            "roles": u.get("roles") or [], "site": api.site}


def supports_client_credentials(api: BrewboardAPI) -> bool:
    """Does this backend issue per-client credentials? Asked BEFORE any password is sent.

    An unauthenticated call to auth.list_credentials answers 401/403 when the method exists, and
    417 "Failed to get method" (or 404) when it does not. This matters because an older backend
    silently ignores an unknown `client` login parameter and rotates the account's single secret.
    Anything else counts as "no", so the caller warns rather than assumes."""
    try:
        api.call("list_credentials", auth=False)
    except BBError as e:
        return e.status in (401, 403)
    return False


def verify_site(api: BrewboardAPI) -> dict:
    """Unauthenticated health check: is this URL a Brewboard backend at all?"""
    try:
        info = api.ping()
    except BBError as e:
        if e.code in ("unreachable",):
            raise
        raise BBError("not_brewboard", f"{api.site} answers, but brewboard_backend.api.health.ping failed "
                                       f"({e.code}: {e.message}). Is this the Brewboard backend URL?") from None
    if info.get("app") != "brewboard_backend":
        raise BBError("not_brewboard", f"{api.site} does not identify as brewboard_backend")
    return info


def current_user(api: BrewboardAPI, st: dict) -> str:
    if st.get("user") and st.get("site") == api.site:
        return st["user"]
    return config.remember_identity(whoami(api))["user"]


def need_project(st: dict, explicit: str | None = None) -> str:
    if explicit:
        return explicit
    p = config.project_ctx(st)
    if not p:
        raise BBError("no_project", "No project selected. Run /bb list_projects "
                                    "(bb.py ctx set-project <IDENTIFIER>) or pass --project <IDENTIFIER>.")
    return p["identifier"]


def project_label(st: dict, identifier: str) -> str:
    p = config.project_ctx(st)
    if p and p["identifier"] == identifier and p.get("title"):
        return f"{identifier} · {p['title']}"
    return identifier


def window(rows: list, limit: int | None) -> tuple[list, int]:
    if limit is not None and limit < 1:
        raise BBError("bad_input", "--limit must be a positive integer")
    total = len(rows)
    return (rows[:limit] if limit else rows), total


# =============================================================== normalisers

def norm_project(p: dict, selected: str | None = None) -> dict:
    ident = p.get("custom_identifier")
    return {
        "identifier": ident, "name": p.get("name"), "project_name": p.get("project_name"),
        "status": p.get("status"), "priority": p.get("priority"), "percent_complete": p.get("percent_complete"),
        "expected_end_date": p.get("expected_end_date"), "open_task_count": p.get("open_task_count"),
        "archived": bool(p.get("custom_archived_at")),
        "members": [{"user": u.get("user"), "full_name": u.get("full_name")} for u in p.get("users") or []],
        "selected": bool(ident and ident == selected),
    }


def _assignees(rows) -> tuple[list, list]:
    rows = [a for a in rows or [] if isinstance(a, dict) and a.get("user")]
    return [a["user"] for a in rows], [a.get("full_name") or a["user"] for a in rows]


def is_overdue(row: dict) -> bool:
    due = row.get("exp_end_date")
    return bool(due and str(due) < date.today().isoformat() and row.get("status") not in CLOSED_TASK)


def _custom_stage(t: dict, field: str, vocab: dict | None):
    """A Default-mode project's records may still carry a stale custom stage; it is not their status."""
    return None if vocab and vocab["type"] == "Default" else t.get(field)


def norm_task(t: dict, selected: str | None = None, vocab: dict | None = None) -> dict:
    users, names = _assignees(t.get("custom_assignees"))
    return {
        "name": t.get("name"), "subject": t.get("subject"), "status": t.get("status"),
        "custom_task_status": _custom_stage(t, "custom_task_status", vocab), "priority": t.get("priority"),
        "exp_start_date": t.get("exp_start_date"), "exp_end_date": t.get("exp_end_date"),
        "progress": t.get("progress"), "project": t.get("project"), "parent_task": t.get("parent_task"),
        "type": t.get("type"), "assigned_to": users, "assignee_names": names,
        "cycles": t.get("custom_cycles") or [], "cycle_ids": t.get("cycle_ids") or [],
        "modules": t.get("custom_modules") or [], "module_ids": t.get("module_ids") or [],
        "overdue": is_overdue(t), "selected": t.get("name") == selected,
    }


def norm_ticket(t: dict, selected: set | None = None, vocab: dict | None = None) -> dict:
    users, names = _assignees(t.get("custom_assignees"))
    return {
        "name": t.get("name"), "subject": t.get("subject"), "status": t.get("status"),
        "custom_issue_status": _custom_stage(t, "custom_issue_status", vocab), "priority": t.get("priority") or None,
        "issue_type": t.get("issue_type") or None, "raised_by": t.get("owner") or None,
        "raised_by_name": t.get("owner_full_name") or t.get("owner") or None,
        "opened": (t.get("creation") or "")[:10] or None, "target_date": t.get("custom_target_date"),
        "project": t.get("project"), "assigned_to": users, "assignee_names": names,
        "module_ids": t.get("module_ids") or [], "selected": t.get("name") in (selected or set()),
    }


def norm_log(d: dict) -> dict:
    start = d.get("from_time")
    return {
        "entry": d.get("name"), "timesheet": d.get("timesheet"),
        "status": DOCSTATUS.get(d.get("docstatus"), None),
        "date": str(start)[:10] if start else None, "from_time": start, "to_time": d.get("to_time"),
        "hours": d.get("hours"), "activity_type": d.get("activity_type"),
        "project": d.get("project"), "project_identifier": d.get("project_identifier"),
        "project_name": d.get("project_name"), "task": d.get("task"), "task_subject": d.get("task_subject"),
        "description": d.get("description"), "is_billable": d.get("is_billable"),
        "minutes_of_meeting": d.get("custom_minutes_of_meeting"), "workstream": d.get("workstream"),
        "user": d.get("user"), "user_full_name": d.get("user_full_name"),
    }


# =============================================================== reads

def list_projects(api, st, status="Open", search=None, include_archived=False, limit=None) -> dict:
    rows = api.projects(include_archived=include_archived)
    if status and status.lower() != "all":
        rows = [r for r in rows if (r.get("status") or "").lower() == status.lower()]
    if search:
        s = search.lower()
        rows = [r for r in rows if any(s in str(r.get(f) or "").lower()
                                       for f in ("custom_identifier", "name", "project_name"))]
    sel = (config.project_ctx(st) or {}).get("identifier")
    shown, total = window(rows, limit)
    return {"fetched_at": now_stamp(), "status": status, "search": search, "count": len(shown), "total": total,
            "projects": [norm_project(r, sel) for r in shown]}


def _match_statuses(given: list, valid: list) -> list:
    by_lower = {v.lower(): v for v in valid}
    bad = [s for s in given if s.lower() not in by_lower]
    if bad:
        raise BBError("bad_input", f"Unknown status {', '.join(bad)}.", valid=valid)
    return [by_lower[s.lower()] for s in given]


def status_vocab(api, identifier: str, doctype: str) -> dict:
    """The one status vocabulary `identifier` uses for `doctype` ("Task" or "Issue"), chosen by the project's
    custom_status_type exactly as the backend does (project_helpers.status_fieldname): "Custom" means the
    project's own ordered stages, stored in custom_task_status / custom_issue_status (the backend derives the
    native status from each stage's native_status and refuses writes to `status`); "Default" means the standard
    ERPNext statuses, stored in `status`. The two are never mixed."""
    meta = api.project_status_meta(identifier)
    if meta.get("status_type") == "Custom":
        rows = [r for r in meta.get(STATUS_ROWS[doctype]) or [] if r.get("status")]
        return {"type": "Custom", "field": STATUS_FIELD[doctype], "statuses": [r["status"] for r in rows],
                "native": {r["status"]: r.get("native_status") for r in rows}}
    statuses = (api.task_meta() if doctype == "Task" else api.ticket_meta()).get("statuses") or []
    return {"type": "Default", "field": "status", "statuses": statuses, "native": {s: s for s in statuses}}


def stage_of(row: dict, vocab: dict) -> str | None:
    """The status a record shows in its project's vocabulary."""
    return row.get(vocab["field"]) or row.get("status")


def native_of(row: dict, vocab: dict) -> str | None:
    """The record's native status, read through its custom stage's mapping in Custom mode: the stored `status`
    can lag behind a stage set before the backend derived it."""
    return vocab["native"].get(row.get(vocab["field"])) or row.get("status")


def _resolve_statuses(given: list, vocab: dict, doctype: str) -> list:
    """`given` matched against the project's vocabulary. On a Custom project, a standard status names the stages
    mapped to it as `candidates`, so the caller can ask which one instead of guessing."""
    try:
        return _match_statuses(given, vocab["statuses"])
    except BBError as e:
        if vocab["type"] != "Custom":
            raise
        bad = [s for s in given if s.lower() not in {v.lower() for v in vocab["statuses"]}]
        stages = [s for s, n in vocab["native"].items() if (n or "").lower() in {b.lower() for b in bad}]
        hint = f" Stages mapped to {', '.join(bad)}: {', '.join(stages)}." if stages else ""
        raise BBError("bad_input", f"This project uses custom {doctype.lower()} statuses; {', '.join(bad)} "
                                   f"{'is' if len(bad) == 1 else 'are'} not among them.{hint}",
                      valid=vocab["statuses"], status_type="Custom",
                      **({"candidates": stages} if stages else {})) from e


def list_tasks(api, st, project=None, status=None, include_closed=False, mine=False, search=None, cycle=None,
               subtasks=False, limit=None) -> dict:
    ident = need_project(st, project)
    vocab = status_vocab(api, ident, "Task")
    wanted = _resolve_statuses(split_csv(status), vocab, "Task")
    rows = api.tasks(ident, include_subtasks=subtasks)
    if wanted:
        rows = [r for r in rows if stage_of(r, vocab) in wanted]
    elif not include_closed:
        rows = [r for r in rows if native_of(r, vocab) in OPEN_TASK]
    if mine:
        me = current_user(api, st)
        rows = [r for r in rows if me in _assignees(r.get("custom_assignees"))[0]]
    if cycle:
        c = cycle.lower()
        rows = [r for r in rows if c in [x.lower() for x in (r.get("cycle_ids") or [])]
                or c in [str(x).lower() for x in (r.get("custom_cycles") or [])]]
    if search:
        s = search.lower()
        rows = [r for r in rows if s in str(r.get("name") or "").lower() or s in str(r.get("subject") or "").lower()
                or s in strip_html(r.get("description") or "").lower()]
    rows.sort(key=lambda r: (PRIORITY_RANK.get(r.get("priority"), 9), r.get("exp_end_date") or "9999-12-31"))
    shown, total = window(rows, limit)
    sel = (st.get("task") or {}).get("name")
    return {"fetched_at": now_stamp(), "project": ident, "project_label": project_label(st, ident),
            "status": wanted or ("default open" if not include_closed else "all"), "status_type": vocab["type"],
            "statuses": vocab["statuses"], "cycle": cycle, "mine": mine, "search": search, "count": len(shown),
            "total": total, "tasks": [norm_task(r, sel, vocab) for r in shown]}


def list_tickets(api, st, project=None, status=None, include_closed=False, priority=None, search=None,
                 limit=None) -> dict:
    ident = need_project(st, project)
    vocab = status_vocab(api, ident, "Issue")
    wanted = _resolve_statuses(split_csv(status), vocab, "Issue")
    prios = split_csv(priority)
    # get_tickets filters on ONE native status and ONE priority; anything else is filtered here.
    server_status = wanted[0] if len(wanted) == 1 and vocab["type"] == "Default" else None
    server_prio = prios[0] if len(prios) == 1 else None
    rows = api.tickets(ident, status=server_status, priority=server_prio)
    if wanted and not server_status:
        rows = [r for r in rows if stage_of(r, vocab) in wanted]
    elif not wanted and not include_closed:
        rows = [r for r in rows if native_of(r, vocab) in OPEN_ISSUE]
    if prios and not server_prio:
        lp = {p.lower() for p in prios}
        rows = [r for r in rows if (r.get("priority") or "").lower() in lp]
    if search:
        s = search.lower()
        rows = [r for r in rows if s in str(r.get("name") or "").lower() or s in str(r.get("subject") or "").lower()
                or s in strip_html(r.get("description") or "").lower()]
    rows.sort(key=lambda r: r.get("creation") or "", reverse=True)
    rows.sort(key=lambda r: PRIORITY_RANK.get(r.get("priority"), 9))  # stable: newest first per priority
    shown, total = window(rows, limit)
    sel = {t["name"] for t in st.get("tickets") or [] if t.get("name")}
    return {"fetched_at": now_stamp(), "project": ident, "project_label": project_label(st, ident),
            "status": wanted or ("default open" if not include_closed else "all"), "status_type": vocab["type"],
            "statuses": vocab["statuses"], "priority": prios or None, "search": search, "count": len(shown),
            "total": total, "tickets": [norm_ticket(r, sel, vocab) for r in shown]}


def list_cycles(api, st, project=None, status=None, search=None, limit=None) -> dict:
    ident = need_project(st, project)
    rows = api.cycles(ident)
    if status:
        rows = [r for r in rows if (r.get("status") or "").lower() == status.lower()]
    if search:
        s = search.lower()
        rows = [r for r in rows if s in str(r.get("cycle_name") or "").lower() or s in str(r.get("name")).lower()]
    shown, total = window(rows, limit)
    return {"fetched_at": now_stamp(), "project": ident, "project_label": project_label(st, ident),
            "status": status, "count": len(shown), "total": total, "cycles": shown}


def _reachable_identifiers(api) -> list:
    return [p["custom_identifier"] for p in api.projects() if p.get("custom_identifier")]


def list_moms(api, st, project=None, all_projects=False, search=None, limit=None) -> dict:
    idents = _reachable_identifiers(api) if all_projects else [need_project(st, project)]
    rows, skipped = [], []
    for ident in idents:
        try:
            for r in api.minutes(ident):
                r["project_identifier"] = ident
                rows.append(r)
        except BBError as e:
            if not all_projects or e.code not in ("forbidden", "not_found"):
                raise
            skipped.append({"project": ident, "error": e.code})
    if search:
        s = search.lower()
        rows = [r for r in rows if any(s in str(r.get(f) or "").lower()
                                       for f in ("name", "meeting_topic", "meeting_type", "location"))]
    rows.sort(key=lambda r: (r.get("from_time") or "", r.get("creation") or ""), reverse=True)
    shown, total = window(rows, limit)
    out = {"fetched_at": now_stamp(), "scope": "all projects" if all_projects else idents[0],
           "count": len(shown), "total": total, "moms": shown}
    if not all_projects:
        out["project_label"] = project_label(st, idents[0])
    if skipped:
        out["skipped_projects"] = skipped
    return out


def list_logs(api, st, project=None, since=None, until=None, all_users=False, billable=None, status=None,
              limit=None) -> dict:
    rows = api.timesheet_logs(user="all" if all_users else "me", identifier=project,
                              from_date=parse_day(since).isoformat() if since else None,
                              to_date=parse_day(until).isoformat() if until else None,
                              is_billable=None if billable is None else int(billable))
    logs = [norm_log(r) for r in rows]
    if status:
        logs = [x for x in logs if (x["status"] or "").lower() == status.lower()]
    else:
        logs = [x for x in logs if x["status"] != "Cancelled"]  # hide cancelled unless asked
    shown, total = window(logs, limit)
    return {"fetched_at": now_stamp(), "user": "all" if all_users else "me", "project": project,
            "since": since, "until": until, "count": len(shown), "total": total,
            "total_hours": round(sum(float(x["hours"] or 0) for x in shown), 2), "logs": shown}


def activity_types(api) -> dict:
    return {"activity_types": api.activity_types()}


def users(api, st, project=None, search=None, workspace=False) -> dict:
    if workspace:
        rows = [{"user": u.get("name"), "full_name": u.get("full_name")} for u in api.members()]
        scope = "workspace"
    else:
        ident = need_project(st, project)
        rows = [{"user": u.get("user"), "full_name": u.get("full_name")} for u in api.project(ident).get("users") or []]
        scope = ident
    if search:
        s = search.lower()
        rows = [u for u in rows if s in str(u["user"]).lower() or s in str(u["full_name"] or "").lower()]
    return {"scope": scope, "count": len(rows), "users": rows}


# ---------------------------------------------------------------- single records

def _find_project_of(api, doc_type: str, name: str) -> str | None:
    """Brewboard's search endpoint matches task / ticket IDs and names their project identifier."""
    for r in api.search(name):
        if r.get("type") == doc_type and r.get("name") == name and r.get("subtitle"):
            return r["subtitle"]
    return None


def _scoped_get(api, st, doc_type, name, project, fetch):
    ident = project or (config.project_ctx(st) or {}).get("identifier")
    if ident:
        try:
            return ident, fetch(ident)
        except BBError as e:
            if e.code != "not_found" or project:
                raise
    found = _find_project_of(api, doc_type, name)
    if not found or found == ident:
        raise BBError("not_found", f"{name} not found in your reachable projects")
    return found, fetch(found)


def get_task(api, st, name, project=None) -> dict:
    ident, t = _scoped_get(api, st, "task", name, project, lambda i: api.task(i, name))
    vocab = status_vocab(api, ident, "Task")
    out = norm_task(t, (st.get("task") or {}).get("name"), vocab)
    out.update({"project_identifier": ident, "status_type": vocab["type"], "status_field": vocab["field"],
                "statuses": vocab["statuses"], "description": t.get("description"), "issue": t.get("issue"),
                "minutes_of_meeting": t.get("custom_minutes_of_meeting"), "owner": t.get("owner"),
                "owner_full_name": t.get("owner_full_name"), "completed_by": t.get("completed_by"),
                "completed_on": t.get("completed_on"), "creation": t.get("creation")})
    return out


def get_ticket(api, st, name, project=None) -> dict:
    ident, t = _scoped_get(api, st, "ticket", name, project, lambda i: api.ticket(i, name))
    vocab = status_vocab(api, ident, "Issue")
    out = norm_ticket(t, {x["name"] for x in st.get("tickets") or [] if x.get("name")}, vocab)
    out.update({"project_identifier": ident, "status_type": vocab["type"], "status_field": vocab["field"],
                "statuses": vocab["statuses"], "description": t.get("description"),
                "resolution_details": t.get("resolution_details"), "creation": t.get("creation"),
                "linked_tasks": api.linked_tasks(name)})
    return out


def get_project(api, st, identifier) -> dict:
    p = api.project(identifier)
    out = norm_project(p, (config.project_ctx(st) or {}).get("identifier"))
    out["notes"] = p.get("notes")
    try:
        out["cycles"] = api.cycles(identifier)
    except BBError as e:
        if e.code != "forbidden":
            raise
        out["cycles"], out["cycles_note"] = None, "Your role cannot read cycles."
    return out


def get_cycle(api, st, cycle_id) -> dict:
    c = api.cycle(cycle_id)
    tasks = c.get("tasks") or []
    c["project_identifier"] = tasks[0].get("project") if tasks else None
    return c


def get_mom(api, st, name, project=None) -> dict:
    ident = need_project(st, project)
    m = api.minutes_meeting(ident, name)
    m["project_identifier"] = ident
    return m


def get_timesheet(api, st, name) -> dict:
    """No single-timesheet endpoint exists; the timesheet's rows come from get_timesheet_logs."""
    logs = [norm_log(r) for r in api.timesheet_logs(user="me") if r.get("timesheet") == name]
    if not logs:
        try:
            logs = [norm_log(r) for r in api.timesheet_logs(user="all") if r.get("timesheet") == name]
        except BBError as e:
            if e.code != "forbidden":
                raise
    if not logs:
        raise BBError("not_found", f"Timesheet {name} has no time logs you can read")
    return {"timesheet": name, "status": logs[0]["status"], "user": logs[0]["user"],
            "total_hours": round(sum(float(x["hours"] or 0) for x in logs), 2), "logs": logs}


def get_record(api, st, doctype, name, project=None) -> dict:
    dt = doctype_of(doctype)
    if dt == "Task":
        return get_task(api, st, name, project)
    if dt == "Issue":
        return get_ticket(api, st, name, project)
    if dt == "Project":
        return get_project(api, st, name)
    if dt == "Cycle":
        return get_cycle(api, st, name)
    if dt == MOM:
        return get_mom(api, st, name, project)
    if dt == "Timesheet":
        return get_timesheet(api, st, name)
    raise unsupported(f"reading {dt} records", "Supported: project, task, issue, cycle, mom, timesheet.")


# =============================================================== attachments

def _safe_name(name: str, taken: set) -> str:
    base = re.sub(r"[^\w.\- ]+", "_", Path(name or "file").name).strip(" .") or "file"
    stem, dot, ext = base.rpartition(".")
    cand, n = base, 1
    while cand in taken:
        n += 1
        cand = f"{stem}-{n}.{ext}" if dot else f"{base}-{n}"
    taken.add(cand)
    return cand


def attachments(api, doctype, name, download_dir=None) -> dict:
    dt = doctype_of(doctype)
    if dt not in ("Task", "Issue"):
        raise unsupported(f"attachments on {dt}", "Brewboard serves attachments for tasks and tickets only.")
    rows = api.attachments(dt, name)
    out = {"doctype": dt, "name": name, "count": len(rows), "attachments": rows}
    if download_dir:
        target = Path(download_dir).expanduser()
        target.mkdir(parents=True, exist_ok=True)
        taken = {p.name for p in target.iterdir()}
        for row in rows:
            try:
                content, fname = api.download_attachment(file_name=row.get("name"))
                path = target / _safe_name(fname or row.get("file_name") or row.get("name"), taken)
                path.write_bytes(content)
                row["local_path"] = str(path)
            except BBError as e:
                row["download_error"] = f"{e.code}: {e.message}"
    return out


def download(api, url, download_dir) -> dict:
    """Fetch a file a task / ticket description points at, through download_attachment."""
    site = api.site
    path = url
    if url.startswith(("http://", "https://")):
        if not url.startswith(site + "/"):
            raise BBError("bad_input", "Only files on the Brewboard site can be fetched with bb.py; credentials "
                                       "are never sent to other hosts. Download public external URLs directly.")
        path = url[len(site):]
    if not path.startswith(("/files/", "/private/files/")):
        raise BBError("bad_input", "Expected a /files/... or /private/files/... URL")
    content, fname = api.download_attachment(file_url=path)
    target = Path(download_dir).expanduser()
    target.mkdir(parents=True, exist_ok=True)
    dest = target / _safe_name(fname or path.split("?")[0].rsplit("/", 1)[-1], {p.name for p in target.iterdir()})
    dest.write_bytes(content)
    return {"file_url": path, "local_path": str(dest), "bytes": len(content)}


# =============================================================== writes

def create_task(api, st, subject, project=None, description=None, priority="Medium", status=None, start=None,
                due=None, issue=None, parent=None, assign_to_me=True) -> dict:
    ident = need_project(st, project)
    if not (subject or "").strip():
        raise BBError("bad_input", "Task subject is required")
    vocab = status_vocab(api, ident, "Task")
    # No status: native Open, which a Custom project maps to its first Open stage.
    stage = _resolve_statuses([status], vocab, "Task")[0] if status else None
    custom = stage if vocab["type"] == "Custom" else None
    assignees = [{"user": current_user(api, st)}] if assign_to_me else []
    t = api.create_task(ident, subject.strip(), status=vocab["native"].get(stage) or "Open",
                        custom_task_status=custom, priority=priority, assignees=assignees or None,
                        exp_start_date=parse_day(start).isoformat() if start else None,
                        exp_end_date=parse_day(due).isoformat() if due else None,
                        description=description or None, parent_task=parent, issue=issue)
    return {"task": norm_task(t, vocab=vocab), "project_identifier": ident}


def _day_logs(api, day: date) -> list:
    rows = api.timesheet_logs(user="me", from_date=day.isoformat(), to_date=day.isoformat())
    return [norm_log(r) for r in rows if r.get("docstatus") != 2]


def next_free_slot(logs: list, day: date) -> datetime:
    """Start of the first free slot after the day's existing logs (09:00 if none)."""
    latest = datetime.combine(day, time(9, 0))
    for log in logs:
        if not log["from_time"] or not log["to_time"]:
            continue
        start, end = parse_dt(log["from_time"]), parse_dt(log["to_time"])
        if start.date() <= day <= end.date() and end > latest:
            latest = end
    return latest


def log_time(api, st, hours, activity, desc, task=None, new_task=None, project=None, day=None, from_time=None,
             billable=False, meeting=None, workstream=None, task_desc=None, allow_duplicate=False) -> dict:
    if sum(bool(x) for x in (task, new_task)) != 1:
        raise BBError("bad_input", "Pass exactly one of --task <ID> or --new-task \"<subject>\" "
                                   "(the Brewboard API requires a task for every time log)")
    if not (desc or "").strip():
        raise BBError("bad_input", "A description is required")
    h = parse_hours(hours)
    if not 0 < h <= 24:
        raise BBError("bad_input", "Hours must be between 0 and 24")
    d = parse_day(day)
    valid = api.activity_types()
    if activity not in valid:
        match = next((v for v in valid if v.lower() == str(activity).lower()), None)
        if not match:
            raise BBError("bad_input", f"Unknown activity type '{activity}'", valid=valid)
        activity = match

    if task:
        t = get_task(api, st, task, project)
        ident = t["project_identifier"]
        task_subject = t["subject"]
    else:
        ident, task_subject = need_project(st, project), new_task

    logs = _day_logs(api, d)
    if task and not allow_duplicate:
        for x in logs:
            if x["task"] == task and abs(float(x["hours"] or 0) - h) < 1e-6 and \
                    (x["description"] or "").strip().lower() == desc.strip().lower():
                raise BBError("possible_duplicate", f"An identical {h:g}h log on {task} already exists for "
                                                    f"{d.isoformat()}; nothing was created. Pass --allow-duplicate "
                                                    "if it is really a second entry.",
                              existing={"timesheet": x["timesheet"], "entry": x["entry"], "from": x["from_time"]})
    start = datetime.combine(d, parse_clock(from_time)) if from_time else next_free_slot(logs, d)
    end = start + timedelta(hours=h)
    if end.date() != d and end != datetime.combine(d + timedelta(days=1), time(0, 0)):
        raise BBError("bad_input", f"{h:g}h from {start:%H:%M} runs past midnight; pass an earlier --from")

    created_task, warnings = None, []
    if new_task:
        t = api.create_task(ident, new_task.strip(), status="Working", priority="Medium",
                            assignees=[{"user": current_user(api, st)}], exp_start_date=d.isoformat(),
                            description=task_desc or desc)
        task, created_task = t["name"], {"name": t["name"], "subject": t.get("subject")}
    try:
        ts = api.create_log(project_identifier=ident, task_name=task, from_time=fmt_dt(start), to_time=fmt_dt(end),
                            hours=round(h, 4), description=desc, is_billable=1 if billable else 0,
                            activity_type=activity, minutes_of_meeting=meeting, workstream=workstream)
    except BBError as e:
        if created_task:
            e.extra["task_created"] = created_task
        raise
    entry, status = None, None
    try:
        mine = [x for x in _day_logs(api, d) if x["timesheet"] == ts]
        if mine:
            entry, status = mine[0]["entry"], mine[0]["status"]
        else:
            warnings.append(f"{ts} was created but its log is not visible yet in get_timesheet_logs.")
    except BBError as e:
        warnings.append(f"{ts} was created; reading it back failed ({e.code}).")
    return {"timesheet": ts, "entry": entry, "status": status, "date": d.isoformat(),
            "from": start.strftime("%H:%M"), "to": end.strftime("%H:%M"), "hours": round(h, 4),
            "activity_type": activity, "project": ident, "task": task, "task_subject": task_subject,
            "task_created": created_task, "description": desc, "is_billable": bool(billable),
            "minutes_of_meeting": meeting, "warnings": warnings}


def update_log(api, st, entry, changes: dict) -> dict:
    """Edit one of your own draft time logs (update_timesheet_log sends the whole row)."""
    rows = [r for r in api.timesheet_logs(user="me") if r.get("name") == entry]
    if not rows:
        raise BBError("not_found", f"Time entry {entry} is not one of your logs")
    cur = rows[0]
    if cur.get("docstatus") != 0:
        raise BBError("validation_error", f"{cur.get('timesheet')} is {DOCSTATUS.get(cur.get('docstatus'))}; "
                                          "Brewboard only allows editing draft time logs.")
    ch = {LOG_ALIASES.get(k, k): v for k, v in changes.items()}
    bad = sorted(set(ch) - LOG_FIELDS)
    if bad:
        raise BBError("bad_input", f"Cannot change {', '.join(bad)} on a time log", valid=sorted(LOG_FIELDS))
    row = {"project_identifier": cur.get("project_identifier"), "task_name": cur.get("task"),
           "from_time": cur.get("from_time"), "to_time": cur.get("to_time"), "hours": cur.get("hours"),
           "description": cur.get("description"), "is_billable": cur.get("is_billable") or 0,
           "activity_type": cur.get("activity_type"), "minutes_of_meeting": cur.get("custom_minutes_of_meeting"),
           "workstream": cur.get("workstream")}
    if "hours" in ch:
        ch["hours"] = round(parse_hours(ch["hours"]), 4)
    row.update(ch)
    if ("hours" in ch or "from_time" in ch) and "to_time" not in ch:
        row["to_time"] = fmt_dt(parse_dt(row["from_time"]) + timedelta(hours=float(row["hours"])))
    row["is_billable"] = 1 if row["is_billable"] in (1, "1", True, "true", "yes") else 0
    before = {k: v for k, v in norm_log(cur).items()}
    api.update_log(detail_name=entry, **row)
    after = next((norm_log(r) for r in api.timesheet_logs(user="me") if r.get("name") == entry), None)
    changed = {k: {"from": before.get(k), "to": (after or {}).get(k)}
               for k in ("from_time", "to_time", "hours", "description", "activity_type", "task",
                         "is_billable", "project_identifier", "minutes_of_meeting")
               if after and before.get(k) != after.get(k)}
    return {"entry": entry, "timesheet": cur.get("timesheet"), "changed": changed}


def _status_change(ch: dict, vocab: dict, doctype: str) -> dict:
    """Route a status change to the project's status field. `status` and the custom field name are accepted
    as synonyms; the value must belong to the project's vocabulary. The status goes last, so a resolution or
    an assignee given with it is saved first (closing a ticket needs resolution_details)."""
    given = {f: ch[f] for f in ("status", STATUS_FIELD[doctype]) if f in ch}
    if len({str(v).lower() for v in given.values()}) > 1:
        raise BBError("bad_input", f"Two different statuses given ({', '.join(map(str, given.values()))}); "
                                   "pass one")
    if vocab["type"] == "Default" and STATUS_FIELD[doctype] in given:
        raise BBError("bad_input", f"This project uses the standard {doctype.lower()} statuses: set status, not "
                                   f"{STATUS_FIELD[doctype]}", valid=vocab["statuses"], status_type="Default")
    value = _resolve_statuses([str(next(iter(given.values())))], vocab, doctype)[0]
    rest = {k: v for k, v in ch.items() if k not in given}
    return {**rest, vocab["field"]: value}


def update_record(api, st, doctype, name, changes: dict, completed_by=None, project=None) -> dict:
    dt = doctype_of(doctype)
    if not changes:
        raise BBError("bad_input", "Nothing to change: pass --set field=value, --data JSON or --file path")
    if dt == "Timesheet Detail":
        return update_log(api, st, name, changes)
    if dt == "Timesheet":
        raise BBError("bad_input", "Time logs are edited one entry at a time: bb.py update log <ENTRY> --set ... "
                                   "(the entry ID is in bb.py timesheets)")
    if dt == MOM:
        return update_mom(api, st, name, changes, project)
    if dt not in ("Task", "Issue"):
        raise unsupported(f"updating {dt} records")
    allowed = TASK_FIELDS if dt == "Task" else TICKET_FIELDS
    aliases = {"assignees": "custom_assignees", "due": "exp_end_date", "start": "exp_start_date",
               "target_date": "custom_target_date"}
    ch = {aliases.get(k, k): v for k, v in changes.items()}
    bad = sorted(set(ch) - allowed)
    if bad:
        raise BBError("bad_input", f"Brewboard does not allow changing {', '.join(bad)} on {dt}",
                      valid=sorted(allowed))
    before = get_task(api, st, name, project) if dt == "Task" else get_ticket(api, st, name, project)
    vocab = None
    if {"status", STATUS_FIELD[dt]} & set(ch):
        vocab = status_vocab(api, before["project_identifier"], dt)
        ch = _status_change(ch, vocab, dt)
        native = vocab["native"].get(ch[vocab["field"]])
        if dt == "Task" and native == "Completed" and not completed_by:
            raise BBError("bad_input", f"'{ch[vocab['field']]}' completes the task, which needs --completed-by "
                                       "<user> (Brewboard records who did it)")
    applied, result = [], None
    for field, value in ch.items():  # the endpoints patch one field per call
        if isinstance(value, list) and field == "custom_assignees":
            value = json.dumps([v if isinstance(v, dict) else {"user": v} for v in value])
        try:
            if dt == "Task":
                result = api.update_task(name, field, value, completed_by=completed_by if field in
                                         ("status", "custom_task_status") else None)
            else:
                result = api.update_ticket(name, field, value)
        except BBError as e:
            e.extra["applied"] = applied or None
            e.extra["failed_field"] = field
            raise
        applied.append(field)
    after = norm_task(result, vocab=vocab) if dt == "Task" else norm_ticket(result, vocab=vocab)
    shown = {"custom_assignees": "assigned_to", "exp_end_date": "exp_end_date", "custom_target_date": "target_date"}
    changed = {}
    for f in applied:
        k = shown.get(f, f)
        if before.get(k) != after.get(k):
            changed[k] = {"from": before.get(k), "to": after.get(k)}
    return {"doctype": dt, "name": name, "changed": changed, "status": after.get("status")}


# The backend's @mention pattern (helpers/comment_helpers.py MENTION_PATTERN): a name, then any following words
# that start with a capital. Matching is by full name against the project's members only.
MENTION = re.compile(r"@([A-Za-z]\w*(?:\s[A-Z]\w*)*)")


def add_comment(api, st, doctype, name, content, project=None) -> dict:
    """Comment on a task or ticket. Every @mention must name exactly one project member, or nothing is posted:
    Brewboard silently notifies nobody for a mention it cannot resolve."""
    dt = doctype_of(doctype)
    if dt not in ("Task", "Issue"):
        raise unsupported(f"comments on {dt} records", "Brewboard takes comments on tasks and tickets only.")
    content = (content or "").strip()
    if not content:
        raise BBError("bad_input", "The comment is empty")
    kind = "task" if dt == "Task" else "ticket"
    ident, _rec = _scoped_get(api, st, kind, name, project,
                              lambda i: api.task(i, name) if dt == "Task" else api.ticket(i, name))
    mentions = list(dict.fromkeys(MENTION.findall(content)))
    tagged = []
    if mentions:
        members = defaultdict(list)
        for m in api.project(ident).get("users") or []:
            if m.get("user"):
                members[m.get("full_name") or m["user"]].append(m["user"])
        bad = [m for m in mentions if len(members.get(m, [])) != 1]
        if bad:
            raise BBError("bad_input", f"@{', @'.join(bad)} would notify nobody: a mention is a project member's "
                                       "full name, followed by punctuation or a lowercase word (the next capitalised "
                                       "word counts as part of the name). Nothing was posted.",
                          valid=sorted(n for n, users in members.items() if len(users) == 1))
        tagged = [members[m][0] for m in mentions]
    c = api.add_task_comment(name, content) if dt == "Task" else api.add_ticket_comment(name, content)
    return {"doctype": dt, "name": name, "project_identifier": ident, "comment": c.get("name"),
            "author": c.get("full_name") or c.get("owner"), "created": c.get("creation"),
            "content": c.get("content") or content, "mentions": tagged}


def delete_record(api, st, doctype, name, project=None) -> dict:
    dt = doctype_of(doctype)
    if dt != MOM:
        raise unsupported(f"deleting {dt} records", "Only minutes of meeting can be deleted through the API.")
    ident = need_project(st, project)
    api.delete_minutes(ident, name)
    return {"deleted": True, "doctype": dt, "name": name, "project": ident}


# ---------------------------------------------------------------- minutes of meeting

MOM_INPUT_KEYS = set(MOM_SCALARS) | set(MOM_TABLES) | {"project", "title", "date", "meeting_date", "start_time",
                                                       "end_time"}
MOM_REJECTED = {
    "agenda": "Brewboard minutes have no agenda field; put agenda points in `minutes` (topics) or `meeting_notes`.",
    "discussion": "Brewboard minutes have no discussion field; use `minutes` (a list of discussion points) "
                  "and `meeting_notes` for free text.",
}


def _when(d: dict) -> tuple[str | None, str | None]:
    day = d.get("date") or d.get("meeting_date")
    if d.get("from_time") or d.get("to_time"):
        start = parse_dt(d["from_time"]) if d.get("from_time") else None
        end = parse_dt(d["to_time"]) if d.get("to_time") else None
    elif day:
        dd = parse_day(day)
        start = datetime.combine(dd, parse_clock(d["start_time"])) if d.get("start_time") else None
        end = datetime.combine(dd, parse_clock(d["end_time"])) if d.get("end_time") else None
        if not start:
            raise BBError("bad_input", "A meeting date needs a start_time (Brewboard stores the meeting as "
                                       "from_time / to_time)")
    else:
        return None, None
    if start and end and end <= start:
        raise BBError("bad_input", "to_time must be after from_time")
    return (fmt_dt(start) if start else None), (fmt_dt(end) if end else None)


def normalize_mom(data, members: dict, meeting_types: list) -> tuple[dict, list]:
    """The skill's MoM JSON -> create_minutes fields. Returns (fields, warnings)."""
    if not isinstance(data, dict):
        raise BBError("bad_input", "MoM JSON must be an object")
    for key, why in MOM_REJECTED.items():
        if data.get(key):
            raise BBError("bad_input", why)
    unknown = sorted(set(data) - MOM_INPUT_KEYS - set(MOM_REJECTED))
    if unknown:
        raise BBError("bad_input", f"Unknown MoM field(s): {', '.join(unknown)}", valid=sorted(MOM_INPUT_KEYS))
    warnings = []
    topic = (data.get("meeting_topic") or data.get("title") or "").strip()
    if not topic:
        raise BBError("bad_input", "meeting_topic is required")
    out = {"meeting_topic": topic}
    out["from_time"], out["to_time"] = _when(data)
    if data.get("meeting_type"):
        mt = next((m for m in meeting_types if m.lower() == str(data["meeting_type"]).lower()), None)
        if not mt:
            raise BBError("bad_input", f"Unknown meeting_type '{data['meeting_type']}'", valid=meeting_types)
        out["meeting_type"] = mt
    if data.get("location"):
        out["location"] = str(data["location"]).strip()[:DATA_MAX]
    out["meeting_notes"] = text_html(data.get("meeting_notes"))
    out["assessment_observations"] = text_html(data.get("assessment_observations"))
    out["decisions"] = text_html(data.get("decisions"), ordered=True)

    by_name = {str(v).lower(): k for k, v in members.items() if v}
    att, ext = [], []
    for a in data.get("attendees") or []:
        user = a.get("user") if isinstance(a, dict) else (a if isinstance(a, str) and "@" in a else None)
        if not user and isinstance(a, str) and a.lower() in by_name:
            user = by_name[a.lower()]
        if user:
            if members and user not in members:
                warnings.append(f"Attendee {user} is not a member of this project.")
            att.append({"user": user})
            continue
        if isinstance(a, dict):
            name = a.get("full_name") or a.get("attendee_name")
            if not name:
                raise BBError("bad_input", f"Attendee {a} needs `user` or `full_name`")
            ext.append({"full_name": name, "email": a.get("email"), "organisation": a.get("organisation")})
        else:
            ext.append({"full_name": str(a)})
    for a in data.get("external_attendees") or []:
        a = {"full_name": a} if isinstance(a, str) else a
        if not a.get("full_name"):
            raise BBError("bad_input", "Each external attendee needs full_name")
        ext.append({"full_name": a["full_name"], "email": a.get("email"), "organisation": a.get("organisation")})
    out["attendees"], out["external_attendees"] = att, ext

    points = []
    for p in data.get("minutes") or []:
        topic_line = (p.get("topic") if isinstance(p, dict) else str(p)).strip()
        if len(topic_line) > DATA_MAX:
            raise BBError("bad_input", f"Each minutes point is one line of at most {DATA_MAX} characters: "
                                       f"'{topic_line[:40]}…' is {len(topic_line)}")
        if topic_line:
            points.append({"topic": topic_line})
    out["minutes"] = points

    items = []
    for x in data.get("action_items") or []:
        x = {"actions": x} if isinstance(x, str) else dict(x)
        actions = (x.get("actions") or x.get("description") or "").strip()
        if not actions:
            raise BBError("bad_input", "Each action item needs `actions` (what is to be done)")
        if len(actions) > DATA_MAX:
            raise BBError("bad_input", f"Action item text is limited to {DATA_MAX} characters: '{actions[:40]}…'")
        due = x.get("target_date") or x.get("due_date") or x.get("due")
        row = {"actions": actions, "target_date": parse_day(due).isoformat() if due else None,
               "responsible": x.get("responsible") or x.get("assigned_to") or x.get("owner")}
        if x.get("name"):
            row["name"] = x["name"]
        items.append(row)
    out["action_items"] = items
    return {k: v for k, v in out.items() if v not in (None, "")}, warnings


def _members(api, ident) -> dict:
    return {u.get("user"): u.get("full_name") for u in api.project(ident).get("users") or [] if u.get("user")}


def create_mom(api, st, data, create_tasks=False, allow_duplicate=False) -> dict:
    ident = need_project(st, data.get("project") if isinstance(data, dict) else None)
    members = _members(api, ident)
    fields, warnings = normalize_mom(data, members, api.meeting_meta().get("meeting_types") or [])
    if not allow_duplicate:
        day = (fields.get("from_time") or "")[:10]
        for m in api.minutes(ident):
            if (m.get("meeting_topic") or "").strip().lower() == fields["meeting_topic"].lower() and \
                    (m.get("from_time") or "")[:10] == day:
                raise BBError("possible_duplicate", f"{m['name']} already records '{m['meeting_topic']}' on "
                                                    f"{day or 'no date'}; nothing was created. Pass "
                                                    "--allow-duplicate if this is a different meeting.",
                              existing=m["name"])
    topic = fields.pop("meeting_topic")
    mom = api.create_minutes(ident, topic, **fields)
    created = []
    if create_tasks:
        for row in mom.get("action_items") or []:
            if row.get("task"):
                continue
            owner = row.get("responsible")
            assignees = [owner] if owner in members else []
            if owner and not assignees:
                warnings.append(f"'{owner}' is not a project member user; the task for "
                                f"'{row['actions'][:40]}' was created unassigned.")
            try:
                res = api.task_from_action(ident, mom["name"], row["name"], assignees or None)
            except BBError as e:
                warnings.append(f"Task for action '{row['actions'][:40]}' was not created: {e.message}")
                continue
            created.append({"name": res.get("task"), "subject": row.get("actions"), "assigned_to": assignees,
                            "due_date": row.get("target_date")})
            mom = res.get("minutes") or mom
    return {"mom": mom.get("name"), "meeting_topic": mom.get("meeting_topic"), "project": ident,
            "from_time": mom.get("from_time"), "to_time": mom.get("to_time"),
            "meeting_type": mom.get("meeting_type"),
            "attendees": [a.get("full_name") or a.get("user") for a in mom.get("attendees") or []],
            "external_attendees": [a.get("full_name") for a in mom.get("external_attendees") or []],
            "minutes": [p.get("topic") for p in mom.get("minutes") or []],
            "action_items": mom.get("action_items") or [], "tasks_created": created, "warnings": warnings}


def update_mom(api, st, name, changes: dict, project=None) -> dict:
    ident = need_project(st, project)
    cur = api.minutes_meeting(ident, name)
    merged = {k: cur.get(k) for k in MOM_SCALARS}
    for t in MOM_TABLES:
        merged[t] = None  # untouched tables are not sent, so the server keeps them
    bad = sorted(set(changes) - set(MOM_SCALARS) - set(MOM_TABLES))
    if bad:
        raise BBError("bad_input", f"Cannot change {', '.join(bad)} on minutes",
                      valid=sorted(set(MOM_SCALARS) | set(MOM_TABLES)))
    merged.update(changes)
    topic = merged.pop("meeting_topic") or cur.get("meeting_topic")
    sent = {k: v for k, v in merged.items() if v is not None}
    after = api.update_minutes(ident, name, topic, **sent)
    changed = {k: {"from": cur.get(k), "to": after.get(k)} for k in changes if cur.get(k) != after.get(k)}
    return {"doctype": MOM, "name": name, "project": ident, "changed": changed}


# =============================================================== find

STOPWORDS = set("""a an and are as at be by can did do does for from had has have how i in is it its
me my of on or our that the their this to us was we were what when where which who why will with
about any into did decide decided""".split())
TYPE_KEYS = {"task": "Task", "tasks": "Task", "issue": "Issue", "issues": "Issue", "ticket": "Issue",
             "tickets": "Issue", "mom": MOM, "moms": MOM, "timesheet": "Timesheet", "timesheets": "Timesheet",
             "ts": "Timesheet", "project": "Project", "projects": "Project", "cycle": "Cycle", "cycles": "Cycle"}
SEARCH_TYPES = {"task": "Task", "ticket": "Issue", "project": "Project", "cycle": "Cycle"}


def search_terms(q: str) -> list:
    words = [w.strip(".-") for w in re.findall(r"[\w][\w\-.]*", q.lower())]
    terms = []
    for w in words:
        if w and w not in STOPWORDS and (len(w) > 2 or w.isdigit()) and w not in terms:
            terms.append(w)
    return terms[:6] or [q.strip().lower()]


def snippet(text: str, terms: list, width: int = 140) -> str:
    low = text.lower()
    hits = [low.find(t) for t in terms if t in low]
    if not hits:
        return text[:width]
    s = max(0, min(hits) - 40)
    e = min(len(text), s + width)
    return ("..." if s else "") + text[s:e] + ("..." if e < len(text) else "")


def _score(blob: str, title: str, terms: list) -> tuple[int, float]:
    low = blob.lower()
    matched = sum(1 for t in terms if t in low)
    if not matched:
        return 0, 0.0
    bonus = (2 if len(terms) > 1 and " ".join(terms) in low else 0) + \
        sum(0.5 for t in terms if t in str(title or "").lower())
    return matched, matched + bonus


def _hit(name, title, project, status, when, blob, terms) -> dict | None:
    matched, score = _score(blob, title, terms)
    if not matched:
        return None
    return {"name": name, "title": title, "project": project, "status": status, "date": when,
            "score": score, "snippet": snippet(blob, terms)}


def find(api, st, query, project=None, all_projects=False, types="task,issue,mom,timesheet,project,cycle",
         limit=8, deep=15) -> dict:
    if not (query or "").strip():
        raise BBError("bad_input", "Search query is empty")
    ident = None if all_projects else (project or (config.project_ctx(st) or {}).get("identifier"))
    terms = search_terms(query)
    wanted = []
    for t in split_csv(types):
        if t.lower() not in TYPE_KEYS:
            raise BBError("bad_input", f"Unknown type '{t}'. Use task, issue, mom, timesheet, project, cycle.")
        wanted.append(TYPE_KEYS[t.lower()])
    results, coverage = {dt: [] for dt in wanted}, {}

    if not ident and ({"Task", "Issue", "Cycle"} & set(wanted)):
        found = defaultdict(dict)  # Brewboard's global search: one call per keyword
        for term in terms:
            for r in api.search(term):
                dt = SEARCH_TYPES.get(r.get("type"))
                if dt in ("Task", "Issue", "Cycle") and dt in wanted:
                    found[dt].setdefault(r["name"], r)
        for dt, rows in found.items():
            for r in rows.values():
                h = _hit(r["name"], r.get("title"), r.get("subtitle"), None, None,
                         f"{r['name']} {r.get('title') or ''}", terms)
                if h:
                    results[dt].append(h)
        for dt in ("Task", "Issue", "Cycle"):
            if dt in wanted:
                coverage[dt] = ("Brewboard global search: names/subjects only, at most 5 matches per keyword "
                                "across all your projects")
    if ident and "Task" in wanted:
        for r in api.tasks(ident, include_subtasks=True):
            blob = strip_html(f"{r.get('name')} | {r.get('subject') or ''} | {r.get('description') or ''}")
            h = _hit(r["name"], r.get("subject"), ident, r.get("status"), r.get("exp_end_date"), blob, terms)
            if h:
                results["Task"].append(h)
        coverage["Task"] = f"all tasks in {ident}: ID, subject, description"
    if ident and "Issue" in wanted:
        for r in api.tickets(ident):
            blob = strip_html(f"{r.get('name')} | {r.get('subject') or ''} | {r.get('description') or ''}")
            h = _hit(r["name"], r.get("subject"), ident, r.get("status"), (r.get("creation") or "")[:10], blob, terms)
            if h:
                results["Issue"].append(h)
        coverage["Issue"] = f"all tickets in {ident} you can read: ID, subject, description"
    if ident and "Cycle" in wanted:
        try:
            for r in api.cycles(ident):
                blob = f"{r.get('name')} | {r.get('cycle_name') or ''} | {r.get('description') or ''}"
                h = _hit(r["name"], r.get("cycle_name"), ident, r.get("status"), r.get("start_date"), blob, terms)
                if h:
                    results["Cycle"].append(h)
            coverage["Cycle"] = f"all cycles in {ident}: name, description"
        except BBError as e:
            if e.code != "forbidden":
                raise
            coverage["Cycle"] = "not searched: your role cannot read cycles"
    if "Project" in wanted:
        for r in api.projects():
            blob = f"{r.get('custom_identifier') or ''} | {r.get('project_name') or ''} | {r.get('notes') or ''}"
            h = _hit(r.get("custom_identifier") or r["name"], r.get("project_name"), r.get("custom_identifier"),
                     r.get("status"), r.get("expected_end_date"), strip_html(blob), terms)
            if h:
                results["Project"].append(h)
        coverage["Project"] = "all your projects: identifier, name, notes"
    if MOM in wanted:
        idents = [ident] if ident else _reachable_identifiers(api)
        rows = []
        for i in idents:
            try:
                rows += [dict(r, project_identifier=i) for r in api.minutes(i)]
            except BBError as e:
                if e.code not in ("forbidden", "not_found") or ident:
                    raise
        rows.sort(key=lambda r: r.get("from_time") or "", reverse=True)
        opened = 0
        for r in rows:
            blob = f"{r['name']} | {r.get('meeting_topic') or ''} | {r.get('meeting_type') or ''} | {r.get('location') or ''}"
            if opened < deep:  # full text only for the most recent `deep` minutes
                m = api.minutes_meeting(r["project_identifier"], r["name"])
                opened += 1
                blob += " | " + " | ".join(
                    [strip_html(m.get(f) or "") for f in ("meeting_notes", "decisions", "assessment_observations")] +
                    [p.get("topic") or "" for p in m.get("minutes") or []] +
                    [a.get("actions") or "" for a in m.get("action_items") or []] +
                    [a.get("full_name") or "" for a in (m.get("attendees") or []) + (m.get("external_attendees") or [])])
            h = _hit(r["name"], r.get("meeting_topic"), r["project_identifier"], None,
                     (r.get("from_time") or "")[:10] or None, blob, terms)
            if h:
                results[MOM].append(h)
        coverage[MOM] = (f"{len(rows)} minutes by topic/type/location; full text (notes, decisions, points, "
                         f"action items, attendees) of the {min(deep, len(rows))} most recent")
    if "Timesheet" in wanted:
        for x in (norm_log(r) for r in api.timesheet_logs(user="me", identifier=ident)):
            blob = f"{x['timesheet']} | {x['description'] or ''} | {x['task_subject'] or ''}"
            title = f"{x['hours']}h on {x['date']} - {x['task_subject'] or x['task'] or ''}"
            h = _hit(x["timesheet"], title, x["project_identifier"], x["status"], x["date"], blob, terms)
            if h:
                h["entry"] = x["entry"]
                results["Timesheet"].append(h)
        coverage["Timesheet"] = "your own time logs: description, task subject"
    total = 0
    for dt, items in results.items():
        items.sort(key=lambda i: str(i.get("date") or ""), reverse=True)
        items.sort(key=lambda i: -i["score"])
        results[dt] = items[:limit]
        total += len(results[dt])
    return {"fetched_at": now_stamp(), "query": query, "terms": terms, "scope": ident or "all projects",
            "total": total, "results": results, "coverage": coverage}

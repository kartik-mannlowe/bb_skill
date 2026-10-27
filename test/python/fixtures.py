"""Sample results in the exact shapes bbclient.service returns (no network, no real data)."""

FETCHED = "2026-10-26T14:05:12"


def projects(rows=True, total=None):
    items = [
        {"identifier": "MA", "name": "PROJ-0002", "project_name": "Mobile App v2", "status": "Open",
         "priority": "High", "percent_complete": 20.0, "expected_end_date": "2026-12-06", "open_task_count": 4,
         "archived": False, "members": [], "selected": False},
        {"identifier": "CP", "name": "PROJ-0001", "project_name": "Customer Portal Revamp", "status": "Open",
         "priority": "Medium", "percent_complete": 45.0, "expected_end_date": None, "open_task_count": 6,
         "archived": False, "members": [], "selected": True},
    ] if rows else []
    return {"fetched_at": FETCHED, "status": "Open", "search": None, "count": len(items),
            "total": total if total is not None else len(items), "projects": items}


def task(**over):
    t = {"name": "TASK-2026-00009", "subject": "Investigate Android crash on app start", "status": "Working",
         "custom_task_status": None, "priority": "Urgent", "exp_start_date": "2026-10-01",
         "exp_end_date": "2026-10-05", "progress": 30, "project": "PROJ-0002", "parent_task": None, "type": None,
         "assigned_to": ["dev@bb.local", "qa@bb.local"], "assignee_names": ["Aarav Mehta", "Q A"],
         "cycles": ["Beta hardening"], "cycle_ids": ["CYC-0003"], "modules": [], "module_ids": [],
         "overdue": True, "selected": True}
    t.update(over)
    return t


def tasks(rows=True, total=None, status="default open"):
    items = [task(), task(name="TASK-2026-00011", subject="Fix | pipe in subject", status="Open", priority="Medium",
                          exp_end_date=None, assigned_to=[], cycles=[], cycle_ids=[], overdue=False,
                          selected=False)] if rows else []
    return {"fetched_at": FETCHED, "project": "MA", "project_label": "MA · Mobile App v2", "status": status,
            "cycle": None, "mine": False, "search": None, "count": len(items),
            "total": total if total is not None else len(items), "tasks": items}


def tickets(rows=True, total=None):
    items = [{"name": "ISS-2026-00005", "subject": "App crashes on Android 14 when opening cart", "status": "Open",
              "custom_issue_status": None, "priority": "High", "issue_type": "Bug", "raised_by": "d@x.com",
              "raised_by_name": "Daniel Brooks", "opened": "2026-10-04", "target_date": None, "project": "PROJ-0002",
              "assigned_to": [], "assignee_names": [], "module_ids": [], "selected": False}] if rows else []
    return {"fetched_at": FETCHED, "project": "MA", "project_label": "MA · Mobile App v2", "status": "default open",
            "priority": None, "search": None, "count": len(items),
            "total": total if total is not None else len(items), "tickets": items}


def cycles(rows=True):
    items = [{"name": "CYC-0003", "cycle_name": "Beta hardening", "status": "Active", "start_date": "2026-10-01",
              "end_date": "2026-10-14", "completed_count": 3, "task_count": 8}] if rows else []
    return {"fetched_at": FETCHED, "project": "MA", "project_label": "MA · Mobile App v2", "status": None,
            "count": len(items), "total": len(items), "cycles": items}


def moms(rows=True):
    items = [{"name": "MOM-2026-00002", "meeting_topic": "Payment gateway review", "meeting_type": "Client Review",
              "from_time": "2026-10-05 10:00:00", "to_time": "2026-10-05 11:00:00", "attendee_count": 4,
              "open_action_count": 2, "action_count": 5}] if rows else []
    return {"fetched_at": FETCHED, "scope": "MA", "project_label": "MA · Mobile App v2", "count": len(items),
            "total": len(items), "moms": items}


def timesheets(rows=True):
    items = [{"entry": "TL-0091", "timesheet": "TS-2026-00012", "status": "Draft", "date": "2026-10-07",
              "from_time": "2026-10-07 09:00:00", "to_time": "2026-10-07 10:30:00", "hours": 1.5,
              "activity_type": "Testing", "project": "PROJ-0002", "project_identifier": "MA",
              "project_name": "Mobile App v2", "task": "TASK-2026-00009",
              "task_subject": "Investigate Android crash on app start", "description": "Reproduced on the VM",
              "is_billable": 0, "minutes_of_meeting": None, "workstream": None, "user": "dev@bb.local",
              "user_full_name": "Aarav Mehta"}] if rows else []
    return {"fetched_at": FETCHED, "user": "me", "project": None, "since": "2026-10-01", "until": None,
            "count": len(items), "total": len(items), "total_hours": 1.5 if rows else 0, "logs": items}


def find(rows=True):
    hit = {"name": "MOM-2026-00002", "title": "Payment gateway review", "project": "MA", "status": None,
           "date": "2026-10-05", "score": 3, "snippet": "Decided to use the hosted payment page"}
    results = {"Task": [], "Issue": [], "Minutes of Meeting": [hit] if rows else [], "Timesheet": []}
    return {"fetched_at": FETCHED, "query": "payment gateway", "terms": ["payment", "gateway"], "scope": "MA",
            "total": 1 if rows else 0, "results": results,
            "coverage": {"Task": "subject and description", "Minutes of Meeting": "topic"}}


def task_record():
    t = task(selected=False)
    t.update({"project_identifier": "MA", "description": "<p>Crash on <b>start</b></p>", "issue": None,
              "minutes_of_meeting": None, "owner": "pm@bb.local", "owner_full_name": "Priya Nair",
              "completed_by": None, "completed_on": None, "creation": "2026-09-30 10:00:00"})
    return t


def state(signed_in=True, project=True):
    st = {}
    if signed_in:
        st.update({"user": "dev@bb.local", "full_name": "Aarav Mehta", "roles": ["BB Project User", "Employee"],
                   "site": "https://brewboard.example.com"})
    if project:
        st["project"] = {"identifier": "CP", "title": "Customer Portal Revamp"}
    return st


def log_time_result(new_task=False):
    return {"timesheet": "TS-2026-00012", "entry": "TL-0091", "status": "Draft", "date": "2026-10-07",
            "from": "09:00", "to": "10:30", "hours": 1.5, "activity_type": "Testing", "project": "MA",
            "task": "TASK-2026-00009", "task_subject": "Investigate Android crash on app start",
            "task_created": {"name": "TASK-2026-00009", "subject": "Investigate Android crash on app start"}
            if new_task else None,
            "description": "Reproduced on the VM", "is_billable": False, "minutes_of_meeting": None, "warnings": []}

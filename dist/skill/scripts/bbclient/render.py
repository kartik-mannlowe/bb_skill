"""Markdown output for `bb.py <list command> --format table` and `bb.py get ... --format table`.

The agent prints this text verbatim, so every Brewboard table looks the same whichever
route asked for it (direct command, /bb menu, follow-up). Rules encoded here:
  - the record ID is always a column of its own, holding exactly the ID the API returned;
  - an already-selected record is marked with `*` in the Sel column (nothing else);
  - selection is by ID; there is no row-number column to pick from;
  - a field the API did not return is shown as `—`, never guessed;
  - a shortened list says "Showing N of M"; an empty list says so in words.
"""
from __future__ import annotations

from .transport import strip_html

NONE = "—"


def cell(v) -> str:
    if v is None or v == "" or v == []:
        return NONE
    if isinstance(v, bool):
        return "Yes" if v else "No"
    if isinstance(v, (list, tuple)):
        v = ", ".join(str(x) for x in v if x not in (None, ""))
        if not v:
            return NONE
    s = strip_html(str(v)) if "<" in str(v) else str(v)
    return " ".join(s.split()).replace("|", "\\|")


def table(headers: list, rows: list) -> str:
    out = ["| " + " | ".join(headers) + " |", "|" + "|".join("---" for _ in headers) + "|"]
    out += ["| " + " | ".join(cell(c) for c in r) + " |" for r in rows]
    return "\n".join(out)


def kv_table(pairs: list) -> str:
    """Two-column table whose first data row doubles as the header (the /bb status style)."""
    if not pairs:
        return ""
    first, rest = pairs[0], pairs[1:]
    out = [f"| {cell(first[0])} | {cell(first[1])} |", "|---|---|"]
    out += [f"| {cell(k)} | {cell(v)} |" for k, v in rest]
    return "\n".join(out)


def sel(flag) -> str:
    return "*" if flag else " "  # blank, not the missing-value dash


def pct(v):
    return None if v is None else f"{float(v):g}%"


def hhmm(dt):
    return str(dt)[11:16] if dt and len(str(dt)) >= 16 else None


def footer(data: dict, more_hint: str | None = None) -> list:
    lines = []
    if data["count"] < data["total"]:
        line = f"Showing {data['count']} of {data['total']}."
        if more_hint:
            line += f" For more: `{more_hint}`"
        lines.append(line)
    lines.append(f"_Fetched from Brewboard at {data['fetched_at'].replace('T', ' ')}._")
    return lines


def _block(heading: str, body: str, tail: list, prompt: str | None = None) -> str:
    parts = [heading, "", body, ""] + tail
    if prompt:
        parts += ["", prompt]
    return "\n".join(parts).rstrip() + "\n"


def _status_label(data: dict) -> str:
    s = data.get("status")
    if isinstance(s, list):
        return " · Status: " + ", ".join(s)
    return " · All statuses" if s == "all" else ""


# ---------------------------------------------------------------- lists

def projects(data: dict, prompt: bool = True) -> str:
    heading = "**Projects**" + ("" if (data.get("status") or "Open") == "Open" else f" · Status: {data['status']}")
    if not data["projects"]:
        return _block(heading, "No projects found" + (f" matching '{data['search']}'." if data.get("search") else "."),
                      footer(data))
    rows = [[sel(p["selected"]), p["identifier"] or "(no identifier)", p["project_name"], p["status"], p["priority"],
             pct(p["percent_complete"]), p["expected_end_date"], p["open_task_count"]] for p in data["projects"]]
    body = table(["Sel", "ID", "Project", "Status", "Priority", "% Complete", "End Date", "Open Tasks"], rows)
    return _block(heading, body, footer(data, f"/bb list_projects {data['total']}"),
                  "Enter the project ID to select." if prompt else None)


def tasks(data: dict, prompt: bool = True) -> str:
    heading = f"**Tasks in {data['project_label']}**" + _status_label(data) + \
        (f" · Cycle: {data['cycle']}" if data.get("cycle") else "") + (" · Mine" if data.get("mine") else "")
    if not data["tasks"]:
        what = "matching" if (isinstance(data.get("status"), list) or data.get("search") or data.get("cycle")
                              or data.get("mine")) else "open"
        return _block(heading, f"No {what} tasks in {data['project_label']}.", footer(data))
    rows = []
    for t in data["tasks"]:
        status = t["custom_task_status"] or t["status"]
        due = t["exp_end_date"] and (f"{t['exp_end_date']} (overdue)" if t["overdue"] else t["exp_end_date"])
        rows.append([sel(t["selected"]), t["name"], t["subject"], status, t["priority"], due,
                     t["assigned_to"], t["cycles"] or t["cycle_ids"]])
    body = table(["Sel", "ID", "Subject", "Status", "Priority", "Due", "Assignees", "Cycle"], rows)
    status = " ".join(data["status"]) if isinstance(data.get("status"), list) else ""
    hint = f"/bb list_tasks {status} {data['total']}".replace("  ", " ")
    return _block(heading, body, footer(data, hint), "Enter the task ID to select." if prompt else None)


def tickets(data: dict, prompt: bool = True) -> str:
    heading = f"**Tickets in {data['project_label']}**" + _status_label(data)
    if not data["tickets"]:
        what = "matching" if (isinstance(data.get("status"), list) or data.get("search") or data.get("priority")) \
            else "open"
        return _block(heading, f"No {what} tickets in {data['project_label']}.", footer(data))
    rows = [[sel(t["selected"]), t["name"], t["subject"], t["custom_issue_status"] or t["status"], t["priority"],
             t["issue_type"], t["raised_by_name"], t["opened"]] for t in data["tickets"]]
    body = table(["Sel", "ID", "Subject", "Status", "Priority", "Type", "Raised By", "Opened"], rows)
    status = " ".join(data["status"]) if isinstance(data.get("status"), list) else ""
    hint = f"/bb list_tickets {status} {data['total']}".replace("  ", " ")
    return _block(heading, body, footer(data, hint),
                  "Enter the ticket ID(s) to select (comma-separated, or `all`)." if prompt else None)


def cycles(data: dict, prompt: bool = True) -> str:
    heading = f"**Cycles in {data['project_label']}**" + (f" · Status: {data['status']}" if data.get("status") else "")
    if not data["cycles"]:
        return _block(heading, f"No cycles in {data['project_label']}.", footer(data))
    rows = [[c.get("name"), c.get("cycle_name"), c.get("status"), c.get("start_date"), c.get("end_date"),
             f"{c.get('completed_count', 0)}/{c.get('task_count', 0)}"] for c in data["cycles"]]
    body = table(["ID", "Cycle", "Status", "Start", "End", "Tasks Done"], rows)
    return _block(heading, body, footer(data, f"/bb cycles {data['total']}"),
                  "Enter a cycle ID to see its tasks." if prompt else None)


def moms(data: dict, prompt: bool = True) -> str:
    scope = data.get("project_label") or data["scope"]
    heading = f"**Minutes of Meeting · {scope}**"
    if not data["moms"]:
        return _block(heading, "No minutes of meeting found.", footer(data))
    multi = data["scope"] == "all projects"
    rows = []
    for m in data["moms"]:
        when = (m.get("from_time") or "")[:10] or None
        span = hhmm(m.get("from_time")) and f"{hhmm(m.get('from_time'))}–{hhmm(m.get('to_time')) or '?'}"
        row = [m.get("name"), m.get("meeting_topic"), m.get("meeting_type"), when, span, m.get("attendee_count"),
               f"{m.get('open_action_count', 0)} open / {m.get('action_count', 0)}"]
        rows.append(row + ([m.get("project_identifier")] if multi else []))
    headers = ["ID", "Topic", "Type", "Date", "Time", "Attendees", "Action Items"] + (["Project"] if multi else [])
    tail = footer(data)
    if data.get("skipped_projects"):
        tail.insert(0, "Not readable: " + ", ".join(s["project"] for s in data["skipped_projects"]) + ".")
    return _block(heading, table(headers, rows), tail, "Enter a MoM ID to open it." if prompt else None)


def timesheets(data: dict, prompt: bool = False) -> str:
    who = "Team time logs" if data["user"] == "all" else "My time logs"
    rng = " · ".join(x for x in (data.get("project"), data.get("since") and f"from {data['since']}",
                                 data.get("until") and f"until {data['until']}") if x)
    heading = f"**{who}**" + (f" · {rng}" if rng else "")
    if not data["logs"]:
        return _block(heading, "No time logs found.", footer(data))
    rows = [[x["entry"], x["timesheet"], x["date"], f"{hhmm(x['from_time']) or '?'}–{hhmm(x['to_time']) or '?'}",
             x["hours"], x["activity_type"], x["project_identifier"] or x["project"],
             x["task"] and f"{x['task']} · {x['task_subject'] or ''}".rstrip(" ·"), x["description"], x["status"]]
            + ([x["user_full_name"]] if data["user"] == "all" else []) for x in data["logs"]]
    headers = ["Entry", "Timesheet", "Date", "Time", "Hours", "Activity", "Project", "Task", "Description",
               "Status"] + (["User"] if data["user"] == "all" else [])
    tail = [f"Total shown: {data['total_hours']}h."] + footer(data)
    return _block(heading, table(headers, rows), tail)


def find(data: dict) -> str:
    out = [f"**Search: {data['query']}** · {data['scope']}", ""]
    if not data["total"]:
        out.append("No matches.")
    for dt, items in data["results"].items():
        if not items:
            continue
        out += [f"_{dt}_", "", table(["ID", "Title", "Project", "Status", "Date", "Snippet"],
                                    [[i["name"], i["title"], i["project"], i["status"], i["date"],
                                      (i["snippet"] or "")[:90]] for i in items]), ""]
    out.append("Searched: " + "; ".join(f"{k}: {v}" for k, v in data["coverage"].items()) + ".")
    out.append(f"_Fetched from Brewboard at {data['fetched_at'].replace('T', ' ')}._")
    return "\n".join(out).rstrip() + "\n"


# ---------------------------------------------------------------- single records

def record(dt: str, d: dict) -> str:
    if dt == "Task":
        pairs = [("Task", f"{d['name']} · {d['subject']}"), ("Project", d.get("project_identifier")),
                 ("Status", d["custom_task_status"] or d["status"]), ("Priority", d["priority"]),
                 ("Start", d["exp_start_date"]),
                 ("Due", d["exp_end_date"] and (d["exp_end_date"] + (" (overdue)" if d["overdue"] else ""))),
                 ("Assignees", d["assigned_to"]), ("Cycle", d["cycles"] or d["cycle_ids"]),
                 ("Modules", d["modules"]), ("Parent task", d["parent_task"]), ("Ticket", d.get("issue")),
                 ("From MoM", d.get("minutes_of_meeting")), ("Progress", pct(d["progress"])),
                 ("Created by", d.get("owner_full_name"))]
        return kv_table(pairs) + "\n\n**Description**\n\n" + (strip_html(d.get("description") or "") or NONE) + "\n"
    if dt == "Issue":
        pairs = [("Ticket", f"{d['name']} · {d['subject']}"), ("Project", d.get("project_identifier")),
                 ("Status", d["custom_issue_status"] or d["status"]), ("Priority", d["priority"]),
                 ("Type", d["issue_type"]), ("Raised by", d["raised_by_name"]), ("Opened", d["opened"]),
                 ("Target date", d["target_date"]), ("Assignees", d["assigned_to"]),
                 ("Linked tasks", [f"{t['name']} ({t.get('status')})" for t in d.get("linked_tasks") or []]),
                 ("Resolution", d.get("resolution_details"))]
        return kv_table(pairs) + "\n\n**Description**\n\n" + (strip_html(d.get("description") or "") or NONE) + "\n"
    if dt == "Project":
        pairs = [("Project", f"{d['identifier']} · {d['project_name']}"), ("Record", d["name"]),
                 ("Status", d["status"]), ("Priority", d["priority"]), ("% Complete", pct(d["percent_complete"])),
                 ("End date", d["expected_end_date"]), ("Open tasks", d["open_task_count"]),
                 ("Members", [m["full_name"] or m["user"] for m in d["members"]]), ("Notes", d.get("notes"))]
        out = kv_table(pairs) + "\n"
        if d.get("cycles"):
            out += "\n**Cycles**\n\n" + table(["ID", "Cycle", "Status", "Start", "End", "Tasks Done"], [
                [c.get("name"), c.get("cycle_name"), c.get("status"), c.get("start_date"), c.get("end_date"),
                 f"{c.get('completed_count', 0)}/{c.get('task_count', 0)}"] for c in d["cycles"]]) + "\n"
        elif d.get("cycles_note"):
            out += f"\nCycles: {d['cycles_note']}\n"
        return out
    if dt == "Cycle":
        pairs = [("Cycle", f"{d.get('name')} · {d.get('cycle_name')}"), ("Project", d.get("project_identifier")),
                 ("Status", d.get("status")), ("Start", d.get("start_date")), ("End", d.get("end_date")),
                 ("Tasks done", f"{d.get('completed_count', 0)}/{d.get('task_count', 0)}"),
                 ("Description", d.get("description"))]
        tasks_ = d.get("tasks") or []
        body = table(["ID", "Subject", "Status", "Priority"],
                     [[t.get("name"), t.get("subject"), t.get("custom_task_status") or t.get("status"),
                       t.get("priority")] for t in tasks_]) if tasks_ else "No tasks in this cycle."
        return kv_table(pairs) + "\n\n**Tasks**\n\n" + body + "\n"
    if dt == "Minutes of Meeting":
        pairs = [("MoM", f"{d.get('name')} · {d.get('meeting_topic')}"), ("Project", d.get("project_identifier")),
                 ("Type", d.get("meeting_type")), ("From", d.get("from_time")), ("To", d.get("to_time")),
                 ("Location", d.get("location")),
                 ("Attendees", [a.get("full_name") or a.get("user") for a in d.get("attendees") or []]),
                 ("External", [a.get("full_name") + (f" ({a['organisation']})" if a.get("organisation") else "")
                               for a in d.get("external_attendees") or []]),
                 ("Recorded by", d.get("owner_full_name"))]
        out = kv_table(pairs) + "\n"
        if d.get("minutes"):
            out += "\n**Minutes**\n\n" + "\n".join(f"- {p.get('topic')}" for p in d["minutes"]) + "\n"
        for label, key in (("Meeting notes", "meeting_notes"), ("Decisions", "decisions"),
                           ("Assessment / observations", "assessment_observations")):
            if strip_html(d.get(key) or ""):
                out += f"\n**{label}**\n\n{strip_html(d[key])}\n"
        if d.get("action_items"):
            out += "\n**Action items**\n\n" + table(["Row", "Action", "Responsible", "Target", "Task"], [
                [a.get("name"), a.get("actions"), a.get("responsible"), a.get("target_date"), a.get("task")]
                for a in d["action_items"]]) + "\n"
        return out
    if dt == "Timesheet":
        return kv_table([("Timesheet", d["timesheet"]), ("Status", d["status"]), ("User", d["user"]),
                         ("Total hours", d["total_hours"])]) + "\n\n" + table(
            ["Entry", "Date", "Time", "Hours", "Activity", "Task", "Description"],
            [[x["entry"], x["date"], f"{hhmm(x['from_time'])}–{hhmm(x['to_time'])}", x["hours"], x["activity_type"],
              x["task"], x["description"]] for x in d["logs"]]) + "\n"
    raise ValueError(dt)


def context(st: dict, view: dict) -> str:
    p, t = view.get("project"), view.get("task")
    tickets_ = ", ".join(f"{x['name']} · {x.get('title') or ''}".rstrip(" ·") for x in view.get("tickets") or [])
    user = st.get("user") and (f"{st.get('full_name')} ({st['user']})" if st.get("full_name") else st["user"])
    pairs = [("User", user or "none"), ("Roles", ", ".join(r for r in st.get("roles") or [] if r.startswith("BB ")
                                                          or r == "System Manager") or "none"),
             ("Site", st.get("site") or "none"),
             ("Project", f"{p['identifier']} · {p.get('title') or ''}".rstrip(" ·") if p else "none"),
             ("Task", f"{t['name']} · {t.get('title') or ''}".rstrip(" ·") if t else "none"),
             ("Tickets", tickets_ or "none")]
    out = "**Brewboard status**\n\n" + kv_table(pairs) + "\n"
    if view.get("note"):
        out += f"\n{view['note']}\n"
    return out

"""Markdown output for `bb.py ... --format table`, printed verbatim by the agent.

Every Brewboard view has the same shape, whichever route asked for it (direct command, /bb menu,
follow-up):

    ### Title · scope                      one heading per view
    filter · count                         one meta line (lists)
    <table, record fields or message>
    Showing N of M. For more: `...`        only when the list was shortened
    _Fetched from Brewboard at ..._        lists and searches
    **Enter the ... ID to select.**        the prompt, when a pick is expected

Rules encoded here:
  - the record ID is a column of its own holding exactly the ID the API returned (shown as code);
  - an already-selected record has `*` in the Sel column (nothing else);
  - selection is by ID; there is no row-number column to pick from;
  - in list tables a field the API did not return is `—`; record views leave such rows out;
  - an empty list says so in words and suggests a next step that exists;
  - plain Markdown only: no ANSI colour, HTML or box-drawing characters (agents render it).
"""
from __future__ import annotations

import re

from . import ui
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
    # Escape each pipe; backslashes right before it are doubled first, or `a\|b` would still split the cell.
    return re.sub(r"(\\*)\|", lambda m: m.group(1) * 2 + "\\|", " ".join(s.split()))


def code(v) -> str:
    """An identifier, shown as inline code so it stands out and copies cleanly."""
    s = cell(v)
    if s == NONE:
        return s
    return f"`` {s} ``" if "`" in s else f"`{s}`"  # a backtick inside needs a longer delimiter


def strong(v) -> str:
    s = cell(v)
    return s if s == NONE else f"**{s}**"


def short(v, n: int) -> str | None:
    s = cell(v)
    if s == NONE:
        return None
    return s if len(s) <= n else s[:n - 1].rstrip() + "…"


class Raw(str):
    """A cell that is already formatted (code, bold) and must not be escaped again."""


def table(headers: list, rows: list) -> str:
    out = ["| " + " | ".join(headers) + " |", "|" + "|".join("---" for _ in headers) + "|"]
    out += ["| " + " | ".join(c if isinstance(c, Raw) else cell(c) for c in r) + " |" for r in rows]
    return "\n".join(out)


def kv_table(pairs: list) -> str:
    """Two-column table whose first data row doubles as the header (the /bb status style).
    Rows without a value are left out, except the first."""
    if not pairs:
        return ""
    first, rest = pairs[0], [p for p in pairs[1:] if cell(p[1]) != NONE]
    fmt = lambda v: v if isinstance(v, Raw) else cell(v)  # noqa: E731
    out = [f"| {cell(first[0])} | {fmt(first[1])} |", "|---|---|"]
    out += [f"| {cell(k)} | {fmt(v)} |" for k, v in rest]
    return "\n".join(out)


def sel(flag) -> str:
    return "*" if flag else " "  # blank, not the missing-value dash


def pct(v):
    return None if v is None else f"{float(v):g}%"


def hhmm(dt):
    return str(dt)[11:16] if dt and len(str(dt)) >= 16 else None


def span(start, end) -> str | None:
    """`09:00–10:30`; `—` when neither time is known, `?` for one that is missing."""
    if not (hhmm(start) or hhmm(end)):
        return None
    return f"{hhmm(start) or '?'}–{hhmm(end) or '?'}"


def plural(n: int, word: str, many: str | None = None) -> str:
    return f"{n} {word if n == 1 else (many or word + 's')}"


def ident(v) -> Raw:
    return Raw(code(v))


def due(date_, overdue: bool) -> Raw | None:
    if not date_:
        return None
    return Raw(f"**{cell(date_)} (overdue)**" if overdue else cell(date_))


def fetched(data: dict) -> str:
    return f"_Fetched from Brewboard at {data['fetched_at'].replace('T', ' ')}._"


def footer(data: dict, more_hint: str | None = None) -> list:
    """The "Showing N of M" line (with a /bb command for the rest, when one exists) and the fetched-at line,
    separated by a blank line so Markdown keeps them apart."""
    lines = []
    if data["count"] < data["total"]:
        line = f"Showing {data['count']} of {data['total']}."
        if more_hint:
            line += f" For more: `{more_hint}`"
        lines += [line, ""]
    lines.append(fetched(data))
    return lines


def more_hint(command: str, data: dict, extra_filters: tuple = ()) -> str | None:
    """`/bb list_tasks [status] [limit]` for the rest of the list, or None when the list was filtered in a way that
    syntax cannot express (all statuses, search, mine, cycle, priority): a wrong hint is worse than none."""
    status = data.get("status")
    if status == "all" or any(data.get(k) for k in ("search",) + extra_filters):
        return None
    words = [",".join(status)] if isinstance(status, list) else []  # several statuses are comma-separated
    return " ".join([command] + words + [str(data["total"])])


def prose(text: str) -> str:
    """Free text shown outside a table: a line starting with a code fence would swallow the rest of the view."""
    return re.sub(r"^(\s*)([`~]{3,})", lambda m: m.group(1) + "".join("\\" + c for c in m.group(2)), text,
                  flags=re.M)


def view(heading: str, meta: str | None, body: list, tail: list = (), prompt: str | None = None) -> str:
    parts = [f"### {heading}"] + ([meta] if meta else []) + [""] + body + [""] + list(tail)
    if prompt:
        parts += ["", f"**{prompt}**"]
    return "\n".join(parts).rstrip() + "\n"


def empty(message: str, next_step: str | None = None) -> list:
    return [message] + ([next_step] if next_step else [])


def _status_text(status) -> str:
    if isinstance(status, list):
        return ", ".join(status)
    return {"all": "All statuses", "default open": "Open (default)"}.get(status, status or "")


def _meta(*parts) -> str:
    return " · ".join(p for p in parts if p)


# ---------------------------------------------------------------- lists

def projects(data: dict, prompt: bool = True) -> str:
    status = data.get("status") or "Open"
    meta = _meta("All statuses" if status == "all" else status, data.get("search") and f"matching '{data['search']}'",
                 plural(data["total"], "project"))
    if not data["projects"]:
        if data.get("search"):
            msg = empty(f"No projects match '{data['search']}'.", "Check the spelling, or list them all with "
                                                                  "`/bb list_projects`.")
        else:
            msg = empty(f"No {status.lower() if status != 'all' else ''} projects are visible to your Brewboard "
                        "account.".replace("  ", " "), "A Brewboard project manager can add you to a project.")
        return view("Projects", meta, msg, [fetched(data)])
    rows = [[sel(p["selected"]), ident(p["identifier"]) if p["identifier"] else "(no identifier)", p["project_name"],
             p["status"], p["priority"], pct(p["percent_complete"]), p["expected_end_date"], p["open_task_count"]]
            for p in data["projects"]]
    body = table(["Sel", "ID", "Project", "Status", "Priority", "% Complete", "End Date", "Open Tasks"], rows)
    return view("Projects", meta, [body], footer(data),  # /bb list_projects takes no limit
                "Enter the project ID to select." if prompt else None)


def tasks(data: dict, prompt: bool = True) -> str:
    filtered = isinstance(data.get("status"), list) or data.get("search") or data.get("cycle") or data.get("mine")
    every = data.get("status") == "all" and not filtered
    meta = _meta(_status_text(data.get("status")), data.get("cycle") and f"Cycle: {data['cycle']}",
                 data.get("mine") and "Assigned to me", data.get("search") and f"matching '{data['search']}'",
                 plural(data["total"], "task"))
    heading = f"Tasks · {data['project_label']}"
    if not data["tasks"]:
        msg = empty(f"No tasks in {data['project_label']}." if every else
                    f"No {'matching' if filtered else 'open'} tasks in {data['project_label']}.",
                    None if every else "Try another status, for example `/bb list_tasks Completed`.")
        return view(heading, meta, msg, [fetched(data)])
    rows = [[sel(t["selected"]), ident(t["name"]), t["subject"], t["custom_task_status"] or t["status"],
             t["priority"], due(t["exp_end_date"], t["overdue"]), t["assigned_to"], t["cycles"] or t["cycle_ids"]]
            for t in data["tasks"]]
    body = table(["Sel", "ID", "Subject", "Status", "Priority", "Due", "Assignees", "Cycle"], rows)
    hint = more_hint("/bb list_tasks", data, ("mine", "cycle"))
    return view(heading, meta, [body], footer(data, hint), "Enter the task ID to select." if prompt else None)


def tickets(data: dict, prompt: bool = True) -> str:
    filtered = isinstance(data.get("status"), list) or data.get("search") or data.get("priority")
    every = data.get("status") == "all" and not filtered
    meta = _meta(_status_text(data.get("status")), data.get("priority") and f"Priority: {cell(data['priority'])}",
                 data.get("search") and f"matching '{data['search']}'", plural(data["total"], "ticket"))
    heading = f"Tickets · {data['project_label']}"
    if not data["tickets"]:
        msg = empty(f"No tickets in {data['project_label']}." if every else
                    f"No {'matching' if filtered else 'open'} tickets in {data['project_label']}.",
                    None if every else "Try another status, for example `/bb list_tickets Resolved`.")
        return view(heading, meta, msg, [fetched(data)])
    rows = [[sel(t["selected"]), ident(t["name"]), t["subject"], t["custom_issue_status"] or t["status"],
             t["priority"], t["issue_type"], t["raised_by_name"], t["opened"]] for t in data["tickets"]]
    body = table(["Sel", "ID", "Subject", "Status", "Priority", "Type", "Raised By", "Opened"], rows)
    hint = more_hint("/bb list_tickets", data, ("priority",))
    return view(heading, meta, [body], footer(data, hint),
                "Enter the ticket ID(s) to select (comma-separated, or `all`)." if prompt else None)


def _cycle_rows(items: list) -> list:
    return [[ident(c.get("name")), c.get("cycle_name"), c.get("status"), c.get("start_date"), c.get("end_date"),
             f"{c.get('completed_count', 0)}/{c.get('task_count', 0)}"] for c in items]


CYCLE_HEADERS = ["ID", "Cycle", "Status", "Start", "End", "Tasks Done"]


def cycles(data: dict, prompt: bool = True) -> str:
    meta = _meta(data.get("status"), data.get("search") and f"matching '{data['search']}'",
                 plural(data["total"], "cycle"))
    heading = f"Cycles · {data['project_label']}"
    if not data["cycles"]:
        msg = empty(f"No {data['status'].lower() + ' ' if data.get('status') else ''}cycles in "
                    f"{data['project_label']}.", "Try without the status filter: `/bb cycles`."
                    if data.get("status") else None)
        return view(heading, meta, msg, [fetched(data)])
    return view(heading, meta, [table(CYCLE_HEADERS, _cycle_rows(data["cycles"]))],
                footer(data), "Enter a cycle ID to see its tasks." if prompt else None)  # /bb cycles takes no limit


def moms(data: dict, prompt: bool = True) -> str:
    scope = data.get("project_label") or data["scope"]
    meta = _meta(data.get("search") and f"matching '{data['search']}'", plural(data["total"], "meeting"))
    heading = f"Minutes of Meeting · {scope}"
    if not data["moms"]:
        msg = empty(f"No minutes of meeting match '{data['search']}'.", "Try other keywords.") if data.get("search") \
            else empty(f"No minutes of meeting in {scope} yet.", "Record one with `/bb create_mom`.")
        tail = [fetched(data)]
        if data.get("skipped_projects"):
            tail.insert(0, "Not readable: " + ", ".join(s["project"] for s in data["skipped_projects"]) + ".")
        return view(heading, meta, msg, tail)
    multi = data["scope"] == "all projects"
    rows = []
    for m in data["moms"]:
        when = (m.get("from_time") or "")[:10] or None
        span = hhmm(m.get("from_time")) and f"{hhmm(m.get('from_time'))}–{hhmm(m.get('to_time')) or '?'}"
        row = [ident(m.get("name")), m.get("meeting_topic"), m.get("meeting_type"), when, span,
               m.get("attendee_count"), f"{m.get('open_action_count', 0)} open / {m.get('action_count', 0)}"]
        rows.append(row + ([m.get("project_identifier")] if multi else []))
    headers = ["ID", "Topic", "Type", "Date", "Time", "Attendees", "Action Items"] + (["Project"] if multi else [])
    tail = footer(data)
    if data.get("skipped_projects"):
        tail.insert(0, "Not readable: " + ", ".join(s["project"] for s in data["skipped_projects"]) + ".")
    return view(heading, meta, [table(headers, rows)], tail, "Enter a MoM ID to open it." if prompt else None)


def timesheets(data: dict, prompt: bool = False) -> str:
    team = data["user"] == "all"
    rng = _meta(data.get("project"), data.get("since") and f"from {data['since']}",
                data.get("until") and f"until {data['until']}")
    heading = "Team time logs" if team else "My time logs"
    if not data["logs"]:
        when = f" {rng}" if rng else ""
        msg = empty(f"No time logs{when}.", None if team else "Log time with `/bb log_time`.")
        return view(heading, _meta(rng, "0 entries"), msg, [fetched(data)])
    projects_ = {x["project_identifier"] or x["project"] for x in data["logs"]}
    multi = len(projects_) > 1
    meta = _meta(rng, None if multi else next(iter(projects_)), plural(data["total"], "entry", "entries"))
    rows = []
    for x in data["logs"]:
        task = x["task"] and Raw(f"{code(x['task'])} {cell(x['task_subject'])}" if x["task_subject"]
                                 else code(x["task"]))
        rows.append([ident(x["entry"]), ident(x["timesheet"]), x["date"], span(x["from_time"], x["to_time"]),
                     None if x["hours"] is None else f"{float(x['hours']):g}",
                     x["activity_type"]] + ([x["project_identifier"] or x["project"]] if multi else [])
                    + [task, short(x["description"], 60), x["status"]] + ([x["user_full_name"]] if team else []))
    headers = ["Entry", "Timesheet", "Date", "Time", "Hours", "Activity"] + (["Project"] if multi else []) + \
        ["Task", "Description", "Status"] + (["User"] if team else [])
    tail = [f"Total shown: {data['total_hours']}h."] + footer(data)
    return view(heading, meta, [table(headers, rows)], tail)


FIND_TYPES = {"Task": "Tasks", "Issue": "Tickets", "Minutes of Meeting": "Meetings", "Timesheet": "Time logs",
              "Project": "Projects", "Cycle": "Cycles"}


def find(data: dict) -> str:
    meta = _meta(f"in {data['scope']}", plural(data["total"], "match", "matches"))
    body = []
    if not data["total"]:
        body = empty(f"No matches for '{data['query']}'.", "Try other keywords." if data["scope"] == "all projects"
                     else "Try other keywords, or search all projects.")
    for dt, items in data["results"].items():
        if not items:
            continue
        body += [f"**{FIND_TYPES.get(dt, dt)}** ({len(items)})", "",
                 table(["ID", "Title", "Project", "Status", "Date", "Snippet"],
                       [[ident(i["name"]), i["title"], i["project"], i["status"], i["date"], short(i["snippet"], 90)]
                        for i in items]), ""]
    while body and body[-1] == "":
        body.pop()
    tail = ["Searched: " + "; ".join(f"{FIND_TYPES.get(k, k)}: {v}" for k, v in data["coverage"].items()) + ".",
            fetched(data)]
    return view(f"Search · {data['query']}", meta, body, tail)


# ---------------------------------------------------------------- single records

def _description(d: dict) -> str:
    text = prose(strip_html(d.get("description") or ""))
    return "\n\n**Description**\n\n" + (text or "_No description._") + "\n"


def record(dt: str, d: dict) -> str:
    if dt == "Task":
        pairs = [("Task", Raw(f"{code(d['name'])} {cell(d['subject'])}")), ("Project", d.get("project_identifier")),
                 ("Status", d["custom_task_status"] or d["status"]), ("Priority", d["priority"]),
                 ("Start", d["exp_start_date"]), ("Due", due(d["exp_end_date"], d["overdue"])),
                 ("Assignees", d["assigned_to"]), ("Cycle", d["cycles"] or d["cycle_ids"]),
                 ("Modules", d["modules"]), ("Parent task", d["parent_task"]), ("Ticket", d.get("issue")),
                 ("From MoM", d.get("minutes_of_meeting")), ("Progress", pct(d["progress"])),
                 ("Created by", d.get("owner_full_name"))]
        return f"### Task · {cell(d['name'])}\n\n" + kv_table(pairs) + _description(d)
    if dt == "Issue":
        pairs = [("Ticket", Raw(f"{code(d['name'])} {cell(d['subject'])}")), ("Project", d.get("project_identifier")),
                 ("Status", d["custom_issue_status"] or d["status"]), ("Priority", d["priority"]),
                 ("Type", d["issue_type"]), ("Raised by", d["raised_by_name"]), ("Opened", d["opened"]),
                 ("Target date", d["target_date"]), ("Assignees", d["assigned_to"]),
                 ("Linked tasks", [f"{t['name']} ({t.get('status')})" for t in d.get("linked_tasks") or []]),
                 ("Resolution", d.get("resolution_details"))]
        return f"### Ticket · {cell(d['name'])}\n\n" + kv_table(pairs) + _description(d)
    if dt == "Project":
        pairs = [("Project", Raw(f"{code(d['identifier'])} {cell(d['project_name'])}")), ("Record", d["name"]),
                 ("Status", d["status"]), ("Priority", d["priority"]), ("% Complete", pct(d["percent_complete"])),
                 ("End date", d["expected_end_date"]), ("Open tasks", d["open_task_count"]),
                 ("Members", [m["full_name"] or m["user"] for m in d["members"]]), ("Notes", d.get("notes"))]
        out = f"### Project · {cell(d['identifier'])}\n\n" + kv_table(pairs) + "\n"
        if d.get("cycles"):
            out += "\n**Cycles**\n\n" + table(CYCLE_HEADERS, _cycle_rows(d["cycles"])) + "\n"
        elif d.get("cycles_note"):
            out += f"\nCycles: {d['cycles_note']}\n"
        return out
    if dt == "Cycle":
        pairs = [("Cycle", Raw(f"{code(d.get('name'))} {cell(d.get('cycle_name'))}")),
                 ("Project", d.get("project_identifier")), ("Status", d.get("status")),
                 ("Start", d.get("start_date")), ("End", d.get("end_date")),
                 ("Tasks done", f"{d.get('completed_count', 0)}/{d.get('task_count', 0)}"),
                 ("Description", d.get("description"))]
        tasks_ = d.get("tasks") or []
        body = table(["ID", "Subject", "Status", "Priority"],
                     [[ident(t.get("name")), t.get("subject"), t.get("custom_task_status") or t.get("status"),
                       t.get("priority")] for t in tasks_]) if tasks_ else "No tasks in this cycle."
        return f"### Cycle · {cell(d.get('name'))}\n\n" + kv_table(pairs) + "\n\n**Tasks**\n\n" + body + "\n"
    if dt == "Minutes of Meeting":
        pairs = [("MoM", Raw(f"{code(d.get('name'))} {cell(d.get('meeting_topic'))}")),
                 ("Project", d.get("project_identifier")), ("Type", d.get("meeting_type")),
                 ("From", d.get("from_time")), ("To", d.get("to_time")), ("Location", d.get("location")),
                 ("Attendees", [a.get("full_name") or a.get("user") for a in d.get("attendees") or []]),
                 ("External", [a.get("full_name") + (f" ({a['organisation']})" if a.get("organisation") else "")
                               for a in d.get("external_attendees") or []]),
                 ("Recorded by", d.get("owner_full_name"))]
        out = f"### Minutes of Meeting · {cell(d.get('name'))}\n\n" + kv_table(pairs) + "\n"
        if d.get("minutes"):
            out += "\n**Minutes**\n\n" + "\n".join(f"- {p.get('topic')}" for p in d["minutes"]) + "\n"
        for label, key in (("Meeting notes", "meeting_notes"), ("Decisions", "decisions"),
                           ("Assessment / observations", "assessment_observations")):
            if strip_html(d.get(key) or ""):
                out += f"\n**{label}**\n\n{prose(strip_html(d[key]))}\n"
        if d.get("action_items"):
            out += "\n**Action items**\n\n" + table(["Row", "Action", "Responsible", "Target", "Task"], [
                [a.get("name"), a.get("actions"), a.get("responsible"), a.get("target_date"),
                 a.get("task") and ident(a["task"])] for a in d["action_items"]]) + "\n"
        return out
    if dt == "Timesheet":
        head = kv_table([("Timesheet", ident(d["timesheet"])), ("Status", d["status"]), ("User", d["user"]),
                         ("Total hours", d["total_hours"])])
        return f"### Timesheet · {cell(d['timesheet'])}\n\n" + head + "\n\n" + table(
            ["Entry", "Date", "Time", "Hours", "Activity", "Task", "Description"],
            [[ident(x["entry"]), x["date"], span(x["from_time"], x["to_time"]),
              x["hours"], x["activity_type"], x["task"] and ident(x["task"]), x["description"]]
             for x in d["logs"]]) + "\n"
    raise ValueError(dt)


# ---------------------------------------------------------------- context and home screen

def _ctx_pairs(st: dict, view_: dict) -> list:
    p, t = view_.get("project"), view_.get("task")
    tickets_ = ", ".join(f"{x['name']} · {x.get('title') or ''}".rstrip(" ·") for x in view_.get("tickets") or [])
    user = st.get("user") and (f"{st.get('full_name')} ({st['user']})" if st.get("full_name") else st["user"])
    return [("User", user or "none"),
            ("Roles", ", ".join(r for r in st.get("roles") or [] if r.startswith("BB ") or r == "System Manager")
             or "none"),
            ("Site", st.get("site") or "none"),
            ("Project", f"{p['identifier']} · {p.get('title') or ''}".rstrip(" ·") if p else "none"),
            ("Task", f"{t['name']} · {t.get('title') or ''}".rstrip(" ·") if t else "none"),
            ("Tickets", tickets_ or "none")]


def context(st: dict, view_: dict) -> str:
    out = "### Brewboard status\n\n" + kv_table(_ctx_pairs(st, view_)) + "\n"
    if view_.get("note"):
        out += f"\n{view_['note']}\n"
    return out


def home(data: dict, width: int = 80) -> str:
    """The /bb home screen: banner (in a code block, so agents keep the spacing), account, context."""
    art = ui.banner_lines(width, data.get("version"))
    out = ["```text", *art, "```", ""]
    if data.get("signed_in"):
        who = data.get("user") or "unknown user"
        if data.get("full_name") and data.get("full_name") != who:
            who = f"{data['full_name']} ({who})"
        out.append(f"**Account** {cell(who)} · {cell(data.get('site') or 'no site')} · saved sign-in, checked "
                   "when a command runs")
    else:
        out.append("**Account** not signed in. Choose Authentication (or run `/bb init`) to connect.")
    ctx = {k: cell(v) for k, v in _ctx_pairs({}, data.get("context") or {})}  # titles are record text
    out += ["", f"**Project** {ctx['Project']} · **Task** {ctx['Task']} · **Tickets** {ctx['Tickets']}"]
    if (data.get("context") or {}).get("note"):
        out += ["", data["context"]["note"]]
    return "\n".join(out) + "\n"


def _credential_text(cred: dict) -> str | None:
    """Where the saved credential came from, without the key or secret."""
    parts = []
    if cred.get("auth_source"):
        parts.append("this CLI only")
    elif cred.get("key_fp"):
        parts.append("account API key pair")
    saved = (cred.get("saved_at") or "")[:10]
    if cred.get("obtained_via") == "login" and saved:
        parts.append(f"signed in on {saved}")
    elif saved:
        parts.append(f"saved {saved}")
    if cred.get("expires_on"):
        parts.append(f"expires {str(cred['expires_on'])[:10]}")
    if any(src == "env" for k, src in (cred.get("source") or {}).items() if k != "url"):
        parts.append("from environment variables")
    return " · ".join(parts) or None


SIGN_IN = ("not_configured", "credentials_rejected")


def connection(data: dict, view_: dict) -> str:
    """`bb.py auth-check --format table`, the /bb init result. Like /bb status, the first data row (Name)
    doubles as the table header: a key/value summary never gets an empty header row."""
    status = data.get("status")
    if status != "ok":
        title = "Not signed in" if status == "not_configured" else ui.TITLES.get(status, "Sign-in problem")
        message = data.get("message") or "No Brewboard sign-in is saved on this computer."
        steps = list(data.get("next_steps") or []) or [s for s in (ui.hint(status),) if s and status not in SIGN_IN]
        out = ["### Brewboard connection", f"{title} · status `{status}`", "", cell(message)]
        if steps:
            out += [""] + [f"- {cell(s)}" for s in steps]
        if status in SIGN_IN:  # in the agent, signing in goes through /bb init --login (a new terminal)
            out += ["", "Run `/bb init --login` to sign in: it opens the sign-in in a new terminal."]
        return "\n".join(out) + "\n"
    user, name = data.get("user"), data.get("full_name")
    first = ("Name", name) if name and name != user else ("User ID", user)
    pairs = [first] + ([("User ID", user)] if first[0] == "Name" else []) + [
        ("Brewboard roles", data.get("roles") or "none"), ("Site", data.get("url")),
        ("Credential", _credential_text(data.get("credentials") or {}))]
    out = "### Brewboard connection\nSigned in · checked just now\n\n" + kv_table(pairs) + "\n"
    ctx = {k: cell(v) for k, v in _ctx_pairs({}, view_ or {})}
    out += f"\n**Project** {ctx['Project']} · **Task** {ctx['Task']} · **Tickets** {ctx['Tickets']}\n"
    if not data.get("roles"):
        out += "\n**Note:** this account has no Brewboard role, so Brewboard will refuse most requests.\n"
    return out


def login_launch(d: dict) -> str:
    """`bb.py init --login --launch --format table`, the /bb init --login result. Never claims a sign-in that
    has not started, and never a successful one: the agent checks that with /bb init afterwards."""
    where = f"{cell(d.get('terminal'))} {cell(d.get('mode'))}"
    check = "When it says you are signed in, run `/bb init` to check the connection."
    if d.get("status") == "already_running":
        return ("### Brewboard sign-in\n\nA Brewboard sign-in is already open in another terminal. Finish it "
                f"there; nothing new was opened.\n\n{check}\n")
    if d.get("status") == "started":
        return (f"### Brewboard sign-in\n\nOpened in a new {where}.\n\nEnter your Brewboard email and password "
                f"there, not in this chat. {check}\n")
    return (f"### Brewboard sign-in\n\nAsked {cell(d.get('terminal'))} to open a new {cell(d.get('mode'))} for the "
            f"sign-in, but it has not started yet.\n\nIf none appears, run this in your own terminal: "
            f"{code(d.get('command'))}\n\n{check}\n")


def signed_out(d: dict) -> str:
    """`bb.py init --logout --format table`, the /bb init --logout result. Says plainly what happened on the
    server: a CLI credential is revoked there; an account's own key pair is only removed locally."""
    if d.get("already_signed_out"):
        return ("### Brewboard\n\nAlready signed out: no Brewboard credentials are saved on this computer.\n\n"
                "Run `/bb init` to sign in.\n")
    out = ["### Brewboard", "", "✓ Signed out successfully.", "",
           "Saved authentication credentials removed from this computer. The server address and your selected "
           "project, task and tickets are kept."]
    if d.get("revoked"):
        out += ["", f"The Brewboard server revoked this CLI's credential ({cell(d['revoked'])})."]
    elif d.get("note"):
        out += ["", cell(d["note"])]
    if d.get("warning"):
        out += ["", f"**Note:** {cell(d['warning'])}"]
    return "\n".join(out + ["", "Run `/bb init` to sign in again."]) + "\n"


# ---------------------------------------------------------------- results of writes

def _warnings(items) -> str:
    items = [w for w in items or [] if w]
    return "".join(["\n**Warnings**\n\n"] + [f"- {w}\n" for w in items]) if items else ""


def log_time(d: dict) -> str:
    task = Raw(f"{code(d['task'])} {cell(d.get('task_subject'))}" + (" (new task)" if d.get("task_created") else ""))
    pairs = [("Time log", ident(d.get("entry")) if d.get("entry") else "created; entry not visible yet"),
             ("Timesheet", ident(d["timesheet"])), ("When", f"{d['date']} {d['from']}–{d['to']} ({d['hours']:g}h)"),
             ("Project", d.get("project")), ("Task", task), ("Activity", d.get("activity_type")),
             ("Description", d.get("description")), ("Billable", "Yes" if d.get("is_billable") else "No"),
             ("Meeting", d.get("minutes_of_meeting") and ident(d["minutes_of_meeting"])),
             ("Status", d.get("status"))]
    note = ("Saved as **Draft**. Submit it in Brewboard / ERPNext when you are ready: ERPNext counts only submitted "
            "timesheets in a task's actual time.") if d.get("status") in (None, "Draft") else ""
    return f"### Time logged · {d['hours']:g}h\n\n" + kv_table(pairs) + "\n" + (f"\n{note}\n" if note else "") + \
        _warnings(d.get("warnings"))


def create_task(d: dict) -> str:
    t = d["task"]
    pairs = [("Task", Raw(f"{code(t['name'])} {cell(t['subject'])}")), ("Project", d.get("project_identifier")),
             ("Status", t.get("custom_task_status") or t.get("status")), ("Priority", t.get("priority")),
             ("Start", t.get("exp_start_date")), ("Due", t.get("exp_end_date")), ("Assignees", t.get("assigned_to"))]
    return f"### Task created · {cell(t['name'])}\n\n" + kv_table(pairs) + "\n"


def create_mom(d: dict) -> str:
    when = d.get("from_time") and (f"{d['from_time'][:16]}" + (f"–{hhmm(d['to_time'])}" if d.get("to_time") else ""))
    pairs = [("MoM", Raw(f"{code(d['mom'])} {cell(d.get('meeting_topic'))}")), ("Project", d.get("project")),
             ("Type", d.get("meeting_type")), ("When", when), ("Attendees", d.get("attendees")),
             ("External", d.get("external_attendees")),
             ("Minutes", d.get("minutes") and plural(len(d["minutes"]), "point")),
             ("Action items", d.get("action_items") and plural(len(d["action_items"]), "item"))]
    out = f"### Minutes recorded · {cell(d['mom'])}\n\n" + kv_table(pairs) + "\n"
    if d.get("tasks_created"):
        out += "\n**Tasks created**\n\n" + table(["ID", "Action", "Assignees", "Due"], [
            [ident(t.get("name")), t.get("subject"), t.get("assigned_to"), t.get("due_date")]
            for t in d["tasks_created"]]) + "\n"
    return out + _warnings(d.get("warnings"))


def _shown(v):
    """A changed value as people read it: child-table rows (attendees, minutes, action items) by their name."""
    if isinstance(v, dict):
        return next((v[k] for k in ("full_name", "user", "topic", "actions", "name") if v.get(k)), None)
    if isinstance(v, list):
        return [_shown(x) for x in v]
    return v


def update(d: dict) -> str:
    name = d.get("name") or d.get("entry")
    what = {"Task": "Task", "Issue": "Ticket", "Minutes of Meeting": "Minutes of Meeting"}.get(d.get("doctype"),
                                                                                                 "Time log")
    heading = f"### {what} updated · {cell(name)}\n\n"
    changed = d.get("changed") or {}
    if not changed:
        return heading + "No change: Brewboard already had these values.\n"
    rows = [[k.replace("_", " "), short(_shown(v.get("from")), 60), short(_shown(v.get("to")), 60)]
            for k, v in changed.items()]
    out = heading + table(["Field", "Before", "After"], rows) + "\n"
    if d.get("status"):
        out += f"\nStatus now: {cell(d['status'])}.\n"
    return out


def delete(d: dict) -> str:
    return (f"### Deleted · {cell(d['name'])}\n\nThe minutes of meeting {code(d['name'])} were deleted from project "
            f"{cell(d.get('project'))}. Tasks and time logs created from the meeting are kept.\n")

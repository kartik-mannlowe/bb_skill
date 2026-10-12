# /bb operation contract

What the /bb skill calls, and how.

**Production ERPNext data access uses the existing whitelisted HTTP APIs in `brewboard_backend.api.*`. MCP is not used for this integration.**
Neither is Frappe's generic `/api/resource` API.

Verified against the `brewboard_backend` source, branch `uat`, commit `2493939` (2026-10-12).
The endpoint table in `scripts/bbclient/api.py` (`ENDPOINTS`) is the machine-readable copy;
`tests/test_api_contract.py` checks it against that source.

## Contents
1. Conventions and authentication
2. Operations → endpoints
3. Payload shapes (log_time, create_mom, find, errors)
4. Roles the operations need
5. Known API gaps

## 1. Conventions and authentication

- URL: `<site>/api/method/brewboard_backend.api.<module>.<function>`. Reads are `GET` with query
  parameters; writes are `POST` with a JSON body. Responses are `{"message": <value>}`.
- Auth: Frappe token auth, `Authorization: token <api_key>:<api_secret>`. A per-client credential
  (from `auth.login_and_get_keys(..., client="cli")`) also sends
  `Frappe-Authorization-Source: Brewboard API Credential`, which tells Frappe core to check the pair
  against that DocType instead of the User. Legacy account keys send no source header.
- Projects are addressed by their **identifier** (`Project.custom_identifier`, e.g. `CP`), not by
  the Project document name. Responses still carry the document name in `project`.
- Other IDs are document names: `TASK-2026-00001`, `ISS-2026-00001`, `TS-2026-00001`,
  `MOM-2026-00001`, `CYCLE-2026-00001`. Time-log entries (Timesheet Detail rows) have hash names.
- Dates `YYYY-MM-DD`; datetimes `YYYY-MM-DD HH:MM:SS`; hours as decimals (1.5 = 1h30).
- **No pagination.** No list endpoint takes a limit or offset: each returns every row the caller
  may see. `bb.py` applies its display limit and the filters the API lacks to that complete,
  fresh result and reports `total` (matching rows) next to `count` (rows shown).
- Errors: Frappe status codes with `exc_type` and `_server_messages` (see 3.4).

## 2. Operations → endpoints

| Operation | CLI | Endpoint (`brewboard_backend.api.` …) | Notes |
|---|---|---|---|
| Health check | `init`, `whoami` | `GET health.ping` | unauthenticated; proves the URL is a Brewboard backend |
| Sign in for a CLI credential | `init --login` | `POST auth.login_and_get_keys(usr, pwd, client="cli", label)` | returns its own key/secret + `auth_source`; other clients unaffected (older backends: rotates the account secret) |
| List / revoke credentials | `credentials`, `logout` | `GET auth.list_credentials`, `POST auth.revoke_credential(credential?)`, `POST auth.revoke_other_credentials` | own credentials only; metadata, never secrets |
| Who am I | `whoami` | `GET auth.get_current_user` | name, full_name, email, roles |
| List projects | `projects` | `GET projects.get_projects(include_archived)` | status / search / limit applied by bb.py |
| Project detail | `get project <IDENT>` | `GET projects.get_project(project_identifier)` + `GET cycles.get_cycles` | members in `users` |
| Task / ticket / meeting vocabularies | (validation) | `GET meta.get_task_meta`, `meta.get_ticket_meta`, `meta.get_meeting_meta`, `meta.get_project_status_meta(project_identifier)` | custom stages when the project uses them |
| List tasks | `tasks` | `GET tasks.get_tasks(project_identifier, include_subtasks)` | status / mine / cycle / search / limit applied by bb.py |
| Task detail | `get task <ID>` | `GET tasks.get_task(project_identifier, task_name)` | project found via `search.search` when the ID is not in the selected project |
| Create task | `create-task`, `log-time --new-task` | `POST tasks.create_task(project_identifier, subject, status, priority, assignees, exp_start_date, exp_end_date, description, parent_task, issue)` | |
| Update task | `update task` | `POST tasks.update_task(task_name, field, value, completed_by)` | one field per call; allow-list in source |
| List tickets | `tickets` / `issues` | `GET tickets.get_tickets(project_identifier, status, priority)` | server filters ONE status / ONE priority; more values filtered by bb.py |
| Ticket detail | `get issue <ID>` | `GET tickets.get_ticket(project_identifier, ticket_name)` + `GET tickets.get_linked_tasks(ticket_name)` | |
| Update ticket | `update issue` | `POST tickets.update_ticket(ticket_name, field, value)` | one field per call |
| List cycles | `cycles` | `GET cycles.get_cycles(project_identifier)` | status derived from dates by the server |
| Cycle detail | `get cycle <ID>` | `GET cycles.get_cycle(cycle_id)` | includes the cycle's tasks |
| Activity types | `activity-types` | `GET timesheets.get_activity_types` | |
| List time logs | `timesheets`, `get timesheet <ID>` | `GET timesheets.get_timesheet_logs(user, project_identifier, from_date, to_date, is_billable)` | one row per Timesheet Detail; `user` is `me` or `all` |
| Log time | `log-time` | `POST timesheets.create_timesheet_log(project_identifier, task_name, from_time, to_time, hours, description, is_billable, activity_type, minutes_of_meeting, workstream)` | returns only the Timesheet name; bb.py reads the log back |
| Edit a time log | `update log <ENTRY>` | `POST timesheets.update_timesheet_log(detail_name, …same row fields…)` | own Draft logs only |
| List minutes | `moms` | `GET minutes.get_minutes(project_identifier)` | |
| Minutes detail | `get mom <ID>` | `GET minutes.get_minutes_meeting(project_identifier, mom_name)` | |
| Create minutes | `create-mom` | `POST minutes.create_minutes(project_identifier, meeting_topic, **fields)` | see 3.2 |
| Action item → task | `create-mom --create-tasks` | `POST minutes.create_task_from_action_point(project_identifier, mom_name, row_name, assignees)` | subject and due date come from the stored row |
| Edit minutes | `update mom` | `POST minutes.update_minutes(project_identifier, mom_name, meeting_topic, **fields)` | a sent table replaces that table |
| Delete minutes | `delete mom` | `POST minutes.delete_minutes(project_identifier, mom_name)` | Project Managers only |
| Search | `find`, task/ticket lookup | `GET search.search(query)` | tasks, tickets, projects, cycles, modules, views; ≤5 per type; names/subjects only |
| Attachments | `attachments` | `GET attachments.get_attachments(doctype, name)` | Task and Issue only |
| Download a file | `attachments --download`, `download` | `GET attachments.download_attachment(file_name \| file_url)` | file must be attached to a readable Task/Issue |
| People | `users` | `GET projects.get_project` (`users`) / `GET settings.get_workspace_members` (`--workspace`) | |

Context (selected project / task / tickets) is client-side state kept by `bb.py ctx`.

## 3. Payload shapes

The `//` comments in the examples are annotations only; real JSON must not contain them.

### 3.1 log_time
`bb.py log-time --hours 2.5 --activity Development --desc "..." (--task <ID> | --new-task "<subject>") [--project <IDENT>] [--date D] [--from HH:MM] [--billable] [--meeting MOM-ID]`

Behaviour:
- A task is required (`create_timesheet_log` rejects a log without one). `--new-task` first
  creates the task (assigned to the user, status Working), then logs against it.
- `from_time` default: end of the user's latest non-cancelled log that day (from
  `get_timesheet_logs`), else 09:00, which avoids ERPNext's overlap error. `to_time` = from + hours.
- Refused locally before any request: project-only logs (`--no-task`), `--submit`, `--note`,
  `--employee` (`api_unsupported`); an identical log (same task, day, hours and description)
  already present (`possible_duplicate`; `--allow-duplicate` overrides).
- One new Timesheet per call, created as Draft by the server.

Output:
```json
{"timesheet": "TS-2026-00007", "entry": "a1b2c3d4e5", "status": "Draft", "date": "2026-10-07",
 "from": "10:30", "to": "12:30", "hours": 2.0, "activity_type": "Development", "project": "CP",
 "task": "TASK-2026-00014", "task_subject": "Add session expiry banner",
 "task_created": {"name": "TASK-2026-00014", "subject": "Add session expiry banner"},
 "description": "...", "is_billable": false, "minutes_of_meeting": null, "warnings": []}
```
`entry` and `status` come from reading the log back; when that read fails they are `null` and
`warnings` says so. If the log fails after `--new-task` created the task, the error carries
`task_created`.

### 3.2 create_mom
Input (what the skill writes to the temp file for `bb.py create-mom --file <path>`):
```json
{
  "project": "CP",                              // optional; default: the selected project
  "meeting_topic": "Session timeout bug triage",  // required ("title" accepted as an alias)
  "meeting_type": "Status Review",              // Kickoff | Status Review | Client Review | Planning | Retrospective | Ad-hoc
  "date": "2026-10-07", "start_time": "15:00", "end_time": "15:30",   // or "from_time"/"to_time" as datetimes
  "location": "Google Meet",
  "attendees": ["dev@bb.local", {"user": "pm@bb.local"}, {"full_name": "Neha Kapoor", "organisation": "Acme Retail"}],
  "external_attendees": [{"full_name": "Rohit Shah", "email": "rohit@freshcart.example", "organisation": "FreshCart"}],
  "minutes": ["One discussion point per line (max 140 characters)", {"topic": "..."}],
  "decisions": "text, or a list of strings (stored as a numbered list)",
  "meeting_notes": "text, or a list of strings",
  "assessment_observations": "text, or a list of strings",
  "action_items": [
    {"actions": "Clear refresh cookie on 401", "responsible": "dev@bb.local", "target_date": "2026-10-09"},
    "Plain strings become action items without owner/date"
  ]
}
```
Mapping onto `create_minutes`: attendees with a user ID (or a project member's full name) go to
`attendees` (`Meeting Attendee.user`); others go to `external_attendees` (`Meeting External
Attendee`: full_name, email, organisation). `minutes` → `Meeting Points.topic`; `action_items` →
`Action Points` (`actions` ≤140 characters, `target_date`, `responsible`; `description`, `due_date`
/ `due` and `assigned_to` / `owner` accepted as aliases). Text fields are Text Editor (HTML):
plain text and lists are escaped and wrapped by bb.py. `agenda` and `discussion` are rejected:
the DocType has no such fields. Unknown keys are rejected. A meeting with the same topic on the
same day in the project is refused as `possible_duplicate` unless `--allow-duplicate`.

Option `--create-tasks`: for every action item without a task, `create_task_from_action_point`
creates the Task (subject and due date from the stored row, `custom_minutes_of_meeting` linked)
and writes the link back; it is assigned to `responsible` only when that is a project member.

Output:
```json
{"mom": "MOM-2026-00004", "meeting_topic": "...", "project": "CP", "from_time": "2026-10-07 15:00:00",
 "to_time": "2026-10-07 15:30:00", "meeting_type": "Status Review",
 "attendees": ["Aarav Mehta"], "external_attendees": ["Neha Kapoor"], "minutes": ["..."],
 "action_items": [{"name": "r1", "actions": "...", "responsible": "dev@bb.local", "target_date": "2026-10-09",
                   "task": "TASK-2026-00015"}],
 "tasks_created": [{"name": "TASK-2026-00015", "subject": "...", "assigned_to": ["dev@bb.local"], "due_date": "2026-10-09"}],
 "warnings": []}
```

### 3.3 find
Input: `query`, `project` (omit for the selected one; `--all-projects` for all), `types` (subset
of task, issue, mom, timesheet, project, cycle), `limit` per type, `deep` (how many recent MoMs
to open in full).

| Type | In a project | All projects |
|---|---|---|
| Task, Issue | full list from `get_tasks` / `get_tickets`: ID, subject, description | `search.search`: ID / subject only, ≤5 per keyword |
| Cycle | `get_cycles`: name, description | `search.search`: name, ≤5 per keyword |
| Minutes of Meeting | `get_minutes` (topic, type, location) + full text of the `deep` most recent | same, for every reachable project |
| Timesheet | the user's own logs (`get_timesheet_logs`): description, task subject | same |
| Project | `get_projects`: identifier, name, notes | same |

The query is split into keywords (stopwords dropped) and ranked by matched keywords, plus a
bonus when all appear together. Output adds `coverage` (what each type searched):
```json
{"query": "payment gateway", "terms": ["payment", "gateway"], "scope": "MA", "total": 2,
 "results": {"Task": [{"name": "TASK-2026-00008", "title": "Integrate payment gateway (UPI + cards)", "project": "MA",
                       "status": "Open", "date": "2026-10-25", "score": 5.0, "snippet": "..."}],
             "Issue": [], "Minutes of Meeting": [], "Timesheet": [], "Project": [], "Cycle": []},
 "coverage": {"Task": "all tasks in MA: ID, subject, description", "...": "..."}}
```

### 3.4 Errors
```json
{"error": "validation_error", "message": "Row 1: From Time and To Time of HR-EMP-00001 is overlapping with TS-2026-00006", "status": 417}
```
| Code | Meaning |
|---|---|
| `not_configured` | no URL / key / secret saved |
| `auth_failed` | 401 that could not be diagnosed further (`identity_check` says why) |
| `credentials_rejected` | 401, and the identity endpoint rejects the same credentials: the saved secret is no longer valid (typically replaced by a later sign-in; see gap 18) |
| `endpoint_auth_failed` | 401 from one endpoint while `auth.get_current_user` accepts the same credentials |
| `forbidden` | 403: role or project membership does not allow it |
| `not_found` | 404: no such record, or not in the given project |
| `validation_error` | 417 / 409: Brewboard rejected the input (its message is relayed) |
| `rate_limited` | 429 |
| `server_error` | 5xx (for a write: may or may not have been saved) |
| `unreachable` | no connection |
| `write_outcome_unknown` | a write was sent but no answer came back; check before retrying |
| `http_error` / `bad_response` | non-JSON, empty, or unexpected response shape |
| `not_brewboard` | the URL does not serve `brewboard_backend` |
| `api_unsupported` | the Brewboard API has no endpoint for this; nothing was sent |
| `bad_input`, `no_project`, `possible_duplicate` | refused locally; nothing was sent |

Reads are retried once on a timeout, dropped connection or 502/503/504. Writes are never retried. On a 401 bb.py makes one read-only `auth.get_current_user` call to classify it; it never signs in or rewrites `config.json` by itself (only `init` writes it, and only after verifying the new credentials).

## 4. Roles the operations need

From `helpers/rbac.py` (System Manager may do everything; Analytics Admins and System Managers
reach every project, everyone else only projects whose members include them):

| Operation | BB Project Manager | BB Project User | BB Analytics Admin | BB Ticket User |
|---|---|---|---|---|
| projects, tickets (read) | ✓ | ✓ | ✓ | ✓ (own tickets only) |
| tasks, cycles, minutes, time logs (read) | ✓ | ✓ | ✓ | – |
| create / update tasks and tickets, log time, write minutes | ✓ | ✓ | – | – (may raise tickets in Brewboard) |
| delete minutes | ✓ | – | – | – |
| `users --workspace` | ✓ | ✓ | – | – |

## 5. Known API gaps

What the skill would need that `brewboard_backend.api` does not offer. Each is refused by
bb.py (`api_unsupported`) or worked around as described; none falls back to another API.

| # | DocType / capability | Needed | Available today | Backend change |
|---|---|---|---|---|
| 1 | Timesheet: submit | submit a Draft timesheet from /bb | none (logs stay Draft) | `timesheets.submit_timesheet(timesheet)`: owner-only, `timesheet.write`, `doc.submit()` |
| 2 | Timesheet: cancel / delete a log | correct a submitted log (cancel + redo), delete a draft | `update_timesheet_log` edits drafts only | `timesheets.cancel_timesheet(timesheet)` and `timesheets.delete_timesheet_log(detail_name)` (owner, draft) |
| 3 | Timesheet: project-only time | log time without a task | `create_timesheet_log` requires `task_name` | make `task_name` optional (keep the in-project check when given) |
| 4 | Timesheet: read one | fetch a Timesheet by name (status, totals, note) | only via `get_timesheet_logs` (all of the user's logs) | `timesheets.get_timesheet(timesheet)` |
| 5 | Timesheet: note | the Timesheet `note` field | not a parameter | add `note` to `create_timesheet_log` |
| 6 | All lists: paging | page through large projects | every list endpoint returns all rows | optional `limit` / `start` on `get_tasks`, `get_tickets`, `get_minutes`, `get_timesheet_logs` |
| 7 | Task: status filter | filter tasks by status server-side | `get_tasks` has no status parameter | optional `status` (list) on `get_tasks` |
| 8 | Issue: multi-value filters | several statuses / priorities | `get_tickets` takes one of each | accept a JSON list for `status` / `priority` |
| 9 | Search: depth | search descriptions, minutes and time logs; more than 5 hits; project scope | `search.search` matches names/subjects, ≤5 per type, all projects | optional `project_identifier`, `doctypes`, `limit`; include description and MoM text |
| 10 | Task: lookup by ID alone | open a task / ticket without knowing its project | `get_task` / `get_ticket` need the project identifier (bb.py resolves it via `search.search`) | `tasks.get_task_by_name(task_name)` (resolve_record already finds the project) |
| 11 | Minutes: lookup by ID alone | open a MoM without its project | `get_minutes_meeting` needs the project | same as 10 for minutes |
| 12 | Task: delete | delete a task | none | `tasks.delete_task(task_name)` behind `task.delete` |
| 13 | Ticket: delete | delete a ticket | none | only if wanted; RBAC has no `ticket.delete` |
| 14 | Project: edit | change project fields from /bb | `settings.update_project_general` (Project Managers; settings surface) | not needed by /bb today |
| 15 | Task: expected time | set `expected_time` on create | not a `create_task` parameter | add `expected_time` to `create_task` / `update_task` allow-list |
| 16 | Employee | show the linked Employee in status | not exposed (the server picks it when logging) | not needed; status shows roles instead |
| 17 | Attachments on other records | files on MoMs / projects | Task and Issue only | extend `ATTACHABLE_DOCTYPES` if wanted |
| 18 | Auth: one API secret per user, rotated on every login (**addressed by per-client credentials, backend change pending deploy; web UI release pending**) | the web UI and bb.py signed in as the same user at the same time | `auth.login_and_get_keys` → `_mint_keys` (`api/auth.py:60-81`) generates a new `api_secret` on every call, by design ("one account signing in on a second device signs the first one out"); the web UI login form and `bb.py init --login` both call it, so each revokes the other | backend decision needed (see `docs/backend-auth-rotation.md`): reuse the existing secret on login (option A, patch provided), or issue per-client credentials (option B, OAuth bearer tokens) |

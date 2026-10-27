#!/usr/bin/env python3
"""
bb.py - command-line client for the Brewboard /bb skill.

Talks to the Brewboard backend over its HTTP API: the whitelisted methods of the
`brewboard_backend` Frappe app (/api/method/brewboard_backend.api.*). That is the only
data path: no generic Frappe /api/resource calls, no MCP. Standard library only, so it
runs wherever the coding agent runs (Python 3.8+).

Output: JSON on stdout, or Markdown with --format table for the agent to print verbatim
(bbclient/render.py). A person running init / auth-check / whoami / logout in a terminal gets
readable text instead (bbclient/ui.py; --format json keeps JSON). Errors: exit code 1 and JSON on stderr
    {"error": "<code>", "message": "...", "status": <http status>}
except for those four commands in text mode on a terminal, which print the same information as text.
Codes: see bbclient/errors.py (not_configured, auth_failed, forbidden, not_found,
       validation_error, unreachable, write_outcome_unknown, api_unsupported, ...)

Files (directory overridable with BB_HOME):
    ~/.bb/config.json  url, api_key, api_secret (mode 600). BB_URL / BB_API_KEY / BB_API_SECRET override.
    ~/.bb/state.json   working context: user, selected project / task / tickets. Never list results.
                       Override the path with BB_STATE_FILE (e.g. one per repo).

Run `bb.py <command> --help` for options.
"""
from __future__ import annotations

import argparse
import getpass
import json
import re
import socket
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from bbclient import config, diagnose, render, service, ui  # noqa: E402
from bbclient.api import BrewboardAPI  # noqa: E402
from bbclient.errors import BBError, unsupported  # noqa: E402
from bbclient.transport import Transport  # noqa: E402


def emit(obj) -> None:
    json.dump(obj, sys.stdout, indent=2, ensure_ascii=False, default=str)
    sys.stdout.write("\n")


def emit_as(a, data, table_fn) -> None:
    if getattr(a, "format", "json") == "table":
        sys.stdout.write(table_fn(data))
    else:
        emit(data)


def wants_text(a) -> bool:
    """--format text, or auto (the default) when a person is reading the terminal."""
    fmt = getattr(a, "format", "auto")
    return fmt == "text" or (fmt == "auto" and sys.stdout.isatty())


def human_errors(a) -> bool:
    """Readable error text instead of JSON, only for the commands people run themselves (init, auth-check,
    whoami, logout) in text mode, and only when stderr is a terminal. Every other command keeps JSON errors
    even on a terminal, so an agent whose shell is a pseudo-terminal still gets the JSON it parses."""
    return getattr(a, "format", None) in ("auto", "text") and wants_text(a) and sys.stderr.isatty()


def emit_account(a, kind: str, out: dict) -> None:
    if wants_text(a):
        sys.stdout.write(ui.account_text(kind, out, ui.Style(sys.stdout)))
    else:
        emit(out)


def make_api(cfg: dict | None = None) -> BrewboardAPI:
    cfg = cfg or config.load_config()
    return BrewboardAPI(Transport(cfg["url"], cfg.get("api_key"), cfg.get("api_secret"), timeout=config.timeout(),
                                  auth_source=cfg.get("auth_source")))


# =============================================================== identity + context

def cmd_init(a) -> None:
    cfg = config.load_config(required=False)
    interactive = sys.stdin.isatty()
    if interactive and sys.stdout.isatty() and wants_text(a):
        ui.print_banner(sys.stdout, ui.installed_version(), [ui.Style(sys.stdout).heading("Sign in to Brewboard")])

    def ask(label: str, current: str | None, secret: bool = False) -> str | None:
        if not interactive:
            if current:
                return current
            raise BBError("bad_input", f"Missing {label}. Run `bb.py init` in a terminal to be prompted, "
                                       "or pass --url, --key and --secret.")
        hint = f" [{'keep current' if secret else current}]" if current else ""
        val = (getpass.getpass if secret else input)(f"{label}{hint}: ").strip()
        return val or current

    url = a.url or ask("Brewboard URL (e.g. https://brewboard.example.com)", cfg.get("url"))
    if not url:
        raise BBError("bad_input", "The Brewboard URL is required")
    if not re.match(r"https?://", url):
        url = "https://" + url
    url = url.rstrip("/")
    service.verify_site(BrewboardAPI(Transport(url, timeout=config.timeout())))

    notes, issued = [], {}
    if a.login:
        if not interactive:
            raise BBError("bad_input", "--login prompts for your password, so run it in a terminal "
                                       "(passwords are never accepted as arguments)")
        guest = BrewboardAPI(Transport(url, timeout=config.timeout()))
        per_client = service.supports_client_credentials(guest)
        if not per_client:
            sys.stderr.write(ui.Style(sys.stderr).status("warn",
                "WARNING: this Brewboard backend has no per-client credentials. Signing in replaces the\n"
                "  account's single API secret: the Brewboard web UI and any other client signed in as this\n"
                "  user will be signed out, and a later web UI sign-in will sign bb.py out.") + "\n")
            if input('Type "yes" to continue: ').strip().lower() != "yes":
                raise BBError("bad_input", "Sign-in cancelled; nothing was changed.")
        usr = a.user or input("Brewboard login (email): ").strip()
        pwd = getpass.getpass("Password: ")
        label = f"bb CLI on {socket.gethostname()}"[:140]
        issued = guest.login(usr, pwd, client="cli", label=label) if per_client else guest.login(usr, pwd)
        key, secret = issued.get("api_key"), issued.get("api_secret")
        if not (key and secret):
            raise BBError("bad_response", "login_and_get_keys did not return API keys")
        if issued.get("auth_source"):
            notes.append(f"Signed in with a credential for this CLI only ({issued.get('credential')}, expires "
                         f"{issued.get('expires_on')}). Other Brewboard clients stay signed in; "
                         "`bb.py logout` revokes just this one.")
        else:
            notes.append("This Brewboard backend has no per-client credentials yet: signing in replaced the "
                         "account's single API secret, which signs out the web UI, and a web UI sign-in will "
                         "sign bb.py out.")
    else:
        same_site = cfg.get("url") == url
        key = a.key or ask("API key", cfg.get("api_key") if same_site else None)
        secret = a.secret or ask("API secret", cfg.get("api_secret") if same_site else None, secret=True)
    if not (key and secret):
        raise BBError("bad_input", "API key and secret are both required (or use --login)")
    new = {"url": url, "api_key": key, "api_secret": secret, "auth_source": issued.get("auth_source")}
    info = service.whoami(make_api(new))  # verify before saving
    path = config.save_config(url, key, secret, obtained_via="login" if a.login else "keys", user=info["user"],
                              auth_source=issued.get("auth_source"), credential=issued.get("credential"),
                              expires_on=issued.get("expires_on"))
    old = cfg.get("credential") if cfg.get("auth_source") and cfg.get("url") == url else None
    if old and old != issued.get("credential") and cfg.get("user") == info["user"]:
        try:  # this CLI's previous credential: replaced, so revoke it (never another client's)
            make_api(new).revoke_credential(old)
            notes.append(f"Revoked this CLI's previous credential {old}.")
        except BBError as e:
            notes.append(f"Could not revoke this CLI's previous credential {old} ({e.code}); "
                         "see `bb.py credentials`.")
    if not a.login:
        notes.append("Using the account's own API key pair. Until the web UI uses per-client credentials, a web UI "
                     "sign-in rotates this pair; `bb.py init --login` gets a CLI-only credential instead.")
    st = config.remember_identity(info)
    out = {"ok": True, "config_file": str(path), **info, "context": config.context_view(st)}
    if config.env_overrides():
        notes.append(f"{', '.join(config.env_overrides())} set in the environment override the saved config.")
    if notes:
        out["notes"] = notes
    emit_account(a, "init", out)


def cmd_logout(a) -> None:
    """Revoke this CLI's credential on the server, then remove it from config.json."""
    cfg = config.load_config()
    out = {"credential": cfg.get("credential")}
    if cfg.get("auth_source"):
        try:
            out["revoked"] = make_api(cfg).revoke_credential()["revoked"]
        except BBError as e:
            if e.code not in ("auth_failed", "credentials_rejected"):
                raise
            out["note"] = "The server already rejects this credential (revoked or expired)."
    else:
        out["note"] = ("These are the account's own API keys, not a CLI credential: they were only removed "
                       "locally and stay valid on the server until rotated.")
    if any(src == "env" for k, src in (cfg.get("_source") or {}).items() if k != "url"):
        out["warning"] = "BB_API_KEY / BB_API_SECRET are set in the environment; unset them too."
    out["config_file"] = str(config.clear_credentials())
    emit_account(a, "logout", out)


def cmd_credentials(a) -> None:
    """Your Brewboard API credentials (metadata only); --revoke ID or --revoke-others."""
    api = make_api()
    if a.revoke:
        emit(api.revoke_credential(a.revoke))
    elif a.revoke_others:
        emit(api.revoke_other_credentials())
    else:
        emit({"credentials": api.list_credentials()})


def cmd_whoami(a) -> None:
    api = make_api()
    service.verify_site(api)
    info = service.whoami(api)
    st = config.remember_identity(info)
    emit_account(a, "whoami", {**info, "context": config.context_view(st)})


def cmd_auth_check(a) -> None:
    """Read-only: where the credentials come from, and whether Brewboard accepts them. Never signs in."""
    cfg = config.load_config(required=False)
    out = {"credentials": config.credential_view(cfg), "url": cfg.get("url")}
    if not all(cfg.get(k) for k in ("url", "api_key", "api_secret")):
        out["status"] = "not_configured"
        emit_auth_check(a, out)
        return
    api = make_api(cfg)
    try:
        service.verify_site(api)
        out["site"] = "brewboard_backend"
        me = service.whoami(api)
        out.update(status="ok", user=me["user"], full_name=me.get("full_name"),
                   roles=[r for r in me["roles"] if r.startswith("BB ") or
                                                         r == "System Manager"])
    except BBError as e:
        e = diagnose.diagnose_auth_failure(api, e, cfg)
        out.update(status=e.code, message=e.message)
        if e.extra.get("next_steps"):
            out["next_steps"] = e.extra["next_steps"]
    emit_auth_check(a, out)


def emit_auth_check(a, out: dict) -> None:
    """--format table is what /bb init prints (SKILL.md); the other formats are those of emit_account."""
    if a.format == "table":
        sys.stdout.write(render.connection(out, config.context_view(config.load_state())))
    else:
        emit_account(a, "auth-check", out)


# Free text (titles, subjects, descriptions) can come from Brewboard records written by people outside the
# team. SKILL.md passes it as JSON on stdin (`--file -` with a quoted heredoc) so no shell ever interprets
# it; the options themselves still work for commands typed by hand.
def merge_file_fields(a, fields: dict) -> None:
    """Set each attribute named in `fields` ("str" or "list") from the JSON object in --file."""
    if not getattr(a, "file", None):
        return
    data = service.read_json_input(a.file)
    if not isinstance(data, dict):
        raise BBError("bad_input", "--file must hold a JSON object")
    data = {k.replace("-", "_"): v for k, v in data.items()}
    unknown = sorted(set(data) - set(fields))
    if unknown:
        raise BBError("bad_input", f"--file: unknown field(s) {', '.join(unknown)}; "
                                   f"allowed: {', '.join(sorted(fields))}")
    for key, value in data.items():
        if fields[key] == "str":
            ok, kind = isinstance(value, str), "a string"
        else:
            ok, kind = isinstance(value, list) and all(isinstance(v, str) for v in value), "a list of strings"
        if not ok:
            raise BBError("bad_input", f"--file: {key} must be {kind}")
        if getattr(a, key, None) not in (None, []):
            raise BBError("bad_input", f"{key} was given both as an option and in --file")
        setattr(a, key, value)


def cmd_ctx(a) -> None:
    merge_file_fields(a, {"title": "str", "titles": "list", "record": "str"})
    st = config.load_state()
    ids = a.ids or []
    if a.action in ("set-project", "set-task") and len(ids) != 1:
        raise BBError("bad_input", f"ctx {a.action} takes exactly one ID")
    if a.action == "set-project":
        if (config.project_ctx(st) or {}).get("identifier") != ids[0]:
            st.pop("task", None)
            st.pop("tickets", None)
        st["project"] = {"identifier": ids[0], "name": a.record, "title": a.title}
    elif a.action == "set-task":
        st["task"] = {"name": ids[0], "title": a.title}
    elif a.action == "set-tickets":
        if not ids:
            raise BBError("bad_input", "ctx set-tickets takes one or more ticket IDs")
        titles = a.titles or []
        st["tickets"] = [{"name": n, "title": titles[i] if i < len(titles) else None} for i, n in enumerate(ids)]
    elif a.action == "clear":
        what = ids[0] if ids else "all"
        keys = {"all": ["project", "task", "tickets"], "project": ["project", "task", "tickets"],
                "task": ["task"], "tickets": ["tickets"]}.get(what)
        if keys is None:
            raise BBError("bad_input", "ctx clear takes one of: all, project, task, tickets")
        for k in keys:
            st.pop(k, None)
    if a.action != "show":
        config.save_state(st)
    view = config.context_view(st)
    data = {"user": st.get("user"), "full_name": st.get("full_name"), "roles": st.get("roles") or [],
            "site": st.get("site"), **view}
    if a.format == "table":
        sys.stdout.write(render.context(st, view))
    else:
        emit(data)


def cmd_home(a) -> None:
    """The /bb home screen: version, saved sign-in and context. Local only: never touches the network,
    so it reports a *saved* sign-in, not a verified one (auth-check verifies)."""
    cfg = config.load_config(required=False)
    st = config.load_state()
    signed_in = all(cfg.get(k) for k in ("url", "api_key", "api_secret"))
    user = (cfg.get("user") or st.get("user")) if signed_in else None
    data = {"version": ui.installed_version(), "signed_in": signed_in, "user": user,
            "full_name": st.get("full_name") if user and st.get("user") == user else None,
            "site": cfg.get("url") if signed_in else None, "context": config.context_view(st)}
    emit_as(a, data, lambda d: render.home(d, ui.terminal_width()))


# =============================================================== reads

def cmd_projects(a) -> None:
    data = service.list_projects(make_api(), config.load_state(), a.status, a.search, a.archived, a.limit)
    emit_as(a, data, lambda d: render.projects(d, not a.no_prompt))


def cmd_tasks(a) -> None:
    data = service.list_tasks(make_api(), config.load_state(), a.project, a.status, a.all, a.mine, a.search,
                              a.cycle, a.subtasks, a.limit)
    emit_as(a, data, lambda d: render.tasks(d, not a.no_prompt))


def cmd_tickets(a) -> None:
    data = service.list_tickets(make_api(), config.load_state(), a.project, a.status, a.all, a.priority, a.search,
                                a.limit)
    emit_as(a, data, lambda d: render.tickets(d, not a.no_prompt))


def cmd_cycles(a) -> None:
    data = service.list_cycles(make_api(), config.load_state(), a.project, a.status, a.search, a.limit)
    emit_as(a, data, lambda d: render.cycles(d, not a.no_prompt))


def cmd_moms(a) -> None:
    data = service.list_moms(make_api(), config.load_state(), a.project, a.all_projects, a.search, a.limit)
    emit_as(a, data, lambda d: render.moms(d, not a.no_prompt))


def cmd_timesheets(a) -> None:
    if a.employee:
        raise unsupported("listing another employee's logs by Employee ID",
                          "Use --all-users (needs a role that may read team time).")
    billable = True if a.billable else (False if a.non_billable else None)
    data = service.list_logs(make_api(), config.load_state(), a.project, a.since, a.until, a.all_users, billable,
                             a.status, a.limit)
    emit_as(a, data, render.timesheets)


def cmd_get(a) -> None:
    dt = service.doctype_of(a.doctype)
    data = service.get_record(make_api(), config.load_state(), a.doctype, a.name, a.project)
    emit_as(a, data, lambda d: render.record(dt, d))


def cmd_activity_types(a) -> None:
    emit(service.activity_types(make_api()))


def cmd_users(a) -> None:
    emit(service.users(make_api(), config.load_state(), a.project, a.search, a.workspace))


def cmd_find(a) -> None:
    data = service.find(make_api(), config.load_state(), a.query, a.project, a.all_projects, a.types, a.limit,
                        a.deep)
    emit_as(a, data, render.find)


def cmd_attachments(a) -> None:
    emit(service.attachments(make_api(), a.doctype, a.name, a.download))


def cmd_download(a) -> None:
    emit(service.download(make_api(), a.url, a.dir))


# =============================================================== writes

def cmd_create_task(a) -> None:
    if a.expected:
        raise unsupported("expected time on tasks", "create_task has no expected_time parameter.")
    merge_file_fields(a, {"subject": "str", "desc": "str"})
    if not a.subject:
        raise BBError("bad_input", "a task subject is required (--subject, or \"subject\" in --file)")
    emit_as(a, service.create_task(make_api(), config.load_state(), a.subject, a.project, a.desc, a.priority,
                                   a.status, a.start, a.due, a.issue, a.parent, not a.no_assign), render.create_task)


def cmd_log_time(a) -> None:
    if a.no_task:
        raise unsupported("time logs without a task", "create_timesheet_log requires task_name. Pick a task, or "
                                                      "use --new-task to create one first.")
    if a.submit:
        raise unsupported("submitting timesheets", "Logs are saved as Draft; submit them in Brewboard / ERPNext.")
    if a.employee:
        raise unsupported("logging time for another employee", "Brewboard logs time as the signed-in user.")
    if a.note:
        raise unsupported("timesheet notes", "create_timesheet_log has no note parameter; use --desc.")
    merge_file_fields(a, {"desc": "str", "new_task": "str", "task_desc": "str"})
    if not a.desc:
        raise BBError("bad_input", "a description of the work is required (--desc, or \"desc\" in --file)")
    emit_as(a, service.log_time(make_api(), config.load_state(), a.hours, a.activity, a.desc, a.task, a.new_task,
                                a.project, a.date, a.from_time, a.billable, a.meeting, a.workstream, a.task_desc,
                                a.allow_duplicate), render.log_time)


def cmd_create_mom(a) -> None:
    data = service.read_json_input(a.file)
    if a.project and isinstance(data, dict):
        data["project"] = a.project
    emit_as(a, service.create_mom(make_api(), config.load_state(), data, a.create_tasks, a.allow_duplicate),
            render.create_mom)


def collect_changes(a) -> dict:
    data = {}
    if a.file:
        loaded = service.read_json_input(a.file)
        if not isinstance(loaded, dict):
            raise BBError("bad_input", "--file must hold a JSON object of fields")
        data.update(loaded)
    if a.data:
        try:
            data.update(json.loads(a.data))
        except ValueError as e:
            raise BBError("bad_input", f"--data is not valid JSON: {e}") from None
    for kv in a.set or []:
        k, sep, v = kv.partition("=")
        if not sep or not k.strip():
            raise BBError("bad_input", f"--set expects field=value, got '{kv}'")
        data[k.strip()] = service.coerce(v)
    return data


def cmd_update(a) -> None:
    emit_as(a, service.update_record(make_api(), config.load_state(), a.doctype, a.name, collect_changes(a),
                                     a.completed_by, a.project), render.update)


def cmd_submit(a) -> None:
    raise unsupported(f"submitting {service.doctype_of(a.doctype)} documents",
                      "There is no submit endpoint; submit timesheets in Brewboard / ERPNext.")


def cmd_delete(a) -> None:
    emit_as(a, service.delete_record(make_api(), config.load_state(), a.doctype, a.name, a.project), render.delete)


# =============================================================== CLI wiring

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="bb.py", description="Brewboard CLI for the /bb agent skill. Prints JSON "
                                                          "(Markdown with --format table).")
    if hasattr(p, "color"):  # Python 3.14+ colours --help by default; keep it plain and predictable
        p.color = False
    sub = p.add_subparsers(dest="cmd", metavar="command")
    sub.required = True

    def add(name, fn, help_text, aliases=(), fmt=False, extra_formats=()):
        sp = sub.add_parser(name, help=help_text, description=help_text, aliases=list(aliases))
        if hasattr(sp, "color"):
            sp.color = False
        sp.set_defaults(fn=fn)
        if fmt == "text":
            sp.add_argument("--format", choices=["auto", "json", "text", *extra_formats], default="auto",
                            help="auto (default): readable text in a terminal, JSON otherwise"
                                 + ("; table: Markdown for the agent to print verbatim" if extra_formats else ""))
        elif fmt:
            sp.add_argument("--format", choices=["json", "table"], default="json",
                            help="table: Markdown for the agent to print verbatim")
        return sp

    def listing(sp, limit_default):
        sp.add_argument("--limit", type=int, default=limit_default, help="rows to show (positive integer)")
        sp.add_argument("--no-prompt", action="store_true", help="table without the selection prompt line")

    s = add("init", cmd_init, "Save the Brewboard URL + API key/secret (prompts if omitted) and verify the login",
            fmt="text")
    s.add_argument("--url")
    s.add_argument("--key")
    s.add_argument("--secret")
    s.add_argument("--login", action="store_true",
                   help="sign in with email + password (prompted) to obtain API keys; rotates the secret")
    s.add_argument("--user", help="login email for --login")

    add("whoami", cmd_whoami, "Show the logged-in user, roles and saved context", fmt="text")

    add("auth-check", cmd_auth_check, "Read-only: credential source, saved time and whether Brewboard accepts them",
        fmt="text", extra_formats=("table",))

    add("logout", cmd_logout, "Revoke this CLI's credential on the server and remove it locally", fmt="text")

    add("home", cmd_home, "The /bb home screen: banner, version, saved sign-in and context (local only)", fmt=True)

    s = add("credentials", cmd_credentials, "List your Brewboard API credentials (metadata only) or revoke one")
    s.add_argument("--revoke", metavar="CREDENTIAL", help="revoke one of your credentials by ID")
    s.add_argument("--revoke-others", action="store_true", help="revoke all your credentials except this one")

    s = add("ctx", cmd_ctx, "Show or change the working context (local only, no network)", fmt=True)
    s.add_argument("action", nargs="?", default="show",
                   choices=["show", "set-project", "set-task", "set-tickets", "clear"])
    s.add_argument("ids", nargs="*", help="IDs: project identifier, task ID, ticket IDs (clear: all|project|...)")
    s.add_argument("--title", help="display title for set-project / set-task")
    s.add_argument("--titles", nargs="+", help="display titles for set-tickets, same order as the IDs")
    s.add_argument("--record", help="set-project: the Project document name (e.g. PROJ-0001), if known")
    s.add_argument("--file", help="JSON object with title / titles / record instead of the options ('-' for stdin)")

    s = add("projects", cmd_projects, "List projects", fmt=True)
    s.add_argument("--status", default="Open", help="Open (default), Completed, Cancelled or all")
    s.add_argument("--search")
    s.add_argument("--archived", action="store_true", help="include archived projects")
    listing(s, 50)

    s = add("tasks", cmd_tasks, "List tasks of the selected (or given) project", fmt=True)
    s.add_argument("--project", help="project identifier")
    s.add_argument("--status", help="comma list, e.g. 'Open,Working' (default: all open statuses)")
    s.add_argument("--all", action="store_true", help="include Completed / Cancelled")
    s.add_argument("--mine", action="store_true", help="only tasks assigned to me")
    s.add_argument("--cycle", help="only tasks in this cycle (ID or name)")
    s.add_argument("--subtasks", action="store_true", help="include sub-tasks")
    s.add_argument("--search")
    listing(s, 50)

    s = add("tickets", cmd_tickets, "List issues (tickets) of the selected (or given) project", aliases=("issues",),
            fmt=True)
    s.add_argument("--project", help="project identifier")
    s.add_argument("--status", help="comma list (default: Open, Replied, On Hold)")
    s.add_argument("--all", action="store_true", help="include Resolved / Closed")
    s.add_argument("--priority", help="comma list, e.g. High,Medium")
    s.add_argument("--search")
    listing(s, 50)

    s = add("cycles", cmd_cycles, "List cycles of the selected (or given) project", fmt=True)
    s.add_argument("--project", help="project identifier")
    s.add_argument("--status", choices=["Active", "Upcoming", "Completed"])
    s.add_argument("--search")
    listing(s, 50)

    s = add("get", cmd_get, "Fetch one record: project, task, issue, cycle, mom, timesheet", fmt=True)
    s.add_argument("doctype")
    s.add_argument("name", help="record ID (project: its identifier)")
    s.add_argument("--project", help="project identifier (task / issue / mom)")

    s = add("attachments", cmd_attachments, "List (and download) the files attached to a task or ticket")
    s.add_argument("doctype", help="task or issue")
    s.add_argument("name")
    s.add_argument("--download", metavar="DIR", help="save every attachment into DIR")

    s = add("download", cmd_download, "Download a /files/ or /private/files/ URL from a task/ticket description")
    s.add_argument("url")
    s.add_argument("--dir", required=True, help="directory to save into (outside the repository)")

    s = add("update", cmd_update, "Change a task, issue, MoM or one time log (`update log <ENTRY>`)", fmt=True)
    s.add_argument("doctype", help="task, issue, mom, or log (a time-log entry)")
    s.add_argument("name")
    s.add_argument("--set", action="append", metavar="FIELD=VALUE")
    s.add_argument("--data", help="JSON object of fields")
    s.add_argument("--file", help="path to a JSON object of fields ('-' for stdin)")
    s.add_argument("--completed-by", help="user who completed the task (needed for status=Completed)")
    s.add_argument("--project", help="project identifier (task / issue / mom)")

    s = add("submit", cmd_submit, "Not supported by the Brewboard API (kept to explain why)")
    s.add_argument("doctype")
    s.add_argument("name")

    s = add("delete", cmd_delete, "Delete minutes of meeting (the only deletion the API offers)", fmt=True)
    s.add_argument("doctype")
    s.add_argument("name")
    s.add_argument("--project", help="project identifier")

    s = add("create-task", cmd_create_task, "Create a task in the selected (or given) project", fmt=True)
    s.add_argument("--subject", help="required, here or in --file")
    s.add_argument("--project", help="project identifier")
    s.add_argument("--desc")
    s.add_argument("--file", help="JSON object with subject / desc instead of the options ('-' for stdin)")
    s.add_argument("--priority", default="Medium", choices=["Low", "Medium", "High", "Urgent"])
    s.add_argument("--status", default="Open")
    s.add_argument("--start", help="expected start date")
    s.add_argument("--due", help="expected end date")
    s.add_argument("--issue", help="link to this ticket ID")
    s.add_argument("--parent", help="parent task ID")
    s.add_argument("--expected", help=argparse.SUPPRESS)
    s.add_argument("--no-assign", action="store_true", help="don't assign the task to me")

    add("activity-types", cmd_activity_types, "List activity types for time logs")

    s = add("users", cmd_users, "List project members (to resolve attendees / assignees)")
    s.add_argument("--project", help="project identifier (default: selected project)")
    s.add_argument("--workspace", action="store_true", help="all workspace members instead (role-restricted)")
    s.add_argument("--search")

    s = add("log-time", cmd_log_time, "Create a time log on a task (optionally creating the task first)", fmt=True)
    s.add_argument("--hours", required=True, help="2, 2.5, 2h, 90m, 1h30")
    s.add_argument("--activity", default="Development")
    s.add_argument("--desc", help="what was done (required, here or in --file)")
    s.add_argument("--task", help="existing task ID")
    s.add_argument("--new-task", metavar="SUBJECT", help="create this task first, then log against it")
    s.add_argument("--task-desc", help="description for --new-task (defaults to --desc)")
    s.add_argument("--file", help="JSON object with desc / new_task / task_desc instead of the options "
                                  "('-' for stdin)")
    s.add_argument("--project", help="project identifier")
    s.add_argument("--date", help="YYYY-MM-DD, today (default), yesterday")
    s.add_argument("--from", dest="from_time", metavar="HH:MM",
                   help="start time (default: first free slot after the day's existing logs, else 09:00)")
    s.add_argument("--billable", action="store_true")
    s.add_argument("--meeting", metavar="MOM-ID", help="the minutes of meeting this time was spent in")
    s.add_argument("--workstream", help="workstream (only on sites that have them)")
    s.add_argument("--allow-duplicate", action="store_true", help="log even if an identical entry exists")
    for legacy in ("--no-task", "--submit"):
        s.add_argument(legacy, action="store_true", help=argparse.SUPPRESS)
    s.add_argument("--employee", help=argparse.SUPPRESS)
    s.add_argument("--note", help=argparse.SUPPRESS)

    s = add("timesheets", cmd_timesheets, "List my time logs (one row per entry)", fmt=True)
    s.add_argument("--project", help="project identifier")
    s.add_argument("--since", help="date")
    s.add_argument("--until", help="date")
    s.add_argument("--status", choices=["Draft", "Submitted", "Cancelled"])
    s.add_argument("--all-users", action="store_true")
    s.add_argument("--billable", action="store_true")
    s.add_argument("--non-billable", action="store_true")
    s.add_argument("--details", action="store_true", help=argparse.SUPPRESS)  # rows are always detailed now
    s.add_argument("--employee", help=argparse.SUPPRESS)
    listing(s, 20)

    s = add("moms", cmd_moms, "List minutes of meeting", fmt=True)
    s.add_argument("--project", help="project identifier")
    s.add_argument("--all-projects", action="store_true")
    s.add_argument("--search")
    listing(s, 20)

    s = add("create-mom", cmd_create_mom, "Create minutes of meeting from a JSON file", fmt=True)
    s.add_argument("--file", required=True, help="path to MoM JSON ('-' for stdin); see reference/contract.md")
    s.add_argument("--project", help="project identifier (default: \"project\" in the JSON, else the selected one)")
    s.add_argument("--create-tasks", action="store_true", help="create a task for each open action item")
    s.add_argument("--allow-duplicate", action="store_true", help="create even if the same meeting exists")

    s = add("find", cmd_find, "Search tasks, tickets, MoMs, time logs, projects and cycles", fmt=True)
    s.add_argument("query")
    s.add_argument("--project", help="project identifier")
    s.add_argument("--all-projects", action="store_true")
    s.add_argument("--types", default="task,issue,mom,timesheet,project,cycle")
    s.add_argument("--limit", type=int, default=8, help="max results per type")
    s.add_argument("--deep", type=int, default=15, help="open the full text of this many recent MoMs")
    return p


def explain_auth_failure(e: BBError) -> BBError:
    """Turn a bare 401 into credentials_rejected / endpoint_auth_failed (one read-only identity probe)."""
    try:
        cfg = config.load_config()
        return diagnose.diagnose_auth_failure(make_api(cfg), e, cfg)
    except BBError:
        return e


def main(argv=None) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass
    args = build_parser().parse_args(argv)
    try:
        args.fn(args)
    except BBError as e:
        if e.code == "auth_failed" and args.cmd not in ("init", "logout"):
            e = explain_auth_failure(e)
        if human_errors(args):  # a person is reading: problem, context, next step
            sys.stderr.write(ui.error_text(e.as_dict(), ui.Style(sys.stderr)))
        else:
            sys.stderr.write(json.dumps(e.as_dict(), indent=2, ensure_ascii=False, default=str) + "\n")
        return 1
    except KeyboardInterrupt:
        return 130
    except BrokenPipeError:  # output piped into head etc.
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())

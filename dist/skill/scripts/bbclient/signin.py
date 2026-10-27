"""One interactive sign-in at a time, and opening it in a new terminal for the coding agent.

~/.bb/login.lock is the installer's lock (lib/lock.js): created exclusively with {"pid", "started"} by the
process that runs the sign-in, stale when that process is gone or after 30 minutes. `init --login --launch`
adds a pending lock ({"pid": null, "pending": true}) while the new terminal starts; it counts as held for
60 seconds, so a retried /bb init --login does not open a second sign-in, and the sign-in it started takes
it over.

The agent's shell has no terminal for the hidden password prompt, so `launch()` opens a real terminal that
runs `bb.py init --login --pause` and returns at once. It never sees or forwards a password or API secret.
"""
from __future__ import annotations

import json
import os
import shlex
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from . import config, terminal
from .errors import BBError

STALE_SECONDS = 30 * 60
PENDING_SECONDS = 60
CONFIRM_SECONDS = 10
TITLE = "Brewboard sign-in"


def lock_file() -> Path:
    return config.bb_home() / "login.lock"


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except (OSError, ValueError, TypeError):
        return False
    return True


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _age(started) -> float:
    try:
        t = datetime.fromisoformat(str(started).replace("Z", "+00:00"))
    except ValueError:
        return float("inf")
    if t.tzinfo is None:
        t = t.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - t).total_seconds()


def inspect(path: Path | None = None) -> dict | None:
    """The lock's content plus `active`, or None if there is no readable lock."""
    try:
        info = json.loads((path or lock_file()).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(info, dict):
        return None
    age = _age(info.get("started"))
    pid = info.get("pid")
    active = (_alive(pid) and age < STALE_SECONDS) if pid else (bool(info.get("pending")) and age < PENDING_SECONDS)
    return {**info, "active": active}


def _create(path: Path, data: dict) -> bool:
    try:
        fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        return False
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f)
    return True


def acquire(pending: bool = False) -> dict:
    """{"acquired": True} or {"acquired": False, "holder": <lock>}. A sign-in (pending=False) takes over a
    pending lock; a launcher (pending=True) never does. Raises file_error if ~/.bb cannot be written."""
    path = lock_file()
    data = {"pid": None, "pending": True, "launcher": os.getpid(), "started": _now()} if pending else \
        {"pid": os.getpid(), "started": _now()}
    try:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        for _ in range(2):
            if _create(path, data):
                return {"acquired": True}
            held = inspect(path)
            if held and held["active"] and (pending or not held.get("pending")):
                return {"acquired": False, "holder": held}
            path.unlink(missing_ok=True)  # stale, or a pending lock handed over to the sign-in
    except OSError as e:
        raise BBError("file_error", f"Could not use {path}: {e.strerror or e}.") from None
    return {"acquired": False, "holder": inspect(path)}


def release(pending: bool = False) -> None:
    """Remove the lock if this process holds it (as the sign-in, or as the launcher of a pending one)."""
    held = inspect()
    if held and (held.get("launcher") == os.getpid() if pending else held.get("pid") == os.getpid()):
        try:
            lock_file().unlink()
        except OSError:
            pass


def manual_command() -> str:
    """What a person types in their own terminal when no terminal can be opened for them."""
    return f"python3 {shlex.quote(config.script_path())} init --login"


def terminal_env(env) -> dict:
    """The new terminal's environment: this one without the BB_URL / BB_API_KEY / BB_API_SECRET /
    BB_AUTH_SOURCE overrides, so a sign-in never runs with (or exposes) credentials from the environment."""
    drop = {name for _, name in config.ENV_KEYS}
    return {k: v for k, v in env.items() if k not in drop}


def sign_in_command(env) -> list:
    """The command the new terminal runs: this Python, the installed bb.py, `init --login --pause`. BB_HOME is
    repeated on the command line because some terminals start tabs from their own server, without this
    environment. Nothing secret is ever on it."""
    cmd = [sys.executable or "python3", config.script_path(), "init", "--login", "--pause"]
    return (["env", f"BB_HOME={env['BB_HOME']}"] + cmd) if env.get("BB_HOME") else cmd


def _not_opened(reason: str) -> BBError:
    manual = manual_command()
    return BBError("terminal_unavailable", f"Could not open a terminal for the Brewboard sign-in: {reason}.",
                   reason=reason, command=manual, next_steps=[f"Run this in your own terminal: {manual}"])


def launch(env=None, *, find=terminal.find_terminal, no_gui=terminal.no_gui_reason, start=terminal.start,
           wait: float = CONFIRM_SECONDS, sleep=time.sleep, clock=time.monotonic) -> dict:
    """Open the interactive sign-in in a new terminal tab or window. Returns
       {"status": "started"}    the sign-in is running in the new terminal (it took over the lock),
       {"status": "requested"}  the terminal accepted the request, but the sign-in has not started yet,
       {"status": "already_running"}  another sign-in holds the lock: nothing was opened,
    each with "terminal", "mode" and the manual "command". Raises terminal_unavailable when no terminal could
    be opened, so nothing ever reports a sign-in that was not started. It never waits for the sign-in."""
    env = dict(os.environ if env is None else env)
    out = {"command": manual_command()}
    got = acquire(pending=True)
    if not got["acquired"]:
        holder = got.get("holder") or {}
        return {**out, "status": "already_running", "since": holder.get("started"), "pid": holder.get("pid")}
    try:
        reason = no_gui(env)
        term = None if reason else find(env)
        if not term:
            names = ", ".join(t["name"] for t in terminal.load_terminals())
            raise _not_opened(reason or f"no supported terminal is installed ({names})")
        out.update(terminal=term["name"], mode=term.get("mode", "window"))
        try:
            proc = start(term, TITLE, sign_in_command(env), terminal_env(env))
        except OSError as e:
            raise _not_opened(f"{term['name']} could not be started ({e.strerror or e})") from None
        deadline = clock() + wait
        while True:
            held = inspect()
            if held and held.get("pid") and held["active"] and not held.get("pending"):
                return {**out, "status": "started"}
            code = proc.poll()
            if code not in (None, 0):
                raise _not_opened(f"{term['name']} exited with code {code}")
            if clock() >= deadline:
                return {**out, "status": "requested"}  # the pending lock stays, so a quick retry waits
            sleep(0.2)
    except BaseException:
        release(pending=True)
        raise


def pause(stream=None) -> None:
    """End of the sign-in terminal: keep the result readable until the person closes it."""
    stream = stream or sys.stdout
    stream.write("\nReturn to your coding agent and run /bb init to check the connection.\n"
                 "Press Enter to close this window.")
    stream.flush()
    try:
        input()
    except (EOFError, KeyboardInterrupt):
        pass

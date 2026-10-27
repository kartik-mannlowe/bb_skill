"""Finding and opening a terminal for the interactive sign-in (`bb.py init --login --launch`).

The terminals and their argument templates are in assets/terminals.json, shared with the installer
(lib/terminal.js), so both choose and open terminals the same way. A launch is an argument list run without
a shell: paths with spaces stay one argument and nothing is interpolated. The command carries no secret;
the password is typed into the new terminal.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ASSET = Path(__file__).resolve().parents[2] / "assets" / "terminals.json"
GENERIC = "x-terminal-emulator"


def load_terminals(path: Path = ASSET) -> list:
    return json.loads(path.read_text(encoding="utf-8"))["terminals"]


def no_gui_reason(env=None, exists=os.path.exists, platform: str = sys.platform) -> str | None:
    """Why no graphical terminal can be opened here, or None if one can (same rules as the installer)."""
    env = os.environ if env is None else env
    if env.get("SSH_CONNECTION") or env.get("SSH_CLIENT") or env.get("SSH_TTY"):
        return "this is an SSH session"
    if exists("/.dockerenv") or exists("/run/.containerenv") or env.get("container"):
        return "this runs inside a container"
    if platform.startswith("linux") and not env.get("DISPLAY") and not env.get("WAYLAND_DISPLAY"):
        return "there is no graphical session"
    if not platform.startswith("linux"):
        return f"opening a terminal is implemented for Linux desktops only ({platform})"
    return None


def find_terminal(env=None, which=None, realpath=os.path.realpath, terminals: list | None = None) -> dict | None:
    """The forced one (BB_TERMINAL), else the terminal the user is in (if installed), else the distribution's
    default (x-terminal-emulator), else the first installed one: tab terminals before window-only ones."""
    env = os.environ if env is None else env
    which = which or (lambda b: shutil.which(b, path=env.get("PATH")))
    terms = load_terminals() if terminals is None else terminals
    forced = env.get("BB_TERMINAL")
    if forced:
        if forced == "none":
            return None
        match = next((t for t in terms if t["name"] == forced), None)
        if match and which(match["bin"]):
            return match
    current = next((t for t in terms if any(env.get(k) for k in t.get("env", [])) and which(t["bin"])), None)
    if current:
        return current
    alt = which(GENERIC)
    if alt:
        base = os.path.basename(realpath(alt))
        base = base[:-len(".wrapper")] if base.endswith(".wrapper") else base
        default = next((t for t in terms if t["bin"] != GENERIC and (base == t["bin"] or base.startswith(t["bin"]))),
                       None)
        if default:
            return default
    return next((t for t in terms if which(t["bin"])), None)


def argv(term: dict, title: str, command: list) -> list:
    """The terminal's full argument list: its template with the title and the command filled in."""
    out = [term["bin"]]
    for a in term["args"]:
        if a == "{command}":
            out += list(command)
        else:
            out.append(a.replace("{title}", title))
    return out


def start(term: dict, title: str, command: list, env=None, popen=subprocess.Popen):
    """Start the terminal detached from this process (its own session, no stdio). Raises OSError."""
    return popen(argv(term, title, command), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                 stderr=subprocess.DEVNULL, start_new_session=True, env=dict(os.environ if env is None else env))

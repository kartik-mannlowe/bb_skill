"""Presentation for a person at a terminal (agents never see this).

Agents run bb.py with captured output and get JSON, or Markdown from render.py: no colour, no symbols
that depend on the terminal. This module is used only when a person runs bb.py in a terminal
(`init`, `auth-check`, `whoami`, `logout`, and error messages):

  - colour only on a TTY, never with NO_COLOR set (any non-empty value) or TERM=dumb;
  - Unicode status symbols only in a UTF-8 locale, otherwise ASCII words (BB_ASCII=1 forces ASCII);
  - the banner is printed at most once per process and uses the widest wordmark that fits.

The wordmark lives in skill/assets/banner.txt, shared with the npx installer (lib/ui.js).
"""
from __future__ import annotations

import json
import os
import shlex
import shutil
import sys
from pathlib import Path

from . import config

ASSET = Path(__file__).resolve().parents[2] / "assets" / "banner.txt"
WORDMARK = "B R E W B O A R D"
TAGLINE = "Your workspace. Your workflow."

# level -> (unicode symbol, ascii fallback, colour)
LEVELS = {
    "ok": ("✓", "ok", "32"),
    "warn": ("!", "!!", "33"),
    "error": ("✗", "XX", "31"),
    "info": ("•", "--", "36"),
    "next": ("›", ">", "36"),
}
ROLES = {"heading": "1;36", "logo": "1;36", "bold": "1", "dim": "2"}


# ---------------------------------------------------------------- terminal capabilities

def color_enabled(stream, env=None) -> bool:
    env = os.environ if env is None else env
    if env.get("NO_COLOR") or env.get("TERM") == "dumb":
        return False
    try:
        return bool(stream.isatty())
    except (AttributeError, ValueError):
        return False


def unicode_enabled(env=None) -> bool:
    env = os.environ if env is None else env
    if env.get("BB_ASCII") or env.get("TERM") == "dumb":
        return False
    loc = (env.get("LC_ALL") or env.get("LC_CTYPE") or env.get("LANG") or "").lower()
    return "utf-8" in loc or "utf8" in loc


def terminal_width(env=None, default: int = 80) -> int:
    env = os.environ if env is None else env
    try:
        cols = int(env.get("COLUMNS") or 0)
    except ValueError:
        cols = 0
    return cols if cols > 0 else shutil.get_terminal_size((default, 24)).columns


class Style:
    """Colour and symbols for one output stream, decided once."""

    def __init__(self, stream=None, env=None):
        self.stream = stream or sys.stdout
        self.color = color_enabled(self.stream, env)
        self.unicode = unicode_enabled(env)

    def paint(self, text: str, role: str) -> str:
        code = ROLES.get(role) or LEVELS.get(role, (None, None, None))[2]
        return f"\x1b[{code}m{text}\x1b[0m" if self.color and code and text else text

    def symbol(self, level: str) -> str:
        sym, ascii_, _ = LEVELS[level]
        return sym if self.unicode else ascii_

    def status(self, level: str, text: str) -> str:
        return f"{self.paint(self.symbol(level), level)} {text}"

    def heading(self, text: str) -> str:
        return self.paint(text, "heading")

    def fields(self, pairs: list, indent: str = "  ") -> list:
        """Aligned `label  value` lines; pairs without a value are left out."""
        pairs = [(k, v) for k, v in pairs if v not in (None, "", [])]
        width = max((len(k) for k, _ in pairs), default=0)
        return [f"{indent}{self.paint(k.ljust(width), 'dim')}  {v}" for k, v in pairs]


# ---------------------------------------------------------------- banner

def load_art(path: Path = ASSET) -> dict:
    """{variant: [lines]} plus "tagline", from banner.txt; {} if the file is missing."""
    art, current = {}, None
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return {}
    for line in text.splitlines():
        if line.startswith(";"):
            continue
        if line.startswith("[") and line.rstrip().endswith("]"):
            current = line.strip()[1:-1]
            art[current] = []
        elif current:
            art[current].append(line.rstrip())
    tagline = " ".join(art.pop("tagline", [])).strip()
    art = {k: v for k, v in art.items() if v}
    if tagline:
        art["tagline"] = tagline
    return art


def logo(width: int, art: dict | None = None) -> list:
    """The widest wordmark that fits in `width` columns, else the one-line wordmark (unspaced if need be)."""
    art = load_art() if art is None else art
    for name, lines in art.items():
        if name != "tagline" and max(map(len, lines)) <= width:
            return list(lines)
    return [WORDMARK] if len(WORDMARK) <= width else [WORDMARK.replace(" ", "")]


def banner_parts(width: int = 80, version: str | None = None, art: dict | None = None) -> tuple:
    """(wordmark lines, tagline lines): the version sits at the right edge of the tagline when it fits."""
    art = load_art() if art is None else art
    mark = logo(width, art)
    tagline = art.get("tagline") or TAGLINE
    ver = f"v{version}" if version else ""
    span = max(max(map(len, mark)), len(tagline))
    if ver and len(tagline) + 2 + len(ver) <= span <= width:
        return mark, [tagline.ljust(span - len(ver)) + ver]
    if len(tagline) > width:  # very narrow: the tagline wraps at its sentence break
        return mark, tagline.replace(". ", ".\n").split("\n") + ([ver] if ver else [])
    return mark, [tagline] + ([ver] if ver else [])


def banner_lines(width: int = 80, version: str | None = None, status: list | None = None,
                 art: dict | None = None) -> list:
    """Plain banner text (no colour): wordmark, tagline and version, then any status lines."""
    mark, info = banner_parts(width, version, art)
    return mark + info + list(status or [])


def styled_banner(style: Style, width: int, version: str | None = None, status: list | None = None) -> str:
    mark, info = banner_parts(width - 2, version)
    out = [""] + ["  " + style.paint(x, "logo") for x in mark] + ["  " + style.paint(x, "dim") for x in info]
    out += ["  " + s for s in status or []]
    return "\n".join(out) + "\n\n"


_banner_shown = False


def print_banner(stream=None, version: str | None = None, status: list | None = None, env=None) -> bool:
    """Print the banner once per process; later calls do nothing and return False."""
    global _banner_shown
    if _banner_shown:
        return False
    _banner_shown = True
    stream = stream or sys.stdout
    stream.write(styled_banner(Style(stream, env), terminal_width(env), version, status))
    stream.flush()
    return True


def installed_version() -> str | None:
    """The package version recorded by the npx installer, when this bb.py is the installed copy."""
    home = config.bb_home()
    try:
        if Path(config.script_path()).resolve() != (home / "skill" / "scripts" / "bb.py").resolve():
            return None
        v = json.loads((home / "installed.json").read_text(encoding="utf-8")).get("version")
    except (OSError, ValueError, AttributeError):
        return None
    return v if isinstance(v, str) and v else None


# ---------------------------------------------------------------- sign-in commands (init, auth-check, whoami, logout)

def _who(d: dict) -> str:
    user = d.get("user")
    name = d.get("full_name")
    return f"{name} ({user})" if name and name != user else (user or "unknown user")


def _roles(roles) -> str:
    return ", ".join(r for r in roles or [] if r.startswith("BB ") or r == "System Manager") or "no Brewboard role"


def _ctx_line(ctx: dict) -> str | None:
    p, t = (ctx or {}).get("project"), (ctx or {}).get("task")
    parts = [p and f"project {p['identifier']}", t and f"task {t['name']}"]
    return ", ".join(x for x in parts if x) or None


def _credential(cred: dict) -> str | None:
    if not cred:
        return None
    if cred.get("auth_source"):
        return f"this CLI only ({cred.get('credential') or 'per-client'})"
    return "the account's own API key pair" if cred.get("key_fp") else None


def account_text(kind: str, out: dict, style: Style) -> str:
    """What a person sees for init / auth-check / whoami / logout on a terminal (JSON otherwise)."""
    lines = []
    if kind == "logout":
        revoked = out.get("revoked")
        lines.append(style.status("ok", "Signed out of Brewboard on this computer."))
        lines += style.fields([("Revoked", revoked and ", ".join(revoked)), ("Config", out.get("config_file"))])
        lines += [style.status("info", n) for n in (out.get("note"),) if n]
        lines += [style.status("warn", w) for w in (out.get("warning"),) if w]
        return "\n".join(lines) + "\n"
    if kind == "auth-check":
        status = out.get("status")
        cred = out.get("credentials") or {}
        if status == "ok":
            lines.append(style.status("ok", f"Brewboard accepts the saved sign-in for {_who(out)}."))
        elif status == "not_configured":
            lines.append(style.status("warn", f"{style.paint('Not signed in', 'bold')}: no Brewboard sign-in is saved."))
        else:
            lines.append(style.status("error", f"{style.paint(TITLES.get(status, 'Sign-in problem'), 'bold')}: "
                                               f"{out.get('message') or status}"))
        lines += style.fields([("Site", out.get("url")), ("Roles", out.get("roles") and _roles(out["roles"])),
                               ("Credential", _credential(cred)), ("Expires", cred.get("expires_on")),
                               ("Saved", cred.get("saved_at")), ("Config", cred.get("config_file"))])
        steps = list(out.get("next_steps") or []) or ([hint(status)] if status != "ok" and hint(status) else [])
        lines += [f"  {style.paint(style.symbol('next'), 'next')} {s}" for s in steps]
        return "\n".join(lines) + "\n"
    verb = "Signed in" if kind == "init" else "Signed in as"
    lines.append(style.status("ok", f"{verb} {'to ' + out['site'] + ' as ' if kind == 'init' else ''}{_who(out)}."))
    lines += style.fields([("Site", None if kind == "init" else out.get("site")), ("Roles", _roles(out.get("roles"))),
                           ("Saved to", out.get("config_file") and f"{out['config_file']} (private)"),
                           ("Context", _ctx_line(out.get("context")))])
    lines += [style.status("info", n) for n in out.get("notes") or []]
    if not any(r.startswith("BB ") or r == "System Manager" for r in out.get("roles") or []):
        lines.append(style.status("warn", "This account has no Brewboard role, so Brewboard will refuse most "
                                          "requests. Ask an administrator for one."))
    if kind == "init":
        lines.append(f"  {style.paint(style.symbol('next'), 'next')} Open your coding agent and type /bb.")
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------- errors

TITLES = {
    "not_configured": "Not signed in",
    "auth_failed": "Sign-in rejected",
    "credentials_rejected": "Saved sign-in no longer accepted",
    "endpoint_auth_failed": "Request refused",
    "forbidden": "Not allowed",
    "not_found": "Not found",
    "validation_error": "Brewboard rejected the input",
    "rate_limited": "Too many requests",
    "server_error": "Brewboard server error",
    "unreachable": "Connection failed",
    "write_outcome_unknown": "Outcome unknown",
    "http_error": "Unexpected response",
    "redirect_refused": "Redirect refused",
    "bad_response": "Unexpected response",
    "not_brewboard": "Not a Brewboard server",
    "api_unsupported": "Not supported by Brewboard",
    "bad_input": "Invalid input",
    "possible_duplicate": "Possible duplicate",
    "no_project": "No project selected",
}


def hint(code: str) -> str | None:
    """A corrective step that is always right for this error code, or None."""
    bb = f"python3 {shlex.quote(config.script_path())}"
    return {
        "not_configured": f"Sign in: {bb} init --login",
        "credentials_rejected": f"Sign in again: {bb} init --login",
        "unreachable": "Check the URL, your VPN, or that the Brewboard server is running.",
        "forbidden": "Your Brewboard role or project membership does not allow this; ask a project manager.",
        "no_project": "Select a project first (/bb list_projects), or pass --project <IDENTIFIER>.",
        "write_outcome_unknown": "Do not retry yet: check whether it was saved (bb.py timesheets, bb.py moms).",
        "not_brewboard": "Use the address of your Brewboard backend.",
        "redirect_refused": f"Run {bb} init with the address the server redirects to.",
        "possible_duplicate": "Nothing was created. Add --allow-duplicate if it really is a second entry.",
        "rate_limited": "Wait a moment, then try again.",
    }.get(code)


def _compact(v) -> str:
    if isinstance(v, (list, tuple)):
        return ", ".join(_compact(x) for x in v)
    if isinstance(v, dict):
        return ", ".join(f"{k} {_compact(x)}" for k, x in v.items() if x not in (None, ""))
    return str(v)


def error_text(err: dict, style: Style) -> str:
    """Problem, context and next step for a person; `err` is BBError.as_dict(). Never holds secrets."""
    code = err.get("error") or "error"
    lines = [style.status("error", f"{style.paint(TITLES.get(code, 'Error'), 'bold')}: {err.get('message', '')}")]
    context = [(k.replace("_", " ").capitalize(), _compact(v)) for k, v in err.items()
               if k not in ("error", "message", "next_steps") and v not in (None, "", [], {})]
    lines += style.fields(context)
    steps = list(err.get("next_steps") or [])
    h = hint(code)
    if not steps and h and not (code in ("not_configured", "credentials_rejected") and " init" in
                                str(err.get("message", ""))):
        steps = [h]
    lines += [f"  {style.paint(style.symbol('next'), 'next')} {s}" for s in steps]
    lines.append("  " + style.paint(f"code: {code}", "dim"))
    return "\n".join(lines) + "\n"

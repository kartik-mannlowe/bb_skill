"""Shared helpers for the Python tests: import path, ANSI handling, running bb.py (pipes or a pseudo-terminal)."""
import json
import os
import re
import select
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "dist" / "skill" / "scripts"
BB_PY = SCRIPTS / "bb.py"
sys.path.insert(0, str(SCRIPTS))

ANSI = re.compile(r"\x1b\[[0-9;]*m")
BOX = re.compile("[─-╿]")


def strip_ansi(s: str) -> str:
    return ANSI.sub("", s)


def squash(s: str) -> str:
    """Whitespace-insensitive form, so cosmetic spacing changes do not break assertions."""
    return " ".join(strip_ansi(s).split())


def clean_env(home: str, **extra) -> dict:
    """A minimal environment: no real ~/.bb, no Brewboard variables, no colour settings from the caller."""
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": home, "BB_HOME": home,
           "PYTHONDONTWRITEBYTECODE": "1", "LANG": "en_US.UTF-8", "TERM": "xterm-256color"}
    env.update({k: v for k, v in extra.items() if v is not None})
    return env


class TempHome:
    def __enter__(self):
        self._d = tempfile.TemporaryDirectory(prefix="bb-pytest-")
        return self._d.name

    def __exit__(self, *exc):
        self._d.cleanup()


def run(args, home, stdin_text=None, **env):
    """bb.py with pipes (what an agent sees)."""
    return subprocess.run([sys.executable, "-B", str(BB_PY), *args], input=stdin_text, capture_output=True,
                          text=True, env=clean_env(home, **env), timeout=30)


def run_tty(args, home, typed: bytes = b"", cols: int = 100, **env):
    """bb.py on a pseudo-terminal (what a person sees): returns (exit status, everything the terminal showed)."""
    import pty
    pid, fd = pty.fork()
    if pid == 0:  # child
        try:
            e = clean_env(home, COLUMNS=str(cols), **env)
            os.execve(sys.executable, [sys.executable, "-B", str(BB_PY), *args], e)
        finally:
            os._exit(127)
    out, sent, t0 = b"", False, time.time()
    while time.time() - t0 < 25:
        ready, _, _ = select.select([fd], [], [], 0.2)
        if ready:
            try:
                chunk = os.read(fd, 4096)
            except OSError:
                break
            if not chunk:
                break
            out += chunk
        elif typed and not sent and out:
            os.write(fd, typed)
            sent = True
    _, status = os.waitpid(pid, 0)
    os.close(fd)
    return os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else status >> 8, \
        out.decode("utf-8", "replace").replace("\r\n", "\n")


def write_config(home: str, url: str = "http://127.0.0.1:9", user: str = "dev@bb.local") -> None:
    p = Path(home) / "config.json"
    p.write_text(json.dumps({"url": url, "api_key": "k-test", "api_secret": "s-test-not-real", "user": user}))
    os.chmod(p, 0o600)


def write_state(home: str, st: dict) -> None:
    (Path(home) / "state.json").write_text(json.dumps(st))

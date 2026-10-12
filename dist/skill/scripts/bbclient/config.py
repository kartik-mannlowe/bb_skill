"""Connection settings and the local working context.

Files (directory overridable with BB_HOME):
    ~/.bb/config.json  url, api_key, api_secret (mode 600). BB_URL / BB_API_KEY / BB_API_SECRET override.
    ~/.bb/state.json   working context: user, selected project / task / tickets.
                       Override the path with BB_STATE_FILE (e.g. one per repo).
The state never holds list results: every list is fetched fresh.
"""
from __future__ import annotations

import json
import os
from datetime import datetime
from pathlib import Path

from .errors import BBError

ENV_KEYS = (("url", "BB_URL"), ("api_key", "BB_API_KEY"), ("api_secret", "BB_API_SECRET"),
            ("auth_source", "BB_AUTH_SOURCE"))
CREDENTIAL_KEYS = ("api_key", "api_secret", "auth_source", "credential", "expires_on", "obtained_via", "saved_at",
                   "user")


def bb_home() -> Path:
    return Path(os.environ.get("BB_HOME") or Path.home() / ".bb")


def config_file() -> Path:
    return bb_home() / "config.json"


def state_file() -> Path:
    return Path(os.environ.get("BB_STATE_FILE") or bb_home() / "state.json")


def script_path() -> str:
    """Where bb.py actually lives (~/.bb/skill/scripts for install.sh, elsewhere for other installs)."""
    return str(Path(__file__).resolve().parent.parent / "bb.py")


def timeout() -> float:
    try:
        return float(os.environ.get("BB_TIMEOUT", "30"))
    except ValueError:
        raise BBError("bad_input", "BB_TIMEOUT must be a number of seconds") from None


def load_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default
    except ValueError:
        raise BBError("bad_input", f"{path} is not valid JSON; fix or delete it") from None


def save_json(path: Path, data, private: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    if private:
        os.chmod(tmp, 0o600)
    tmp.replace(path)


def load_config(required: bool = True) -> dict:
    """Effective settings. `_source` records where each credential came from ("file" or "env")."""
    cfg = load_json(config_file(), {})
    if not isinstance(cfg, dict):
        raise BBError("bad_input", f"{config_file()} must hold a JSON object")
    source = {k: "file" for k in ("url", "api_key", "api_secret", "auth_source") if cfg.get(k)}
    for key, env in ENV_KEYS:
        if os.environ.get(env):
            cfg[key] = os.environ[env]
            source[key] = "env"
    if required and not all(cfg.get(k) for k in ("url", "api_key", "api_secret")):
        raise BBError("not_configured", f"Brewboard connection is not set up. Run in a terminal: python3 {script_path()} init")
    if cfg.get("url"):
        cfg["url"] = cfg["url"].rstrip("/")
    cfg["_source"] = source
    return cfg


def env_overrides() -> list:
    return [env for _key, env in ENV_KEYS if os.environ.get(env)]


def save_config(url: str, api_key: str, api_secret: str, obtained_via: str | None = None,
                user: str | None = None, auth_source: str | None = None, credential: str | None = None,
                expires_on: str | None = None) -> Path:
    """Write config.json (mode 600). Besides the credentials it records when and how they were
    obtained (and, for a per-client credential, its DocType, ID and expiry), so a later 401 can be
    explained. Only `init` calls this; `logout` calls clear_credentials."""
    path = config_file()
    data = {"url": url.rstrip("/"), "api_key": api_key, "api_secret": api_secret}
    if obtained_via:
        data.update({"obtained_via": obtained_via, "saved_at": datetime.now().isoformat(timespec="seconds"),
                     "user": user})
    if auth_source:
        data.update({"auth_source": auth_source, "credential": credential, "expires_on": expires_on})
    save_json(path, data, private=True)
    return path


def clear_credentials() -> Path:
    """Remove the credentials from config.json, keeping the URL (used by `logout`)."""
    path = config_file()
    data = load_json(path, {})
    save_json(path, {k: v for k, v in data.items() if k not in CREDENTIAL_KEYS}, private=True)
    return path


def fingerprint(value: str | None) -> str | None:
    """Short one-way fingerprint for comparing credentials without showing them."""
    import hashlib
    return hashlib.sha256(value.encode()).hexdigest()[:10] if value else None


def credential_view(cfg: dict) -> dict:
    """Safe metadata about the credentials in use: never the key or secret themselves."""
    path = config_file()
    info = {"config_file": str(path), "source": dict(cfg.get("_source") or {}),
            "saved_at": cfg.get("saved_at"), "obtained_via": cfg.get("obtained_via"), "saved_for": cfg.get("user"),
            "auth_source": cfg.get("auth_source"), "credential": cfg.get("credential"),
            "expires_on": cfg.get("expires_on"),
            "key_fp": fingerprint(cfg.get("api_key")), "secret_fp": fingerprint(cfg.get("api_secret"))}
    try:
        st = path.stat()
        info["file_mode"] = oct(st.st_mode & 0o777)
        info["file_modified"] = datetime.fromtimestamp(st.st_mtime).isoformat(timespec="seconds")
    except FileNotFoundError:
        info["file_mode"] = None
    return info


# ------------------------------------------------------------------ working context

def load_state() -> dict:
    st = load_json(state_file(), {})
    return st if isinstance(st, dict) else {}


def save_state(st: dict) -> None:
    st["updated"] = datetime.now().isoformat(timespec="seconds")
    save_json(state_file(), st)


def project_ctx(st: dict) -> dict | None:
    """The selected project, or None. A project saved by the old Frappe-REST CLI has no
    `identifier` and cannot address the Brewboard API, so it counts as not selected."""
    p = st.get("project") or None
    return p if p and p.get("identifier") else None


def context_view(st: dict) -> dict:
    view = {"project": project_ctx(st), "task": st.get("task"), "tickets": st.get("tickets") or []}
    if st.get("project") and not project_ctx(st):
        view["note"] = ("The saved project is from the previous backend and has no Brewboard identifier; "
                        "select it again with /bb list_projects.")
    return view


def remember_identity(info: dict) -> dict:
    """Save who is logged in where. A different site or user invalidates the selections."""
    st = load_state()
    if (st.get("site") and st["site"] != info["site"]) or (st.get("user") and st["user"] != info["user"]):
        st = {}
    for stale in ("employee", "employee_name"):  # the old backend's identity fields
        st.pop(stale, None)
    st.update({k: info.get(k) for k in ("user", "full_name", "roles", "site")})
    save_state(st)
    return st

"""Explain an authentication failure precisely instead of guessing.

A 401 from one endpoint is checked against the identity endpoint with the same credentials:
- identity works too  -> `endpoint_auth_failed`: the credentials are valid, that endpoint is not;
- identity also 401   -> `credentials_rejected`: the server no longer accepts this key/secret.

Brewboard issues a new API secret on every sign-in through auth.login_and_get_keys (the
Brewboard web UI login page and `bb.py init --login` both use it), and the previous secret stops
working at once. The diagnosis says so with the time these credentials were saved. It never
signs in, rotates or rewrites anything: re-authenticating automatically would revoke the other
client's secret and destroy the evidence.
"""
from __future__ import annotations

from . import config
from .api import ENDPOINTS, PREFIX
from .errors import BBError

IDENTITY = PREFIX + ENDPOINTS["current_user"][1]


def diagnose_auth_failure(api, err: BBError, cfg: dict) -> BBError:
    if err.code != "auth_failed":
        return err
    endpoint = err.extra.get("endpoint")
    creds = config.credential_view(cfg)
    who, probe = None, None
    if endpoint != IDENTITY:
        try:
            who = api.current_user()  # read-only identity probe, same credentials
        except BBError as e:
            probe = e
    if who:
        return BBError(
            "endpoint_auth_failed",
            f"{endpoint} answered 401, but the same credentials still authenticate as {who.get('name')} on "
            f"{IDENTITY}. The credentials are valid; this endpoint rejected the request. Do not sign in again: "
            "report the endpoint and time to the Brewboard backend team.",
            status=401, endpoint=endpoint, identity="ok", credentials=creds)
    if probe is not None and probe.code != "auth_failed":
        err.extra.update(identity_check=f"{probe.code}: {probe.message}", credentials=creds)
        return err

    env = sorted(k for k, v in creds["source"].items() if v == "env" and k != "url")
    when = creds.get("saved_at") or creds.get("file_modified") or "an unknown time"
    how = {"login": "by `bb.py init --login`", "keys": "by `bb.py init` with an API key and secret"}.get(
        creds.get("obtained_via") or "", "")
    steps = []
    if env:
        steps.append(f"These credentials come from the environment ({', '.join('BB_' + k.upper() for k in env)}), "
                     "not from config.json: check or unset them first.")
    if creds.get("auth_source"):
        from datetime import datetime
        expired = bool(creds.get("expires_on")) and str(creds["expires_on"]) <= datetime.now().isoformat(sep=" ")
        steps.append(
            f"This CLI uses its own credential ({creds.get('credential')}); other clients cannot replace it. It is "
            + (f"past its expiry ({creds['expires_on']})." if expired else
               "refused because it was revoked (`bb.py logout`, `credentials --revoke`, the web UI's device list or "
               "an administrator), it expired, or the user was disabled.")
            + " Run `bb.py init --login` to get a new one; that does not sign out other clients.")
        return BBError(
            "credentials_rejected",
            f"Brewboard rejected this CLI's credential on {IDENTITY if endpoint in (None, IDENTITY) else endpoint}. "
            f"It was issued {when}.",
            status=401, endpoint=endpoint, identity="rejected", credentials=creds, next_steps=steps)
    steps += [
        f"Brewboard replaces this account's API secret on every sign-in (auth.login_and_get_keys), and the old "
        f"secret stops working immediately. Both the Brewboard web UI login page (/brewboard/login) and "
        f"`bb.py init --login` sign in this way. A sign-in to the same account after {when} revoked these "
        "credentials.",
        "Run `bb.py init --login`: on a backend with per-client credentials it gets a CLI-only credential that "
        "web UI sign-ins cannot revoke; on an older backend it rotates the account's single secret, which signs "
        "the web UI out.",
    ]
    where = IDENTITY if endpoint in (None, IDENTITY) else f"{endpoint} and on {IDENTITY}"
    return BBError(
        "credentials_rejected",
        f"Brewboard rejected the saved credentials on {where}: the server no longer accepts this API secret. "
        f"It was saved {when}{(' ' + how) if how else ''}.",
        status=401, endpoint=endpoint, identity="rejected", credentials=creds, next_steps=steps)

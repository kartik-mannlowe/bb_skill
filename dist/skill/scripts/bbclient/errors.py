"""The one exception type bb.py raises, printed as {"error": code, "message": ..., ...} on stderr."""
from __future__ import annotations

# code -> meaning (the skill maps each to a next step; see SKILL.md "Translate errors")
CODES = {
    "not_configured": "no URL / API key / secret saved",
    "auth_failed": "401: key or secret wrong, or the secret was rotated by a later login",
    "credentials_rejected": "401 on the identity endpoint too: the server no longer accepts this API secret",
    "endpoint_auth_failed": "401 from one endpoint while the identity endpoint accepts the same credentials",
    "forbidden": "403: the user's Brewboard role or project membership does not allow this",
    "not_found": "404: no such record, or not in the given project",
    "validation_error": "417/409: Brewboard rejected the input; message is the server's text",
    "rate_limited": "429: too many requests",
    "server_error": "5xx: Brewboard failed while handling the request",
    "unreachable": "no connection (URL, VPN, server down)",
    "write_outcome_unknown": "a write was sent but no answer came back; check before retrying",
    "http_error": "other HTTP failure or a response that is not valid JSON",
    "bad_response": "the API answered with a shape bb.py does not recognise",
    "not_brewboard": "the URL answers but does not serve the brewboard_backend API",
    "api_unsupported": "the Brewboard API has no endpoint for this operation",
    "bad_input": "invalid arguments; nothing was sent",
    "possible_duplicate": "an identical record already exists; nothing was created",
    "no_project": "no project selected and none given",
}


class BBError(Exception):
    def __init__(self, code: str, message: str, status: int | None = None, **extra):
        super().__init__(message)
        self.code, self.message, self.status, self.extra = code, message, status, extra

    def as_dict(self) -> dict:
        out = {"error": self.code, "message": self.message}
        if self.status:
            out["status"] = self.status
        out.update({k: v for k, v in self.extra.items() if v is not None})
        return out


def unsupported(what: str, detail: str = "") -> BBError:
    """An operation the skill used to offer that the Brewboard API does not expose."""
    msg = f"The Brewboard API does not support {what}."
    return BBError("api_unsupported", f"{msg} {detail}".strip())

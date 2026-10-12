"""HTTP transport for Frappe whitelisted methods (`/api/method/<dotted.path>`).

- Auth: `Authorization: token <api_key>:<api_secret>` (Frappe token auth). The header is
  built once and never logged or included in an error.
- Reads (GET) are retried once on a timeout, dropped connection or 502/503/504.
- Writes (POST) are never retried. A write whose answer never arrives raises
  `write_outcome_unknown`, so the caller checks before trying again instead of creating
  a second record.
- `BB_DEBUG=1` logs method, endpoint, status and duration to stderr: no headers, no
  query values, no bodies.
"""
from __future__ import annotations

import json
import os
import re
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

from .errors import BBError

STATUS_CODES = {401: "auth_failed", 403: "forbidden", 404: "not_found", 409: "validation_error",
                417: "validation_error", 429: "rate_limited"}
RETRYABLE_STATUS = {502, 503, 504}
DEFAULT_MESSAGES = {
    "auth_failed": "Brewboard rejected the API key / secret.",
    "forbidden": "Brewboard refused this for your user (role or project membership).",
    "not_found": "Brewboard has no such record (or it is outside the given project).",
    "rate_limited": "Brewboard is rate-limiting requests; wait a moment and try again.",
    "server_error": "Brewboard failed while handling the request.",
}


def strip_html(s: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", s or "")).strip()


def server_message(payload) -> str:
    """Frappe's own error text: `_server_messages` first, then `exception` / `message`."""
    if isinstance(payload, dict):
        raw = payload.get("_server_messages")
        if raw:
            try:
                msgs = [json.loads(m).get("message", "") if isinstance(m, str) else str(m) for m in json.loads(raw)]
                text = "; ".join(strip_html(m) for m in msgs if m)
                if text:
                    return text
            except (ValueError, AttributeError, TypeError):
                pass
        exc = payload.get("exception")
        if isinstance(exc, str) and exc:
            return strip_html(exc.split(": ", 1)[-1])
        for key in ("message", "exc_type"):
            if isinstance(payload.get(key), str) and payload[key]:
                return strip_html(payload[key])
    return strip_html(str(payload))[:300]


def _debug(msg: str) -> None:
    if os.environ.get("BB_DEBUG"):
        sys.stderr.write(f"[bb] {msg}\n")


class Transport:
    """Sends requests to one site. `opener` is injectable for tests (anything with .open(req, timeout))."""

    def __init__(self, base_url: str, api_key: str | None = None, api_secret: str | None = None,
                 timeout: float = 30.0, opener=None, auth_source: str | None = None):
        self.base_url = base_url.rstrip("/")
        self._auth = f"token {api_key}:{api_secret}" if api_key and api_secret else None
        # Per-client credential: tells Frappe which DocType holds the key pair (default: User).
        self._auth_source = auth_source if self._auth else None
        self.timeout = timeout
        self._opener = opener or urllib.request.build_opener()

    def __repr__(self) -> str:  # never show the credentials
        return f"Transport({self.base_url!r}, auth={'set' if self._auth else 'none'})"

    def url_for(self, path: str, params: dict | None = None) -> str:
        url = self.base_url + path
        if params:
            q = {k: json.dumps(v) if isinstance(v, (list, dict)) else v for k, v in params.items() if v is not None}
            if q:
                url += "?" + urllib.parse.urlencode(q)
        return url

    def method(self, http_method: str, dotted: str, args: dict | None = None, *, raw: bool = False,
               auth: bool = True):
        """Call a whitelisted method. Returns the `message` value (or (bytes, filename) when raw)."""
        path = "/api/method/" + dotted
        if http_method == "GET":
            return self._send("GET", path, params=args, raw=raw, auth=auth)
        return self._send(http_method, path, body={k: v for k, v in (args or {}).items() if v is not None},
                          raw=raw, auth=auth)

    # ------------------------------------------------------------------ internals

    def _send(self, http_method: str, path: str, params=None, body=None, raw=False, auth=True):
        url = self.url_for(path, params if http_method == "GET" else None)
        data = None if body is None else json.dumps(body).encode()
        headers = {"Accept": "application/json"}
        if auth and self._auth:
            headers["Authorization"] = self._auth
            if self._auth_source:
                headers["Frappe-Authorization-Source"] = self._auth_source
        if data is not None:
            headers["Content-Type"] = "application/json"
        attempts = 2 if http_method == "GET" else 1
        for attempt in range(1, attempts + 1):
            started = time.monotonic()
            req = urllib.request.Request(url, data=data, method=http_method, headers=headers)
            try:
                with self._opener.open(req, timeout=self.timeout) as resp:
                    content = resp.read()
                    status = getattr(resp, "status", 200)
                    disposition = resp.headers.get("Content-Disposition", "") if resp.headers else ""
                    ctype = resp.headers.get("Content-Type", "") if resp.headers else ""
                _debug(f"{http_method} {path} -> {status} in {time.monotonic() - started:.2f}s")
            except urllib.error.HTTPError as e:
                _debug(f"{http_method} {path} -> {e.code} in {time.monotonic() - started:.2f}s")
                if e.code in RETRYABLE_STATUS and attempt < attempts:
                    time.sleep(0.5)
                    continue
                raise self._http_error(e, http_method, path) from None
            except (socket.timeout, TimeoutError) as e:
                if attempt < attempts:
                    continue
                raise self._network_error(e, http_method, sent=True) from None
            except urllib.error.URLError as e:
                reason = e.reason
                refused = isinstance(reason, (ConnectionRefusedError, socket.gaierror))
                timed_out = isinstance(reason, (socket.timeout, TimeoutError))
                if attempt < attempts and not refused:
                    continue
                raise self._network_error(e, http_method, sent=timed_out or not refused) from None
            except (ConnectionError, OSError) as e:
                if attempt < attempts:
                    continue
                raise self._network_error(e, http_method, sent=not isinstance(e, ConnectionRefusedError)) from None
            return self._decode(content, ctype, disposition, raw, url)
        raise AssertionError("unreachable")  # pragma: no cover

    def _decode(self, content: bytes, ctype: str, disposition: str, raw: bool, url: str):
        if raw:
            m = re.search(r'filename\*?=(?:UTF-8\'\')?"?([^";]+)"?', disposition or "")
            return content, urllib.parse.unquote(m.group(1)) if m else None
        text = content.decode("utf-8", "replace")
        if not text.strip():
            raise BBError("bad_response", "Empty response from Brewboard where data was expected")
        try:
            payload = json.loads(text)
        except ValueError:
            hint = " (an HTML page: is the URL the Brewboard backend site?)" if "html" in ctype.lower() else ""
            raise BBError("http_error", f"Non-JSON response from {url.split('?')[0]}{hint}") from None
        if not isinstance(payload, dict) or "message" not in payload:
            raise BBError("bad_response", "Response has no `message` field", body_keys=sorted(payload)[:10]
                          if isinstance(payload, dict) else None)
        return payload["message"]

    def _http_error(self, e: urllib.error.HTTPError, http_method: str, path: str = "") -> BBError:
        raw = e.read().decode("utf-8", "replace") if hasattr(e, "read") else ""
        try:
            payload = json.loads(raw)
        except ValueError:
            payload = raw
        code = STATUS_CODES.get(e.code) or ("server_error" if e.code >= 500 else "http_error")
        msg = server_message(payload) if payload else (e.reason or f"HTTP {e.code}")
        if re.fullmatch(r"[\w.]*(Error|Exception)", str(msg)):  # only a class name, no text
            msg = DEFAULT_MESSAGES.get(code, f"HTTP {e.code} ({str(msg).rsplit('.', 1)[-1]})")
        if code == "forbidden" and "not whitelisted" in str(msg).lower():
            msg += " (the endpoint is missing on this site, or the request was not authenticated)"
        extra = {"endpoint": path.rsplit("/", 1)[-1] or None}
        if isinstance(payload, dict) and payload.get("exc_type"):
            extra["exc_type"] = payload["exc_type"]
        if code == "server_error" and http_method != "GET":
            extra["note"] = "The write may or may not have been saved; check before retrying."
        return BBError(code, str(msg), status=e.code, **extra)

    def _network_error(self, e: Exception, http_method: str, sent: bool) -> BBError:
        reason = getattr(e, "reason", e)
        if http_method != "GET" and sent:
            return BBError("write_outcome_unknown",
                           f"No answer from {self.base_url} after sending the request ({reason}). It may or may "
                           "not have been saved: list the records to check before trying again.")
        return BBError("unreachable", f"Cannot reach {self.base_url} ({reason}). Is the server running, the URL "
                                      "right and the VPN up?")

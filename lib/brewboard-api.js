"use strict";
// The few brewboard_backend endpoints the installer needs, verified against
// brewboard_backend/api/{health,auth}.py:
//   GET  health.ping                 guest; {"app": "brewboard_backend"} proves the server
//   GET  auth.list_credentials       probed WITHOUT credentials: 401/403 = per-client credentials exist,
//                                    417 "Failed to get method for command …list_credentials" = older
//                                    backend (shared secret); any other answer = unknown, sign-in stops
//   POST auth.login_and_get_keys     guest; {usr, pwd[, client, label]} ->
//                                    {api_key, api_secret[, auth_source, credential, client, expires_on]}
//   GET  auth.get_current_user       {name, full_name, email, roles}
//   POST auth.revoke_credential      revoke one of the caller's own credentials
// Redirects are refused (a redirect could carry the password elsewhere); request bodies and
// headers are never included in errors.
const PREFIX = "/api/method/brewboard_backend.api.";
const SOURCE_HEADER = "Frappe-Authorization-Source";

class ApiError extends Error {
  constructor(code, message, status) { super(message); this.code = code; this.status = status; }
}

function stripHtml(s) { return String(s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(); }

function serverMessage(body) {
  if (!body || typeof body !== "object") return "";
  try {
    const msgs = JSON.parse(body._server_messages || "[]").map((m) => JSON.parse(m).message);
    const text = msgs.filter(Boolean).map(stripHtml).join("; ");
    if (text) return text;
  } catch { /* fall through */ }
  if (typeof body.exception === "string") return stripHtml(body.exception.split(": ").slice(1).join(": ") || body.exception);
  return typeof body.message === "string" ? stripHtml(body.message) : "";
}

function authHeaders(creds) {
  if (!creds) return {};
  const h = { Authorization: `token ${creds.api_key}:${creds.api_secret}` };
  if (creds.auth_source) h[SOURCE_HEADER] = creds.auth_source;
  return h;
}

async function call(base, method, dotted, { body, creds, timeoutMs = 20000, fetchImpl = fetch } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(base + PREFIX + dotted, {
      method,
      redirect: "manual",
      signal: ctl.signal,
      headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}), ...authHeaders(creds) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    const why = e.name === "AbortError" ? "timed out" : (e.cause && e.cause.code) || e.message;
    throw new ApiError("unreachable", `Cannot reach ${base} (${why}).`);
  } finally {
    clearTimeout(timer);
  }
  if (res.status >= 300 && res.status < 400) {
    throw new ApiError("redirect", `${base} redirects to ${res.headers.get("location") || "another address"}; ` +
                                   "enter that address instead (credentials are never sent to a redirect).", res.status);
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, json, isJson: json !== null };
}

async function ping(base, opts) {
  const r = await call(base, "GET", "health.ping", opts);
  const ok = r.status === 200 && r.json && r.json.message && r.json.message.app === "brewboard_backend";
  if (!ok) {
    throw new ApiError("not_brewboard", `${base} answered, but it does not serve the Brewboard backend API ` +
                       `(brewboard_backend.api.health.ping returned ${r.status}${r.isJson ? "" : ", not JSON"}).`, r.status);
  }
  return r.json.message;
}

// Before any password is typed: does this server issue per-client credentials?
//   true   401 / 403: the method exists and wants credentials (per-client backend).
//   false  only on proof of an older backend: Frappe's 417 "Failed to get method for command
//          brewboard_backend.api.auth.list_credentials ..." (handler.execute_cmd), i.e. it has no such method.
//   throws on anything else (5xx, 429, a proxy page, a timeout): an unclear answer never leads to the
//          shared-secret sign-in, which replaces the account's API secret.
async function supportsClientCredentials(base, opts) {
  const r = await call(base, "GET", "auth.list_credentials", opts);
  if (r.status === 401 || r.status === 403) return true;
  const msg = serverMessage(r.json);
  if (r.status === 417 && msg.includes(`Failed to get method for command ${PREFIX.slice("/api/method/".length)}auth.list_credentials`)) {
    return false;
  }
  throw new ApiError("capability_unknown", `Could not tell whether ${base} issues per-client credentials ` +
    `(auth.list_credentials answered HTTP ${r.status}${msg ? `: ${msg.slice(0, 200)}` : r.isJson ? "" : ", not JSON"}). ` +
    "Nothing was sent and nothing was changed. Try again in a moment; if it persists, ask your Brewboard administrator. " +
    "The sign-in does not fall back to the shared-secret method on an unclear answer, because that would replace " +
    "your account's API secret.", r.status);
}

async function login(base, usr, pwd, { client, label, ...opts } = {}) {
  const body = { usr, pwd, ...(client ? { client, label } : {}) };
  const r = await call(base, "POST", "auth.login_and_get_keys", { ...opts, body });
  if (r.status === 401) throw new ApiError("bad_credentials", serverMessage(r.json) || "Invalid login ID or password.", 401);
  if (r.status === 429) throw new ApiError("rate_limited", "Too many sign-in attempts; wait a few minutes and try again.", 429);
  if (r.status !== 200) {
    const code = r.status === 403 && /two-factor|password has expired|not allowed/i.test(serverMessage(r.json))
      ? "login_refused" : r.status >= 500 ? "server_error" : "login_failed";
    throw new ApiError(code, serverMessage(r.json) || `Sign-in failed (HTTP ${r.status}).`, r.status);
  }
  const m = r.json && r.json.message;
  if (!m || typeof m.api_key !== "string" || typeof m.api_secret !== "string" || !m.api_key || !m.api_secret) {
    throw new ApiError("bad_response", "The server accepted the sign-in but returned no API key and secret.", 200);
  }
  return { api_key: m.api_key, api_secret: m.api_secret, auth_source: m.auth_source || null,
           credential: m.credential || null, expires_on: m.expires_on || null };
}

async function whoami(base, creds, opts) {
  const r = await call(base, "GET", "auth.get_current_user", { ...opts, creds });
  if (r.status === 401) throw new ApiError("auth_failed", "The server rejected the new API credentials.", 401);
  if (r.status !== 200 || !r.json || !r.json.message || !r.json.message.name) {
    throw new ApiError("bad_response", `auth.get_current_user returned ${r.status}.`, r.status);
  }
  return r.json.message;
}

async function revokeCredential(base, creds, credential, opts) {
  const r = await call(base, "POST", "auth.revoke_credential", { ...opts, creds, body: { credential } });
  return r.status === 200;
}

module.exports = { ping, supportsClientCredentials, login, whoami, revokeCredential, ApiError, serverMessage, PREFIX };

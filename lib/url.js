"use strict";
// Server URL normalisation. Credentials travel to this URL, so: http(s) only, no user:pass@,
// no query or fragment, and plain HTTP only for loopback (local development).
const net = require("net");

class UrlError extends Error {}

function isLoopback(hostname) {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (net.isIPv4(h)) return h.startsWith("127.");
  return h === "::1";
}

function normalizeServerUrl(raw) {
  let text = String(raw || "").trim();
  if (!text) throw new UrlError("Enter the server URL, e.g. https://brewboard.example.com");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    const host = text.split(/[/:]/)[0];
    text = (isLoopback(host) ? "http://" : "https://") + text;
  }
  let u;
  try { u = new URL(text); } catch { throw new UrlError(`"${raw}" is not a valid URL.`); }
  if (!["http:", "https:"].includes(u.protocol)) throw new UrlError("Use an http:// or https:// URL.");
  if (u.username || u.password) throw new UrlError("Do not put a user name or password in the URL.");
  if (u.search || u.hash) throw new UrlError("Use the server address only, without ?query or #fragment.");
  if (u.protocol === "http:" && !isLoopback(u.hostname)) {
    throw new UrlError(`Refusing plain http:// for ${u.hostname}: your password would travel unencrypted. ` +
                       "Use https:// (http:// is only accepted for localhost / 127.0.0.1).");
  }
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
}

module.exports = { normalizeServerUrl, isLoopback, UrlError };

"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { normalizeServerUrl, UrlError } = require("../lib/url");

test("normalises and validates server URLs; HTTPS required off loopback", () => {
  const ok = {
    "127.0.0.1:8000": "http://127.0.0.1:8000", "http://localhost:8000/": "http://localhost:8000",
    "erpnext.localhost:8000": "http://erpnext.localhost:8000", "http://[::1]:8000": "http://[::1]:8000",
    "brewboard.example.com": "https://brewboard.example.com", "https://erp.example.com/sub/": "https://erp.example.com/sub",
    "  HTTPS://Erp.Example.com  ": "https://erp.example.com",
  };
  for (const [raw, want] of Object.entries(ok)) assert.strictEqual(normalizeServerUrl(raw), want, raw);
  for (const bad of ["", "http://erp.example.com", "http://192.168.1.5:8000", "ftp://x.com", "https://u:p@x.com",
                     "https://x.com/?a=1", "https://x.com/#f", "http://127.0.0.1.evil.com", "not a url at all"]) {
    assert.throws(() => normalizeServerUrl(bad), UrlError, bad);
  }
});

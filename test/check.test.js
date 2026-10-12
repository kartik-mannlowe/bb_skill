"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const { tmpHome, mockServer, SECRET } = require("./helpers");
const { install } = require("../lib/install");
const { authCheck } = require("../lib/check");

test("read-only check: not configured, valid, rejected; never signs in", async () => {
  const h = tmpHome();
  const srv = await mockServer({ mode: "per-client" });
  try {
    assert.strictEqual((await authCheck({ paths: h.paths, env: h.env })).status, "not_installed");
    install(h.paths);
    assert.strictEqual((await authCheck({ paths: h.paths, env: h.env })).status, "not_configured");

    srv.valid.set("ck9", { secret: `${SECRET}-9`, source: "Brewboard API Credential" });
    const cfg = { url: srv.url, api_key: "ck9", api_secret: `${SECRET}-9`, auth_source: "Brewboard API Credential",
                  credential: "cred9", obtained_via: "login", user: "dev@bb.test" };
    fs.writeFileSync(h.paths.configFile, JSON.stringify(cfg), { mode: 0o600 });
    const before = fs.statSync(h.paths.configFile).mtimeMs;
    const ok = (await authCheck({ paths: h.paths, env: h.env }));
    assert.strictEqual(ok.status, "ok");
    assert.strictEqual(ok.user, "dev@bb.test");

    srv.valid.clear(); // revoked on the server
    const bad = (await authCheck({ paths: h.paths, env: h.env }));
    assert.strictEqual(bad.status, "credentials_rejected");
    assert.ok(!JSON.stringify(bad).includes(SECRET));
    assert.strictEqual(srv.calls("auth.login_and_get_keys").length, 0, "a check never signs in");
    assert.strictEqual(fs.statSync(h.paths.configFile).mtimeMs, before, "a check never rewrites the config");
  } finally { await srv.close(); h.cleanup(); }
});

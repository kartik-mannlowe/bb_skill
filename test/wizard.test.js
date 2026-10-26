"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const { tmpHome, mockServer, fakeTty, drive, KEY, PASSWORD, SECRET } = require("./helpers");
const { install } = require("../lib/install");
const { runWizard } = require("../lib/wizard");
const { readStatus, createStatusFile } = require("../lib/status");

async function setup(mode) {
  const h = tmpHome();
  install(h.paths);
  const srv = await mockServer({ mode });
  return { h, srv, tty: fakeTty(), done: async () => { await srv.close(); h.cleanup(); } };
}

const signIn = (url, extra = []) => [
  { waitFor: "server URL:", send: [url, KEY.enter] },
  ...extra,
  { waitFor: "login ID or email:", send: ["dev@bb.test", KEY.enter] },
  { waitFor: "password:", send: [PASSWORD, KEY.enter] },
];

test("new backend: gets a CLI credential, verifies it, saves it privately, prints the completion message", async () => {
  const { h, srv, tty, done } = await setup("per-client");
  try {
    const statusFile = createStatusFile();
    const run = runWizard({ paths: h.paths, statusFile, env: h.env, io: tty });
    await drive(tty, signIn(srv.url));
    const r = await run;
    assert.strictEqual(r.state, "success", tty.text());
    const login = srv.calls("auth.login_and_get_keys")[0];
    assert.strictEqual(login.method, "POST");
    assert.strictEqual(login.body.client, "cli");
    assert.ok(!login.headers.authorization);
    const probe = srv.calls("auth.list_credentials")[0];
    assert.ok(!probe.headers.authorization, "capability probe is unauthenticated");
    assert.ok(srv.requests.indexOf(probe) < srv.requests.indexOf(login), "probe happens before the password is sent");
    const cfg = JSON.parse(fs.readFileSync(h.paths.configFile, "utf8"));
    assert.deepStrictEqual(Object.keys(cfg).sort(), ["api_key", "api_secret", "auth_source", "credential", "expires_on",
                                                     "obtained_via", "saved_at", "url", "user"]);
    assert.strictEqual(cfg.auth_source, "Brewboard API Credential");
    assert.strictEqual(fs.statSync(h.paths.configFile).mode & 0o777, 0o600);
    assert.strictEqual(fs.statSync(h.paths.bbHome).mode & 0o777, 0o700);
    assert.ok(!JSON.stringify(cfg).includes(PASSWORD));
    const out = tty.text();
    assert.ok(!out.includes(PASSWORD) && !out.includes(SECRET), "no password or secret on screen");
    assert.match(out, /Brewboard authentication configured successfully\./);
    assert.match(out, /open a new terminal tab to start your coding agent/);
    assert.match(out, /\/bb list_tasks/);
    assert.ok(srv.calls("auth.get_current_user").length >= 2, "verified by the wizard and by bb.py auth-check");
    assert.strictEqual(readStatus(statusFile).state, "success");
    assert.ok(!JSON.stringify(readStatus(statusFile)).includes(SECRET));
    assert.ok(!fs.existsSync(h.paths.lockFile), "lock released");
  } finally { await done(); }
});

test("legacy backend: shared-secret warning; Cancel sends no password", async () => {
  const { h, srv, tty, done } = await setup("legacy");
  try {
    const run = runWizard({ paths: h.paths, env: h.env, io: tty });
    await drive(tty, [{ waitFor: "server URL:", send: [srv.url, KEY.enter] },
                      { waitFor: "Cancel", send: [KEY.down, KEY.enter] }]);
    const r = await run;
    assert.strictEqual(r.state, "cancelled");
    assert.match(tty.text(), /shares one API secret per account/);
    assert.strictEqual(srv.calls("auth.login_and_get_keys").length, 0);
    assert.ok(!fs.existsSync(h.paths.configFile));
  } finally { await done(); }
});

test("legacy backend: explicit Continue signs in without the client parameter", async () => {
  const { h, srv, tty, done } = await setup("legacy");
  try {
    const run = runWizard({ paths: h.paths, env: h.env, io: tty });
    await drive(tty, signIn(srv.url, [{ waitFor: "Cancel", send: KEY.enter }]));
    const r = await run;
    assert.strictEqual(r.state, "success", tty.text());
    assert.strictEqual(srv.calls("auth.login_and_get_keys")[0].body.client, undefined);
    const cfg = JSON.parse(fs.readFileSync(h.paths.configFile, "utf8"));
    assert.ok(!("auth_source" in cfg));
    assert.match(tty.text(), /a later web UI sign-in will sign the CLI out/);
  } finally { await done(); }
});

test("wrong password: retried, then a clear failure; nothing saved", async () => {
  const { h, srv, tty, done } = await setup("per-client");
  try {
    const run = runWizard({ paths: h.paths, env: h.env, io: tty });
    await drive(tty, [{ waitFor: "server URL:", send: [srv.url, KEY.enter] },
                      { waitFor: "login ID or email:", send: ["dev@bb.test", KEY.enter] },
                      { waitFor: "password:", send: ["wrong-1", KEY.enter] },
                      { waitFor: "password:", send: ["wrong-2", KEY.enter] },
                      { waitFor: "password:", send: ["wrong-3", KEY.enter] }]);
    const r = await run;
    assert.strictEqual(r.state, "failed");
    assert.strictEqual(srv.calls("auth.login_and_get_keys").length, 3);
    assert.match(tty.text(), /Invalid Login/);
    assert.ok(!tty.text().includes("wrong-"));
    assert.ok(!fs.existsSync(h.paths.configFile));
  } finally { await done(); }
});

test("a server without the Brewboard API is refused before any credential is asked for", async () => {
  const { h, srv, tty, done } = await setup("not-brewboard");
  try {
    const run = runWizard({ paths: h.paths, env: h.env, io: tty });
    await drive(tty, [{ waitFor: "server URL:", send: [srv.url, KEY.enter] },
                      { waitFor: "Enter another URL", send: KEY.ctrlC }]);
    const r = await run;
    assert.strictEqual(r.state, "cancelled");
    assert.match(tty.text(), /does not serve the Brewboard backend API/);
    assert.strictEqual(srv.calls("auth.login_and_get_keys").length, 0);
  } finally { await done(); }
});

test("insecure http to a non-local host is refused", async () => {
  const { h, srv, tty, done } = await setup("per-client");
  try {
    const run = runWizard({ paths: h.paths, env: h.env, io: tty });
    await drive(tty, [{ waitFor: "server URL:", send: ["http://erp.example.com", KEY.enter] },
                      { waitFor: "Enter another URL", send: KEY.ctrlC }]);
    assert.strictEqual((await run).state, "cancelled");
    assert.match(tty.text(), /Refusing plain http:\/\//);
    assert.strictEqual(srv.requests.length, 0);
  } finally { await done(); }
});

test("a response without keys is reported, not saved", async () => {
  const { h, srv, tty, done } = await setup("per-client");
  const fetchImpl = async (url, init) => {
    if (url.endsWith("auth.login_and_get_keys")) return new Response(JSON.stringify({ message: { ok: true } }), { status: 200 });
    return fetch(url, init);
  };
  try {
    const run = runWizard({ paths: h.paths, env: h.env, io: tty, apiOpts: { fetchImpl } });
    await drive(tty, signIn(srv.url));
    const r = await run;
    assert.strictEqual(r.state, "failed");
    assert.match(r.message, /no API key and secret/);
    assert.ok(!fs.existsSync(h.paths.configFile));
  } finally { await done(); }
});

test("if bb.py rejects the saved file, the previous working configuration is restored", async () => {
  const { h, srv, tty, done } = await setup("per-client");
  try {
    const previous = { url: srv.url, api_key: "old", api_secret: "old-secret", user: "dev@bb.test" };
    fs.writeFileSync(h.paths.configFile, JSON.stringify(previous), { mode: 0o600 });
    const run = runWizard({ paths: h.paths, env: h.env, io: tty, python: "false" }); // bb.py cannot run
    await drive(tty, signIn(srv.url));
    const r = await run;
    assert.strictEqual(r.state, "failed");
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(h.paths.configFile, "utf8")), previous);
    assert.strictEqual(srv.calls("auth.revoke_credential").length, 0);
  } finally { await done(); }
});

test("signing in again retires only this CLI's previous credential", async () => {
  const { h, srv, tty, done } = await setup("per-client");
  try {
    let run = runWizard({ paths: h.paths, env: h.env, io: tty });
    await drive(tty, signIn(srv.url));
    assert.strictEqual((await run).state, "success");
    const first = JSON.parse(fs.readFileSync(h.paths.configFile, "utf8")).credential;
    const tty2 = fakeTty();
    run = runWizard({ paths: h.paths, env: h.env, io: tty2 });
    await drive(tty2, [{ waitFor: "server URL:", send: KEY.enter }, // default = saved URL
                       { waitFor: "login ID or email:", send: KEY.enter }, // default = saved user
                       { waitFor: "password:", send: [PASSWORD, KEY.enter] }]);
    assert.strictEqual((await run).state, "success", tty2.text());
    assert.deepStrictEqual(srv.calls("auth.revoke_credential").map((c) => c.body.credential), [first]);
  } finally { await done(); }
});

test("a second wizard does not start while one is running", async () => {
  const { h, srv, tty, done } = await setup("per-client");
  try {
    const run = runWizard({ paths: h.paths, env: h.env, io: tty });
    await drive(tty, [{ waitFor: "server URL:", send: [] }]);
    const second = await runWizard({ paths: h.paths, env: h.env, io: fakeTty() });
    assert.strictEqual(second.state, "busy");
    tty.input.write(KEY.ctrlC);
    assert.strictEqual((await run).state, "cancelled");
  } finally { await done(); }
});

// D5: only proof of an older backend leads to the shared-secret sign-in. Anything unclear stops
// before a password is asked for, so a server hiccup can never replace the account's API secret.
const AMBIGUOUS = {
  "a server error (500)": { status: 500, exc: "Exception", message: "Internal Server Error" },
  "a gateway error page (502, HTML)": { status: 502, html: "<html><body>502 Bad Gateway</body></html>" },
  "maintenance (503)": { status: 503, exc: "Exception", message: "Service Unavailable" },
  "rate limiting (429)": { status: 429, exc: "TooManyRequestsError", message: "Too many requests" },
  "not found (404)": { status: 404, exc: "DoesNotExistError", message: "Not found" },
  "a different validation error (417)": { status: 417, exc: "ValidationError", message: "Per-client API credentials are not set up on this site yet" },
  "a 417 for another method": { status: 417, exc: "ValidationError", message: "Failed to get method for command brewboard_backend.api.auth.something_else" },
  "an unexpected success (200)": { status: 200, exc: "", message: "" },
  "a dropped connection": "drop",
};

for (const [what, probe] of Object.entries(AMBIGUOUS)) {
  test(`capability probe answered with ${what}: sign-in stops, no password, no shared-secret fallback`, async () => {
    const h = tmpHome();
    install(h.paths);
    const srv = await mockServer({ mode: "legacy", probe });
    const tty = fakeTty();
    try {
      const run = runWizard({ paths: h.paths, env: h.env, io: tty });
      await drive(tty, [{ waitFor: "server URL:", send: [srv.url, KEY.enter] }]);
      const r = await run;
      assert.strictEqual(r.state, "failed", tty.text());
      const out = tty.text();
      assert.match(out, probe === "drop" ? /Cannot reach/ : /Could not tell whether .* issues per-client credentials/);
      assert.doesNotMatch(out, /shares one API secret per account|password:/, "never reaches the shared-secret choice or the password");
      assert.strictEqual(srv.calls("auth.login_and_get_keys").length, 0);
      assert.ok(!fs.existsSync(h.paths.configFile));
    } finally { await srv.close(); h.cleanup(); }
  });
}

test("capability probe: Frappe's 'Failed to get method' for list_credentials is proof of an older backend", async () => {
  const { h, srv, tty, done } = await setup("legacy");
  try {
    const run = runWizard({ paths: h.paths, env: h.env, io: tty });
    await drive(tty, [{ waitFor: "server URL:", send: [srv.url, KEY.enter] },
                      { waitFor: "Cancel", send: [KEY.down, KEY.enter] }]);
    assert.strictEqual((await run).state, "cancelled");
    assert.match(tty.text(), /shares one API secret per account/);
  } finally { await done(); }
});

test("capability probe: 401 means per-client credentials, like 403", async () => {
  const h = tmpHome();
  install(h.paths);
  const srv = await mockServer({ mode: "per-client", probe: { status: 401, exc: "AuthenticationError", message: "Not permitted" } });
  const tty = fakeTty();
  try {
    const run = runWizard({ paths: h.paths, env: h.env, io: tty });
    await drive(tty, signIn(srv.url));
    assert.strictEqual((await run).state, "success", tty.text());
    assert.strictEqual(srv.calls("auth.login_and_get_keys")[0].body.client, "cli");
  } finally { await srv.close(); h.cleanup(); }
});

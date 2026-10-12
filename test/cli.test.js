"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { PassThrough } = require("stream");
const { tmpHome, mockServer, fakeTty, drive, KEY, PASSWORD, SECRET } = require("./helpers");
const { main } = require("../lib/cli");
const status = require("../lib/status");

const BIN = path.join(__dirname, "..", "bin", "brewboard-skill.js");
// Async: the mock server lives in this process, so a blocking spawnSync would deadlock it.
function runBin(args, { env, input = "" } = {}) {
  const { spawn } = require("child_process");
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [BIN, ...args], { env });
    let stdout = "", stderr = "";
    c.stdout.on("data", (d) => (stdout += d));
    c.stderr.on("data", (d) => (stderr += d));
    c.on("close", (status) => resolve({ status, stdout, stderr }));
    c.stdin.end(input);
  });
}
const sink = () => { const s = new PassThrough(); let t = ""; s.on("data", (c) => (t += c)); s.text = () => t; return s; };

test("--version and --help", () => {
  const v = spawnSync(process.execPath, [BIN, "--version"], { encoding: "utf8" });
  assert.strictEqual(v.stdout.trim(), require("../package.json").version);
  const h = spawnSync(process.execPath, [BIN, "--help"], { encoding: "utf8" });
  assert.match(h.stdout, /--login/);
  assert.match(h.stdout, /--check/);
  const bad = spawnSync(process.execPath, [BIN, "--password", "x"], { encoding: "utf8" });
  assert.strictEqual(bad.status, 2);
});

test("first run without a terminal installs, checks, and explains how to sign in (no prompt, no login)", async () => {
  const h = tmpHome();
  const srv = await mockServer();
  try {
    const r = await runBin([], { env: h.env });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /Brewboard authentication required/);
    assert.match(r.stdout, /not an interactive terminal/);
    assert.ok(fs.existsSync(h.paths.bbPy));
    assert.ok(!fs.existsSync(h.paths.configFile));
    assert.strictEqual(srv.requests.length, 0);
  } finally { await srv.close(); h.cleanup(); }
});

test("Cancel at the first-run prompt creates nothing and asks for no password", async () => {
  const h = tmpHome();
  try {
    const tty = fakeTty();
    const run = main([], { env: h.env, stdin: tty.input, stdout: tty.output, stderr: sink() });
    await drive(tty, [{ waitFor: "Would you like to sign in to Brewboard now?", send: [] },
                      { waitFor: "Cancel", send: [KEY.down, KEY.enter] }]);
    assert.strictEqual(await run, 0);
    assert.match(tty.text(), /Sign-in skipped\. The skill stays installed/);
    assert.ok(!/password/i.test(tty.text().split("Would you like")[1]));
    assert.ok(!fs.existsSync(h.paths.configFile));
    assert.ok(fs.existsSync(h.paths.bbPy));
  } finally { h.cleanup(); }
});

test("Yes opens a tab with a secret-free command line and reports the tab's result", async () => {
  const h = tmpHome();
  try {
    const tty = fakeTty();
    let launched;
    const deps = {
      noGuiReason: () => null,
      findTerminal: () => ({ name: "ptyxis", bin: "ptyxis", args: (t, c) => ["--tab", "-T", t, "--", ...c] }),
      launchTab: async (term, title, command) => {
        launched = term.args(title, command);
        const file = command[command.indexOf("--status-file") + 1];
        setTimeout(() => status.writeStatus(file, "started"), 50);
        setTimeout(() => status.writeStatus(file, "success", { user: "dev@bb.test", message: "ok" }), 150);
        return { ok: true };
      },
    };
    const run = main([], { env: h.env, stdin: tty.input, stdout: tty.output, stderr: sink(), deps });
    await drive(tty, [{ waitFor: "Cancel", send: KEY.enter }]);
    assert.strictEqual(await run, 0);
    assert.strictEqual(launched[0], "--tab");
    assert.ok(launched.includes("--wizard") && launched.includes("--status-file"));
    assert.ok(!launched.some((a) => /pass|secret|token/i.test(a)), "no credential in the command line");
    assert.match(tty.text(), /Opening a new ptyxis tab/);
    assert.match(tty.text(), /Sign-in completed in the other tab/);
    assert.match(tty.text(), /start your coding agent/);
  } finally { h.cleanup(); }
});

test("when the terminal cannot open a tab, the wizard runs in this terminal", async () => {
  const h = tmpHome();
  const srv = await mockServer();
  try {
    const tty = fakeTty();
    const deps = { noGuiReason: () => null, findTerminal: () => ({ name: "ptyxis" }),
                   launchTab: async () => ({ ok: false, error: "ptyxis not found" }) };
    const run = main(["--login"], { env: h.env, stdin: tty.input, stdout: tty.output, stderr: sink(), deps });
    await drive(tty, [{ waitFor: "server URL:", send: [srv.url, KEY.enter] },
                      { waitFor: "login ID or email:", send: ["dev@bb.test", KEY.enter] },
                      { waitFor: "password:", send: [PASSWORD, KEY.enter] }]);
    assert.strictEqual(await run, 0, tty.text());
    assert.match(tty.text(), /Could not open a ptyxis tab \(ptyxis not found\)/);
    assert.match(tty.text(), /Signing in here instead/);
    assert.match(tty.text(), /configured successfully/);
    assert.ok(!tty.text().includes(PASSWORD) && !tty.text().includes(SECRET));
  } finally { await srv.close(); h.cleanup(); }
});

test("over SSH (no desktop) --login falls back to this terminal; without a TTY it gives instructions", async () => {
  const h = tmpHome();
  try {
    const out = sink();
    const code = await main(["--login"], { env: { ...h.env, SSH_CONNECTION: "1 2 3 4" }, stdin: new PassThrough(),
                                           stdout: out, stderr: sink() });
    assert.strictEqual(code, 1);
    assert.match(out.text(), /this is an SSH session/);
    assert.match(out.text(), /--login --here/);
  } finally { h.cleanup(); }
});

test("existing valid sign-in: no prompt, no login, config untouched; rejected sign-in offers recovery", async () => {
  const h = tmpHome();
  const srv = await mockServer();
  try {
    await runBin(["--no-login"], { env: h.env });
    srv.valid.set("ck1", { secret: `${SECRET}-1`, source: "Brewboard API Credential" });
    fs.writeFileSync(h.paths.configFile, JSON.stringify({ url: srv.url, api_key: "ck1", api_secret: `${SECRET}-1`,
      auth_source: "Brewboard API Credential", credential: "cred1", user: "dev@bb.test" }), { mode: 0o600 });
    const mtime = fs.statSync(h.paths.configFile).mtimeMs;
    let r = await runBin([], { env: h.env });
    assert.strictEqual(r.status, 0);
    assert.match(r.stdout, /Signed in to .* as dev@bb\.test\. Nothing else to do\./);
    assert.match(r.stdout, /start your coding agent/);
    r = await runBin(["--check"], { env: h.env });
    assert.strictEqual(r.status, 0);
    assert.match(r.stdout, /Brewboard sign-in\s+valid: dev@bb\.test/);

    srv.valid.clear();
    r = await runBin([], { env: h.env });
    assert.match(r.stdout, /the saved credentials are no longer accepted/);
    assert.match(r.stdout, /--login/);
    r = await runBin(["--check"], { env: h.env });
    assert.strictEqual(r.status, 3);
    assert.strictEqual(srv.calls("auth.login_and_get_keys").length, 0);
    assert.strictEqual(fs.statSync(h.paths.configFile).mtimeMs, mtime);
    for (const out of [r.stdout, r.stderr]) assert.ok(!out.includes(SECRET));
  } finally { await srv.close(); h.cleanup(); }
});

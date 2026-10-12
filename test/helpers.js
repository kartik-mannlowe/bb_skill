"use strict";
// Test plumbing: temporary homes, a mock Brewboard server (Frappe response shapes from
// brewboard_backend/api/{health,auth}.py), scripted fake TTYs and a CLI runner.
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { PassThrough } = require("stream");
const { resolvePaths } = require("../lib/paths");

const PASSWORD = "Pa55-word-never-logged";
const SECRET = "mock-api-secret-0123456789abcdef";

// PATH is reduced to system directories so the real agent CLIs on this machine are not detected
// unless a test opts in (agents-e2e.test.js); python3 lives in /usr/bin.
function tmpHome({ realPath = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bbnpx-test-"));
  const env = { ...process.env, HOME: home, ...(realPath ? {} : { PATH: "/usr/local/bin:/usr/bin:/bin" }) };
  for (const k of ["BB_HOME", "BB_URL", "BB_API_KEY", "BB_API_SECRET", "BB_AUTH_SOURCE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME",
                   "BB_STATE_FILE", "BB_TERMINAL", "SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"]) delete env[k];
  return { home, env, paths: resolvePaths(env), cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

// mode: "per-client" (new backend) | "legacy" (shared secret) | "not-brewboard"
function mockServer({ mode = "per-client", password = PASSWORD, user = "dev@bb.test" } = {}) {
  const requests = [];
  const valid = new Map(); // api_key -> {secret, source}
  let n = 0;
  const frappeError = (res, status, exc, message) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ exc_type: exc, exception: `frappe.exceptions.${exc}: ${message}`,
                             _server_messages: JSON.stringify([JSON.stringify({ message })]) }));
  };
  const ok = (res, message) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ message })); };
  const authed = (req) => {
    const m = /^token ([^:]+):(.+)$/.exec(req.headers.authorization || "");
    const v = m && valid.get(m[1]);
    return v && v.secret === m[2] && (v.source || null) === (req.headers["frappe-authorization-source"] || null);
  };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = new URL(req.url, "http://x");
      const method = url.pathname.replace("/api/method/brewboard_backend.api.", "");
      const parsed = body ? JSON.parse(body) : {};
      requests.push({ method: req.method, endpoint: method, headers: req.headers, body: parsed, raw: body });
      if (mode === "not-brewboard") return frappeError(res, 417, "ValidationError", "Failed to get method for command");
      if (method === "health.ping") return ok(res, { status: "ok", app: "brewboard_backend" });
      if (method === "auth.list_credentials") {
        if (mode === "legacy") return frappeError(res, 417, "ValidationError", `Failed to get method for command brewboard_backend.api.${method}`);
        if (!authed(req)) return frappeError(res, 403, "PermissionError", "You are not permitted to access this resource.");
        return ok(res, []);
      }
      if (method === "auth.login_and_get_keys") {
        if (req.method !== "POST") return frappeError(res, 403, "PermissionError", "Not allowed");
        if (parsed.usr !== user || parsed.pwd !== password) return frappeError(res, 401, "AuthenticationError", "Invalid Login. Try again.");
        n += 1;
        if (mode === "legacy" || !parsed.client) {
          valid.clear(); // the legacy backend rotates the single secret
          valid.set("userkey", { secret: `${SECRET}-${n}`, source: null });
          return ok(res, { api_key: "userkey", api_secret: `${SECRET}-${n}` });
        }
        const key = `ck${n}`;
        valid.set(key, { secret: `${SECRET}-${n}`, source: "Brewboard API Credential" });
        return ok(res, { api_key: key, api_secret: `${SECRET}-${n}`, auth_source: "Brewboard API Credential",
                         credential: `cred${n}`, client: "CLI", expires_on: "2027-01-10 12:00:00" });
      }
      if (method === "auth.get_current_user") {
        if (!authed(req)) return frappeError(res, 401, "AuthenticationError", "Invalid key");
        return ok(res, { name: user, full_name: "Dev Tester", email: user, roles: ["BB Project User"] });
      }
      if (method === "auth.revoke_credential") {
        if (!authed(req)) return frappeError(res, 401, "AuthenticationError", "Invalid key");
        return ok(res, { revoked: [parsed.credential] });
      }
      return frappeError(res, 417, "ValidationError", `Failed to get method for command ${method}`);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${server.address().port}`;
    resolve({ url, requests, valid, mode, setMode: (m) => (mode = m), close: () => new Promise((r) => server.close(r)),
              calls: (ep) => requests.filter((r) => r.endpoint === ep) });
  }));
}

function fakeTty() {
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (v) => { input.isRaw = v; return input; };
  const output = new PassThrough();
  let text = "";
  output.on("data", (c) => (text += c.toString()));
  return { input, output, text: () => text };
}

// Answers prompts in order: waits until `waitFor` appears in new output, then types `send`.
async function drive(tty, steps, { timeoutMs = 8000 } = {}) {
  let seen = 0;
  for (const step of steps) {
    const t0 = Date.now();
    for (;;) {
      const idx = tty.text().indexOf(step.waitFor, seen);
      if (idx >= 0) { seen = idx + step.waitFor.length; break; }
      if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for "${step.waitFor}"\n--- output ---\n${tty.text()}`);
      await new Promise((r) => setTimeout(r, 15));
    }
    await new Promise((r) => setTimeout(r, 30));
    for (const chunk of [].concat(step.send)) { tty.input.write(chunk); await new Promise((r) => setTimeout(r, 15)); }
  }
}

const KEY = { enter: "\r", down: "\x1b[B", up: "\x1b[A", ctrlC: "\x03", esc: "\x1b" };

module.exports = { tmpHome, mockServer, fakeTty, drive, KEY, PASSWORD, SECRET };

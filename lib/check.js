"use strict";
// Read-only authentication check through the installed client: `bb.py auth-check`. It reports
// where the credentials come from and whether Brewboard accepts them (auth.get_current_user, with
// one read-only identity probe on failure). It never signs in, rotates or writes credentials.
// Asynchronous on purpose: a blocking spawn would also block anything else this process serves.
const { spawn } = require("child_process");
const fs = require("fs");

function authCheck({ paths, python = "python3", env = process.env, spawnFn = spawn, timeoutMs = 45000 }) {
  if (!fs.existsSync(paths.bbPy)) return Promise.resolve({ status: "not_installed", message: "The Brewboard skill is not installed." });
  return new Promise((resolve) => {
    let out = "", done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    let child;
    try {
      // -B: never write __pycache__ (the packaged bb.py may run from the package directory itself).
      child = spawnFn(python, ["-B", paths.bbPy, "auth-check"], {
        env: { ...env, BB_HOME: paths.bbHome, PYTHONDONTWRITEBYTECODE: "1" }, stdio: ["ignore", "pipe", "ignore"] });
    } catch (e) {
      return finish({ status: "error", message: `Could not run bb.py: ${e.message}` });
    }
    const timer = setTimeout(() => { child.kill(); finish({ status: "error", message: "bb.py auth-check timed out." }); }, timeoutMs);
    child.stdout.on("data", (c) => (out += c));
    child.on("error", (e) => finish({ status: "error", message: `Could not run bb.py: ${e.message}` }));
    child.on("close", (code) => {
      try {
        const data = JSON.parse(out);
        finish({ status: data.status, user: data.user, roles: data.roles, url: data.url, message: data.message,
                 next_steps: data.next_steps, source: data.credentials && data.credentials.source });
      } catch {
        finish({ status: "error", message: `bb.py auth-check returned no result (exit ${code}).` });
      }
    });
  });
}

module.exports = { authCheck };

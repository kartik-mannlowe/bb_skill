"use strict";
// Hand-off between the installer and the sign-in tab: a small JSON file in a private (0700) temp
// directory. It carries only state, a message and the user ID, never a credential.
const fs = require("fs");
const os = require("os");
const path = require("path");

function createStatusFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brewboard-login-"));
  fs.chmodSync(dir, 0o700);
  return path.join(dir, "status.json");
}

function writeStatus(file, state, extra = {}) {
  if (!file) return;
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ state, at: new Date().toISOString(), ...extra }), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readStatus(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function removeStatusFile(file) {
  try { fs.rmSync(path.dirname(file), { recursive: true, force: true }); } catch { /* ignore */ }
}

const FINAL = new Set(["success", "failed", "cancelled", "busy"]);

// Resolves with the final status, or {state: "not_started"} / {state: "timeout"}.
function waitForStatus(file, { startTimeoutMs = 20000, totalTimeoutMs = 15 * 60 * 1000, intervalMs = 400,
                               onStarted = () => {} } = {}) {
  const t0 = Date.now();
  let started = false;
  return new Promise((resolve) => {
    const tick = () => {
      const s = readStatus(file);
      if (s && !started && s.state !== "pending") { started = true; onStarted(s); }
      if (s && FINAL.has(s.state)) return resolve(s);
      const elapsed = Date.now() - t0;
      if (!started && elapsed > startTimeoutMs) return resolve({ state: "not_started" });
      if (elapsed > totalTimeoutMs) return resolve({ state: "timeout" });
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

module.exports = { createStatusFile, writeStatus, readStatus, removeStatusFile, waitForStatus };

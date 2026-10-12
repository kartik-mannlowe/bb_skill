"use strict";
// One sign-in at a time: ~/.bb/login.lock is created exclusively (O_EXCL) with the owner's pid.
// A lock whose process is gone, or older than 30 minutes, is stale and replaced.
const fs = require("fs");

const STALE_MS = 30 * 60 * 1000;

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

function inspect(file) {
  try {
    const info = JSON.parse(fs.readFileSync(file, "utf8"));
    const fresh = Date.now() - Date.parse(info.started) < STALE_MS;
    return { ...info, active: Boolean(info.pid && alive(info.pid) && fresh) };
  } catch { return null; }
}

function acquire(file) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, "wx", 0o600);
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
      fs.closeSync(fd);
      return { acquired: true, release: () => { try { if ((inspect(file) || {}).pid === process.pid) fs.rmSync(file); } catch { /* gone */ } } };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const held = inspect(file);
      if (held && held.active) return { acquired: false, holder: held };
      fs.rmSync(file, { force: true }); // stale
    }
  }
  return { acquired: false, holder: inspect(file) };
}

module.exports = { acquire, inspect };

"use strict";
// Version helpers and the Python lookup shared by the preflight and the sign-in tab.
const { spawnSync } = require("child_process");

const MIN_PY = [3, 8];

function versionAtLeast(have, want) {
  for (let i = 0; i < want.length; i++) {
    if ((have[i] || 0) !== want[i]) return (have[i] || 0) > want[i];
  }
  return true;
}

function findPython(env = process.env, run = spawnSync) {
  const candidates = env.BB_PYTHON ? [env.BB_PYTHON] : ["python3", "python"];
  for (const cmd of candidates) {
    const r = run(cmd, ["-c", "import sys; print('%d.%d.%d' % sys.version_info[:3])"], { encoding: "utf8" });
    if (r.status === 0 && r.stdout) {
      const v = r.stdout.trim().split(".").map(Number);
      return { cmd, version: v.join("."), ok: versionAtLeast(v, MIN_PY) };
    }
  }
  return null;
}

module.exports = { findPython, versionAtLeast };

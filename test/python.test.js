"use strict";
// Runs the Python client's tests (test/python, standard-library unittest) as part of `npm test`.
// -B and PYTHONDONTWRITEBYTECODE keep bytecode out of dist/ (check-dist would reject it).
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { spawnSync } = require("child_process");

test("Python client: views, terminal output, bb.py end to end (test/python)", () => {
  const r = spawnSync("python3", ["-B", "-m", "unittest", "discover", "-s", "test/python", "-t", "test/python", "-v"], {
    cwd: path.join(__dirname, ".."), encoding: "utf8", timeout: 240000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  const summary = (r.stderr.match(/Ran \d+ tests? in [\d.]+s\s+(OK.*|FAILED.*)/) || [r.stderr.slice(-3000)])[0];
  process.stdout.write(`# python: ${summary.replace(/\s+/g, " ")}\n`);
  assert.strictEqual(r.status, 0, r.stderr.slice(-6000));
});

"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { tmpHome } = require("./helpers");
const { preflight, renderPreflight } = require("../lib/preflight");
const { detectAgents } = require("../lib/agents");

function tree(dir) {
  const out = [];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
    const p = path.join(d, e.name); out.push(`${p}:${e.isDirectory() ? "d" : fs.statSync(p).mtimeMs}`);
    if (e.isDirectory()) walk(p);
  });
  walk(dir);
  return out.sort();
}
const row = (r, check) => r.rows.find((x) => x.check === check);
const fakeDetect = (present) => (opts) => detectAgents({ ...opts, whichFn: (b) => (present.includes(b) ? `/bin/${b}` : null),
                                                        versionFn: () => "9.9.9", exists: () => false });

test("passes on this system and is strictly read-only", async () => {
  const h = tmpHome();
  try {
    const before = tree(h.home);
    const r = await preflight({ paths: h.paths, env: h.env, detect: fakeDetect(["claude", "codex", "opencode", "agy"]),
                                authCheckFn: async () => ({ status: "not_configured" }) });
    assert.ok(r.ok, renderPreflight(r));
    assert.deepStrictEqual(tree(h.home), before, "preflight wrote nothing");
    assert.strictEqual(row(r, "Brewboard sign-in").result, "missing");
    assert.match(renderPreflight(r), /Claude Code\s+installed 9\.9\.9/);
  } finally { h.cleanup(); }
});

test("each agent is optional: missing agents are reported, not blocking", async () => {
  const h = tmpHome();
  try {
    for (const present of [[], ["claude"], ["codex"], ["opencode"], ["agy"]]) {
      const r = await preflight({ paths: h.paths, env: h.env, detect: fakeDetect(present) });
      assert.ok(r.ok);
      for (const a of r.agents) assert.strictEqual(a.install, present.includes(a.cli), `${a.id} with ${present}`);
      if (!present.length) assert.strictEqual(row(r, "Agents").level, "warn");
    }
  } finally { h.cleanup(); }
});

test("--agents limits the selection", async () => {
  const h = tmpHome();
  try {
    const r = await preflight({ paths: h.paths, env: h.env, agentFilter: ["codex"], detect: fakeDetect(["claude", "codex"]) });
    assert.deepStrictEqual(r.agents.filter((a) => a.install).map((a) => a.id), ["codex"]);
    assert.strictEqual(row(r, "Claude Code").result, "not selected (--agents)");
  } finally { h.cleanup(); }
});

test("unsupported OS and missing prerequisites stop before anything is changed", async () => {
  const h = tmpHome();
  try {
    let r = await preflight({ paths: h.paths, env: h.env, platform: "win32", detect: fakeDetect([]) });
    assert.ok(!r.ok);
    assert.strictEqual(row(r, "Operating system").level, "unsupported");
    r = await preflight({ paths: h.paths, env: h.env, nodeVersion: "16.20.0", detect: fakeDetect([]) });
    assert.strictEqual(row(r, "Node.js").level, "fail");
    r = await preflight({ paths: h.paths, env: h.env, run: () => ({ status: 127 }), detect: fakeDetect([]) });
    assert.strictEqual(row(r, "Python").level, "fail");
    assert.ok(!r.ok);
    r = await preflight({ paths: h.paths, env: h.env,
                          run: (cmd, args) => (args[1].includes("ssl") ? { status: 1 } : { status: 0, stdout: "3.12.1" }),
                          detect: fakeDetect([]) });
    assert.match(row(r, "Python").result, /ssl/);
  } finally { h.cleanup(); }
});

test("terminal row: new tab, current terminal, or none", async () => {
  const h = tmpHome();
  try {
    let r = await preflight({ paths: h.paths, env: { ...h.env, SSH_CONNECTION: "x" }, isTTY: true, detect: fakeDetect([]) });
    assert.match(row(r, "Terminal").result, /current terminal \(this is an SSH session\)/);
    r = await preflight({ paths: h.paths, env: { ...h.env, SSH_CONNECTION: "x" }, isTTY: false, detect: fakeDetect([]) });
    assert.strictEqual(row(r, "Terminal").level, "warn");
  } finally { h.cleanup(); }
});

test("sign-in status rows", async () => {
  const h = tmpHome();
  try {
    const cases = { ok: /valid: u on http/, credentials_rejected: /rejected/, unreachable: /unreachable/ };
    for (const [status, re] of Object.entries(cases)) {
      const r = await preflight({ paths: h.paths, env: h.env, detect: fakeDetect([]),
                                  authCheckFn: async () => ({ status, user: "u", url: "http://x" }) });
      assert.match(row(r, "Brewboard sign-in").result, re);
    }
  } finally { h.cleanup(); }
});

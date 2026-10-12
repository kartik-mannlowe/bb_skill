"use strict";
// End-to-end discovery with the real agent CLIs (skipped for any CLI not installed here, or when
// BB_SKIP_AGENT_E2E=1). Installs into a temporary HOME and asks each CLI, without any model call,
// what it discovered:  codex debug prompt-input · opencode debug skill / debug config · agy -p /skills.
// Claude Code has no offline listing; its commands are verified by file placement (install.test.js).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const { spawnSync } = require("child_process");
const { tmpHome } = require("./helpers");
const { install } = require("../lib/install");
const { detectAgents } = require("../lib/agents");

const skipAll = process.env.BB_SKIP_AGENT_E2E === "1";
const real = (bin) => spawnSync("sh", ["-c", 'command -v "$1"', "sh", bin], { encoding: "utf8" }).status === 0;

function installed(ids) {
  const h = tmpHome({ realPath: true });
  const agents = detectAgents({ env: h.env, home: h.home }).filter((a) => ids.includes(a.id) && a.cliPath);
  const r = install(h.paths, { agents });
  ids.forEach((id) => assert.notStrictEqual((r.agents[id] || {}).status, "failed", id));
  return h;
}
const run = (h, cmd, args, extraEnv = {}) =>
  spawnSync(cmd, args, { encoding: "utf8", env: { ...h.env, ...extraEnv }, timeout: 120000 });

test("Codex discovers the bb skill", { skip: (skipAll || !real("codex")) && "codex not available" }, () => {
  const h = installed(["codex"]);
  try {
    fs.mkdirSync(`${h.home}/.codex`, { recursive: true });
    const r = run(h, "codex", ["debug", "prompt-input", "hello"], { CODEX_HOME: `${h.home}/.codex` });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /bb: Use when the user types \/bb/);
  } finally { h.cleanup(); }
});

test("OpenCode discovers the bb skill once and the /bb commands", { skip: (skipAll || !real("opencode")) && "opencode not available" }, () => {
  const h = installed(["opencode"]);
  try {
    const skills = JSON.parse(run(h, "opencode", ["debug", "skill"]).stdout);
    const bb = skills.filter((s) => s.name === "bb");
    assert.strictEqual(bb.length, 1, "exactly one `bb` skill");
    assert.match(bb[0].location, /\.agents\/skills\/bb\/SKILL\.md$/);
    const cfg = JSON.parse(run(h, "opencode", ["debug", "config"]).stdout);
    const cmds = Object.keys(cfg.command || {});
    for (const c of ["bb", "bb-list_tasks", "bb-log_time", "bb-create_mom"]) assert.ok(cmds.includes(c), c);
  } finally { h.cleanup(); }
});

test("Antigravity discovers the bb skill (slash command /bb)", { skip: (skipAll || !real("agy")) && "agy not available" }, () => {
  const h = installed(["antigravity"]);
  try {
    const r = run(h, "agy", ["-p", "/skills"]);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /^bb\tUse when the user types \/bb/m);
  } finally { h.cleanup(); }
});

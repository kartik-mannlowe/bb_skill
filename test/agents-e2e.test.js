"use strict";
// End-to-end discovery with the real agent CLIs (skipped for any CLI not installed here, or when
// BB_SKIP_AGENT_E2E=1). Installs into a temporary HOME and asks each CLI, without any model call,
// what it discovered:  claude plugin list · codex debug prompt-input · opencode debug skill / debug config ·
// agy -p /skills. What these cannot show (the interactive suggestions, what picking an entry types, and what a model
// does with the arguments) needs a manual check. Claude Code has no offline listing of its commands and personal
// skills; install.test.js checks their placement.
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

const SUBS = ["init", "list_projects", "list_tasks", "list_tickets", "cycles", "log_time", "timesheets", "create_mom", "moms",
              "show", "find", "status"];

test("Claude Code: the entries are personal skills `bb <sub>`, not a plugin (no /bb:<sub> namespace)", { skip: (skipAll || !real("claude")) && "claude not available" }, () => {
  const h = installed(["claude"]);
  try {
    const list = run(h, "claude", ["plugin", "list"], { CLAUDE_CONFIG_DIR: `${h.home}/.claude` });
    assert.strictEqual(list.status, 0, list.stderr);
    assert.doesNotMatch(list.stdout, /bb@skills-dir/, "the bb folder is not a plugin");
    for (const x of SUBS) assert.ok(fs.existsSync(`${h.home}/.claude/skills/bb ${x}/SKILL.md`), x);
  } finally { h.cleanup(); }
});

test("Codex discovers the bb skill and one skill named `bb <sub>` per subcommand", { skip: (skipAll || !real("codex")) && "codex not available" }, () => {
  const h = installed(["codex"]);
  try {
    fs.mkdirSync(`${h.home}/.codex`, { recursive: true });
    const r = run(h, "codex", ["debug", "prompt-input", "hello"], { CODEX_HOME: `${h.home}/.codex` });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /- bb: Use when the user types \/bb/);
    for (const x of SUBS) assert.match(r.stdout, new RegExp(`- bb ${x}: Brewboard \`\\$bb ${x}\``), x);
    const listed = r.stdout.match(/- bb( [a-z_]+)?: /g) || [];
    assert.doesNotMatch(r.stdout, /- bb-[a-z-]+: /, "no hyphenated $bb-<id> skills");
    assert.strictEqual(listed.length, 1 + SUBS.length, "each Brewboard skill is listed once");
  } finally { h.cleanup(); }
});

test("OpenCode discovers the bb skill once, the /bb command and one `bb <sub>` command per subcommand, all forwarding their arguments", { skip: (skipAll || !real("opencode")) && "opencode not available" }, () => {
  const h = installed(["opencode"]);
  try {
    const skills = JSON.parse(run(h, "opencode", ["debug", "skill"]).stdout);
    const bb = skills.filter((s) => /^bb(-|$)/.test(s.name));
    assert.deepStrictEqual(bb.map((s) => s.name), ["bb"], "exactly one Brewboard skill");
    assert.match(bb[0].location, /\.agents\/skills\/bb\/SKILL\.md$/);
    const cfg = JSON.parse(run(h, "opencode", ["debug", "config"]).stdout);
    const cmds = Object.keys(cfg.command || {}).filter((c) => /^bb/.test(c)).sort();
    assert.deepStrictEqual(cmds, ["bb", ...SUBS.map((x) => `bb ${x}`)].sort(), "/bb and `bb <sub>`, no /bb-* or /bb/<sub> commands");
    assert.match(cfg.command.bb.template, /Subcommand and arguments: \$ARGUMENTS\n/);
    for (const x of SUBS) assert.match(cfg.command[`bb ${x}`].template, new RegExp(`Subcommand and arguments: ${x} \\$ARGUMENTS$`), x);
  } finally { h.cleanup(); }
});

test("Antigravity discovers the bb skill once (/bb) and one skill named `bb <sub>` per subcommand", { skip: (skipAll || !real("agy")) && "agy not available" }, () => {
  const h = installed(["antigravity"]);
  try {
    assert.ok(fs.existsSync(`${h.home}/.gemini/antigravity-cli/skills/bb/SKILL.md`));
    assert.ok(!fs.existsSync(`${h.home}/.gemini/config/skills/bb`), "no second registration");
    const r = run(h, "agy", ["-p", "/skills"]);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(r.stdout.split("\n").filter((l) => /^bb/.test(l)).map((l) => l.split("\t")[0]).sort(),
                           ["bb", ...SUBS.map((x) => `bb ${x}`)].sort(), "the skill bb and `bb <sub>`, nothing namespaced");
    assert.match(r.stdout, /^bb\tUse when the user types \/bb/m);
  } finally { h.cleanup(); }
});

"use strict";
// Recovery: interrupted installs, a corrupt installed.json, and install paths that are folders,
// links or unreadable. Everything runs in temporary homes.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { tmpHome } = require("./helpers");
const { install, InstallError } = require("../lib/install");
const { planUninstall, executeUninstall, exitCode } = require("../lib/uninstall");
const { detectAgents, agentPaths } = require("../lib/agents");
const { preflight } = require("../lib/preflight");
const tracking = require("../lib/tracking");
const { main } = require("../lib/cli");

const ROOT = path.join(__dirname, "..");
const asRoot = process.getuid && process.getuid() === 0;

// All four agents present through their config folders (no CLIs needed).
function withAgents(h) {
  const ap = agentPaths(h.env, h.home);
  [ap.claudeDir, ap.codexDir, ap.opencodeDir, ap.antigravityDir].forEach((d) => fs.mkdirSync(d, { recursive: true }));
  return { ap, agents: detectAgents({ env: h.env, home: h.home, whichFn: () => null }).filter((a) => a.present) };
}

// Every file and folder (folders end in "/") below home except ~/.bb, relative and sorted.
function filesOutsideBb(home) {
  const out = [];
  const visit = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (full === path.join(home, ".bb")) continue;
      if (e.isDirectory()) { out.push(`${path.relative(home, full)}/`); visit(full); } else out.push(path.relative(home, full));
    }
  };
  visit(home);
  return out.sort();
}

function capture() {
  const chunks = [];
  return { write: (s) => { chunks.push(String(s)); return true; }, text: () => chunks.join("") };
}

// ------------------------------------------------------------------ D1: interrupted installs

// Runs install in a child process that is SIGKILLed at its k-th fs.renameSync (0: never). Returns the count.
const CHILD = `
const [home, k, root] = process.argv.slice(1);
const fs = require("fs");
const real = fs.renameSync;
let n = 0;
fs.renameSync = function (...a) { if (++n === Number(k)) process.kill(process.pid, "SIGKILL"); return real.apply(this, a); };
const { install } = require(root + "/lib/install");
const { resolvePaths } = require(root + "/lib/paths");
const { detectAgents } = require(root + "/lib/agents");
const env = { HOME: home, PATH: "/usr/bin:/bin" };
const agents = detectAgents({ env, home, whichFn: () => null }).filter((a) => a.present);
install(resolvePaths(env), { agents, version: "t" });
process.stdout.write(String(n));
`;

function seededHome() {
  const h = tmpHome();
  const { ap } = withAgents(h);
  // A user's own command at a path Brewboard installs to, and an old Brewboard copy at a legacy path.
  fs.mkdirSync(path.join(ap.claudeDir, "commands"), { recursive: true });
  fs.writeFileSync(path.join(ap.claudeDir, "commands", "bb.md"), "the user's own /bb command\n");
  const legacy = path.join(ap.opencodeDir, "skills", "bb", "SKILL.md");
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, "Brewboard skill: python3 ~/.bb/skill/scripts/bb.py\n");
  return { h, ap, before: filesOutsideBb(h.home), legacy };
}

test("an install killed at any file operation is recovered by the next run; uninstall then restores everything", () => {
  const probe = seededHome();
  const total = Number(spawnSync(process.execPath, ["-e", CHILD, probe.h.home, "0", ROOT], { encoding: "utf8" }).stdout);
  probe.h.cleanup();
  assert.ok(total > 40, `expected many file operations, saw ${total}`);

  for (let k = 1; k <= total; k++) {
    const { h, ap, before, legacy } = seededHome();
    try {
      const r = spawnSync(process.execPath, ["-e", CHILD, h.home, String(k), ROOT], { encoding: "utf8" });
      assert.strictEqual(r.signal, "SIGKILL", `k=${k}: the child was not interrupted`);

      const again = install(h.paths, { agents: withAgents(h).agents, version: "t" });
      assert.ok(again.validation.ok, `k=${k}: ${again.validation.mismatched}`);
      for (const [id, res] of Object.entries(again.agents)) assert.notStrictEqual(res.status, "failed", `k=${k} ${id}: ${res.error}`);

      const plan = planUninstall(h.paths);
      assert.deepStrictEqual(plan.keep.map((x) => `${x.path}: ${x.reason}`), [], `k=${k}: files mistaken for the user's`);
      assert.deepStrictEqual(plan.conflicts, [], `k=${k}`);
      assert.deepStrictEqual(plan.manual, [], `k=${k}`);
      const done = executeUninstall(h.paths, plan);
      assert.strictEqual(exitCode(done), 0, `k=${k}: ${JSON.stringify(done.failed)}`);
      assert.ok(done.trackingRemoved, `k=${k}`);
      assert.deepStrictEqual(filesOutsideBb(h.home), before, `k=${k}: leftovers or missing files`);
      assert.strictEqual(fs.readFileSync(path.join(ap.claudeDir, "commands", "bb.md"), "utf8"), "the user's own /bb command\n");
      assert.ok(fs.existsSync(legacy), `k=${k}: the old copy was not put back`);
    } finally { h.cleanup(); }
  }
});

test("leftover temp files of an interrupted write are cleaned up by the next install", () => {
  const h = tmpHome();
  try {
    const { ap, agents } = withAgents(h);
    const dir = path.join(ap.claudeDir, "commands");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "bb.md.12345.tmp"), "half");
    fs.writeFileSync(path.join(dir, "notes.md.tmp"), "someone else's");
    fs.mkdirSync(h.paths.bbHome, { recursive: true });
    fs.writeFileSync(path.join(h.paths.bbHome, "installed.json.999.tmp"), "{");
    install(h.paths, { agents });
    assert.ok(!fs.existsSync(path.join(dir, "bb.md.12345.tmp")));
    assert.ok(!fs.existsSync(path.join(h.paths.bbHome, "installed.json.999.tmp")));
    assert.ok(fs.existsSync(path.join(dir, "notes.md.tmp")), "only the installer's own temp names are removed");
  } finally { h.cleanup(); }
});

// ------------------------------------------------------------------ D2: corrupt installed.json

function corrupt(h) {
  const file = tracking.trackingFile(h.paths);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{ truncated");
  return file;
}

test("install refuses to overwrite a corrupt installed.json and writes nothing", () => {
  const h = tmpHome();
  try {
    const { ap, agents } = withAgents(h);
    const file = corrupt(h);
    assert.throws(() => install(h.paths, { agents }), tracking.TrackingError);
    assert.strictEqual(fs.readFileSync(file, "utf8"), "{ truncated");
    assert.ok(!fs.existsSync(h.paths.skillDir));
    assert.ok(!fs.existsSync(path.join(ap.claudeDir, "commands")));
  } finally { h.cleanup(); }
});

test("the preflight blocks on a corrupt installed.json and the CLI changes nothing", async () => {
  const h = tmpHome();
  try {
    withAgents(h);
    const file = corrupt(h);
    const report = await preflight({ paths: h.paths, env: h.env, isTTY: false });
    const row = report.rows.find((r) => r.check === "Install record");
    assert.ok(row && row.level === "fail", JSON.stringify(report.rows));
    assert.match(row.action, /never overwritten/);
    assert.strictEqual(report.ok, false);

    const out = capture(), err = capture();
    const code = await main(["--no-login"], { env: h.env, stdin: { isTTY: false }, stdout: out, stderr: err });
    assert.strictEqual(code, 1);
    assert.match(err.text(), /Cannot install: Install record: unreadable/);
    assert.match(err.text(), /Nothing was changed/);
    assert.strictEqual(fs.readFileSync(file, "utf8"), "{ truncated");
    assert.ok(!fs.existsSync(h.paths.skillDir));
  } finally { h.cleanup(); }
});

test("a sign-in never overwrites a corrupt installed.json", () => {
  const h = tmpHome();
  try {
    const file = corrupt(h);
    fs.writeFileSync(h.paths.configFile, "{}");
    assert.strictEqual(tracking.recordConfig(h.paths, null), false);
    assert.strictEqual(fs.readFileSync(file, "utf8"), "{ truncated");
  } finally { h.cleanup(); }
});

// ------------------------------------------------------------------ D3: occupied / unreadable / non-file paths

test("a folder where a command file goes fails that agent with a plain message; the others install", () => {
  const h = tmpHome();
  try {
    const { ap, agents } = withAgents(h);
    const occupied = path.join(ap.claudeDir, "commands", "bb.md");
    fs.mkdirSync(path.join(occupied, "inside"), { recursive: true });
    const r = install(h.paths, { agents });
    assert.strictEqual(r.agents.claude.status, "failed");
    assert.match(r.agents.claude.error, /bb\.md is a folder, not a file; move it aside/);
    for (const id of ["codex", "opencode", "antigravity"]) assert.strictEqual(r.agents[id].status, "installed");
    assert.ok(r.validation.ok, r.validation.mismatched.join(", "));
    assert.ok(!(occupied in tracking.readTracking(h.paths).files), "a path Brewboard could not write is not recorded");
    assert.ok(fs.existsSync(path.join(occupied, "inside")), "the folder is untouched");

    const plan = planUninstall(h.paths); // must not throw
    assert.ok(!plan.blocked);
    assert.doesNotThrow(() => install(h.paths, { agents }));
  } finally { h.cleanup(); }
});

test("a symbolic link where a skill file goes is never replaced", () => {
  const h = tmpHome();
  try {
    const { ap, agents } = withAgents(h);
    const real = path.join(h.home, "my-skills", "bb.md");
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.writeFileSync(real, "managed elsewhere");
    const link = path.join(ap.antigravityDir, "skills", "bb", "SKILL.md");
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(real, link);
    const r = install(h.paths, { agents });
    assert.strictEqual(r.agents.antigravity.status, "failed");
    assert.match(r.agents.antigravity.error, /is a symbolic link; Brewboard does not replace links/);
    assert.strictEqual(fs.readlinkSync(link), real);
    assert.strictEqual(fs.readFileSync(real, "utf8"), "managed elsewhere");
  } finally { h.cleanup(); }
});

test("an unreadable file where a command goes fails that agent; nothing is overwritten", { skip: asRoot && "root reads everything" }, () => {
  const h = tmpHome();
  try {
    const { ap, agents } = withAgents(h);
    const file = path.join(ap.opencodeDir, "commands", "bb.md");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "secret notes");
    fs.chmodSync(file, 0o000);
    const r = install(h.paths, { agents });
    assert.strictEqual(r.agents.opencode.status, "failed");
    assert.match(r.agents.opencode.error, /cannot be read \(permission denied\)/);
    fs.chmodSync(file, 0o600);
    assert.strictEqual(fs.readFileSync(file, "utf8"), "secret notes");
  } finally { h.cleanup(); }
});

test("a folder in place of a core skill file stops the install with a plain message", async () => {
  const h = tmpHome();
  try {
    const { agents } = withAgents(h);
    fs.mkdirSync(path.join(h.paths.skillDir, "SKILL.md"), { recursive: true });
    assert.throws(() => install(h.paths, { agents }), (e) => e instanceof InstallError &&
      /the core skill could not be installed: .*SKILL\.md is a folder/.test(e.message));
    const r = spawnSync(process.execPath, [path.join(ROOT, "bin/brewboard-skill.js"), "--no-login"],
                        { env: { ...h.env, BB_TERMINAL: "none" }, encoding: "utf8", input: "" });
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /brewboard-skill: the core skill could not be installed/);
    assert.doesNotMatch(r.stderr, /EISDIR|\n\s+at /, "no raw error or stack trace");
  } finally { h.cleanup(); }
});

test("uninstall keeps tracked paths that became folders, links or unreadable, and says why", { skip: asRoot && "root reads everything" }, async () => {
  const h = tmpHome();
  try {
    const { ap, agents } = withAgents(h);
    install(h.paths, { agents });
    const skill = (id) => path.join(ap.codexDir, "skills", id, "SKILL.md");
    fs.rmSync(skill("bb-find"));
    fs.mkdirSync(skill("bb-find"));
    fs.rmSync(skill("bb-moms"));
    fs.symlinkSync("/etc/hostname", skill("bb-moms"));
    fs.chmodSync(skill("bb-show"), 0o000);

    const plan = planUninstall(h.paths);
    const reasons = Object.fromEntries(plan.keep.map((k) => [path.basename(path.dirname(k.path)), k.reason]));
    assert.match(reasons["bb-find"], /is now a folder; left alone/);
    assert.match(reasons["bb-moms"], /is now a symbolic link; left alone/);
    assert.match(reasons["bb-show"], /cannot be read \(permission denied\); left alone/);

    const out = capture(), err = capture();
    assert.strictEqual(await main(["uninstall", "--dry-run"], { env: h.env, stdin: { isTTY: false }, stdout: out, stderr: err }), 0);
    const r = executeUninstall(h.paths, plan);
    assert.strictEqual(exitCode(r), 2);
    assert.ok(fs.statSync(skill("bb-find")).isDirectory());
    assert.strictEqual(fs.readlinkSync(skill("bb-moms")), "/etc/hostname");
    assert.ok(fs.existsSync(skill("bb-show")));
    assert.ok(!fs.existsSync(path.join(ap.claudeDir, "commands", "bb.md")), "everything else was removed");
    assert.ok(!fs.existsSync(skill("bb-log-time")), "everything else was removed");
    fs.chmodSync(skill("bb-show"), 0o644);
  } finally { h.cleanup(); }
});

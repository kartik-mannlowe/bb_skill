"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { tmpHome } = require("./helpers");
const { install, readManifest, readOwned } = require("../lib/install");
const { detectAgents, agentPaths } = require("../lib/agents");

// All four agents "present" (config dirs exist), without needing their CLIs.
function withAgents(h, ids = ["claude", "codex", "opencode", "antigravity"]) {
  const ap = agentPaths(h.env, h.home);
  const dirs = { claude: ap.claudeDir, codex: ap.codexDir, opencode: ap.opencodeDir, antigravity: ap.antigravityDir };
  ids.forEach((id) => fs.mkdirSync(dirs[id], { recursive: true }));
  return { ap, agents: detectAgents({ env: h.env, home: h.home, whichFn: () => null }).filter((a) => a.present) };
}

const files = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);
const SUBS = ["init", "list_projects", "list_tasks", "list_tickets", "cycles", "log_time", "timesheets", "create_mom", "moms",
              "show", "find", "status"];
const CODEX_IDS = ["bb-create-mom", "bb-cycles", "bb-find", "bb-init", "bb-list-projects", "bb-list-tasks", "bb-list-tickets",
                   "bb-log-time", "bb-moms", "bb-show", "bb-status", "bb-timesheets"];

test("installs the core skill and the right files for each agent", () => {
  const h = tmpHome();
  try {
    const { ap, agents } = withAgents(h);
    const r = install(h.paths, { agents, version: "t" });
    assert.ok(r.validation.ok);
    assert.strictEqual(fs.statSync(h.paths.bbPy).mode & 0o777, 0o755);
    assert.strictEqual(fs.statSync(h.paths.bbHome).mode & 0o777, 0o700);
    assert.deepStrictEqual(files(path.join(ap.claudeDir, "commands")), ["bb.md"], "one /bb command, no /bb-* shortcuts");
    // One suggestion entry per subcommand, named `bb <sub>`: what picking it types.
    assert.deepStrictEqual(files(path.join(ap.opencodeDir, "commands")), ["bb.md", ...SUBS.map((x) => `bb ${x}.md`)].sort());
    assert.deepStrictEqual(files(path.join(ap.claudeDir, "skills")), SUBS.map((x) => `bb ${x}`).sort());
    for (const x of SUBS) assert.ok(fs.existsSync(path.join(ap.claudeDir, "skills", `bb ${x}`, "SKILL.md")), x);
    assert.deepStrictEqual(files(path.join(ap.antigravityDir, "skills")), ["bb", ...CODEX_IDS].sort());
    assert.ok(!fs.existsSync(path.join(ap.antigravityDir, "plugins")) && !fs.existsSync(path.join(ap.claudeDir, "skills", "bb")),
              "no namespaced /bb:<sub> plugins");
    assert.ok(fs.existsSync(path.join(ap.agentSkills, "bb", "SKILL.md")));
    assert.deepStrictEqual(files(ap.agentSkills), ["bb"], "Codex shortcuts stay out of the folder OpenCode also reads");
    assert.deepStrictEqual(files(path.join(ap.codexDir, "skills")), CODEX_IDS);
    for (const id of CODEX_IDS) assert.ok(fs.existsSync(path.join(ap.codexDir, "skills", id, "SKILL.md")), id);
    assert.ok(fs.existsSync(path.join(ap.antigravityDir, "skills", "bb", "SKILL.md")));
    assert.ok(!fs.existsSync(path.join(ap.geminiConfig, "skills")), "Antigravity's skill is registered once");
    assert.ok(!fs.existsSync(path.join(ap.opencodeDir, "skills", "bb")), "no duplicate `bb` skill for OpenCode");
    const shared = readOwned(h.paths).files[path.join(ap.agentSkills, "bb", "SKILL.md")];
    assert.deepStrictEqual(shared.agents.sort(), ["codex", "opencode"]);
    const oc = fs.readFileSync(path.join(ap.opencodeDir, "commands", "bb.md"), "utf8");
    assert.ok(!/AskUserQuestion|argument-hint/.test(oc), "OpenCode commands carry no Claude-only syntax");
    const skill = fs.readFileSync(path.join(ap.agentSkills, "bb", "SKILL.md"), "utf8");
    assert.match(skill, /^---\nname: bb\ndescription: ".+"\n---/);
    for (const id of ["claude", "codex", "opencode", "antigravity"]) assert.strictEqual(r.agents[id].status, "installed");
  } finally { h.cleanup(); }
});

for (const only of ["claude", "codex", "opencode", "antigravity"]) {
  test(`only ${only} present: only its integration is installed`, () => {
    const h = tmpHome();
    try {
      const { ap, agents } = withAgents(h, [only]);
      const r = install(h.paths, { agents });
      assert.deepStrictEqual(Object.keys(r.agents), [only]);
      const want = {
        claude: [path.join(ap.claudeDir, "commands", "bb.md"), path.join(ap.claudeDir, "skills", "bb log_time", "SKILL.md")],
        codex: [path.join(ap.agentSkills, "bb", "SKILL.md"), path.join(ap.codexDir, "skills", "bb-log-time", "SKILL.md")],
        opencode: [path.join(ap.opencodeDir, "commands", "bb.md"), path.join(ap.opencodeDir, "commands", "bb log_time.md"),
                   path.join(ap.agentSkills, "bb", "SKILL.md")],
        antigravity: [path.join(ap.antigravityDir, "skills", "bb", "SKILL.md"),
                      path.join(ap.antigravityDir, "skills", "bb-log-time", "SKILL.md")],
      }[only];
      want.forEach((f) => assert.ok(fs.existsSync(f), f));
      const all = { claude: path.join(ap.claudeDir, "commands", "bb.md"), oc: path.join(ap.opencodeDir, "commands", "bb.md"),
                    ag: path.join(ap.antigravityDir, "skills", "bb", "SKILL.md"), shared: path.join(ap.agentSkills, "bb", "SKILL.md"),
                    codexShortcut: path.join(ap.codexDir, "skills", "bb-log-time", "SKILL.md"),
                    claudeSub: path.join(ap.claudeDir, "skills", "bb log_time", "SKILL.md"),
                    ocSub: path.join(ap.opencodeDir, "commands", "bb log_time.md"),
                    agSub: path.join(ap.antigravityDir, "skills", "bb-log-time", "SKILL.md"),
                    oldAg: path.join(ap.geminiConfig, "skills", "bb", "SKILL.md") };
      for (const f of Object.values(all)) if (!want.includes(f)) assert.ok(!fs.existsSync(f), `unexpected ${f}`);
    } finally { h.cleanup(); }
  });
}

test("reinstall is idempotent and preserves unrelated user files", () => {
  const h = tmpHome();
  try {
    const { ap, agents } = withAgents(h);
    install(h.paths, { agents });
    const mine = [path.join(ap.claudeDir, "commands", "mine.md"), path.join(ap.opencodeDir, "commands", "deploy.md"),
                  path.join(ap.agentSkills, "other", "SKILL.md"), path.join(ap.geminiConfig, "skills", "x", "SKILL.md"),
                  path.join(ap.opencodeDir, "opencode.jsonc"), h.paths.configFile];
    mine.forEach((f) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, "user data"); });
    const r = install(h.paths, { agents });
    assert.strictEqual(r.core.status, "unchanged");
    for (const id of Object.keys(r.agents)) assert.strictEqual(r.agents[id].status, "unchanged", id);
    assert.strictEqual(r.backupDir, null);
    mine.forEach((f) => assert.strictEqual(fs.readFileSync(f, "utf8"), "user data", f));
  } finally { h.cleanup(); }
});

test("replaced files are backed up; Brewboard copies at old paths are moved, foreign files kept", () => {
  const h = tmpHome();
  try {
    const { ap, agents } = withAgents(h);
    const legacyOc = path.join(ap.opencodeDir, "skills", "bb", "SKILL.md");
    const legacyAg = path.join(ap.geminiConfig, "skills", "bb", "SKILL.md");
    const foreign = path.join(ap.claudeDir, "commands", "erpnext-bb.md");
    for (const [f, text] of [[legacyOc, "---\nname: bb\n---\nRead ~/.bb/skill/SKILL.md (Brewboard)"],
                             [legacyAg, "---\nname: bb\n---\nRead ~/.bb/skill/SKILL.md (Brewboard)"],
                             [foreign, "somebody else's command"]]) {
      fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text);
    }
    fs.mkdirSync(path.join(ap.claudeDir, "commands"), { recursive: true });
    fs.writeFileSync(path.join(ap.claudeDir, "commands", "bb.md"), "hand edited");
    const r = install(h.paths, { agents });
    assert.ok(!fs.existsSync(legacyOc) && !fs.existsSync(legacyAg));
    assert.ok(fs.existsSync(foreign));
    const tracking = require("../lib/tracking");
    const t = tracking.readTracking(h.paths);
    const orig = tracking.originalPathFor(h.paths, path.join(ap.claudeDir, "commands", "bb.md"));
    assert.strictEqual(fs.readFileSync(orig, "utf8"), "hand edited", "the earlier file is kept to restore");
    assert.strictEqual(t.files[path.join(ap.claudeDir, "commands", "bb.md")].created, false);
    assert.strictEqual(t.files[path.join(ap.claudeDir, "commands", "bb.md")].original, orig);
    assert.deepStrictEqual(t.moved.map((m) => m.path).sort(), [legacyAg, legacyOc].sort());
    t.moved.forEach((m) => assert.ok(fs.existsSync(m.backup)));
    // An update that replaces one of Brewboard's own files backs it up in an install-<ts> run folder.
    fs.writeFileSync(path.join(ap.codexDir, "skills", "bb-find", "SKILL.md"), "edited Brewboard skill");
    const r2 = install(h.paths, { agents });
    assert.ok(r2.backupDir && fs.existsSync(path.join(r2.backupDir, ".codex/skills/bb-find/SKILL.md")));
    assert.ok(tracking.readTracking(h.paths).backup_runs.includes(r2.backupDir));
    assert.ok(r.agents.opencode.removed.includes(legacyOc));
  } finally { h.cleanup(); }
});

test("a failing agent does not stop the others (partial installation)", { skip: process.getuid && process.getuid() === 0 && "root ignores permissions" }, () => {
  const h = tmpHome();
  try {
    const { ap, agents } = withAgents(h);
    fs.mkdirSync(path.join(ap.opencodeDir, "commands"), { recursive: true });
    fs.chmodSync(path.join(ap.opencodeDir, "commands"), 0o555);
    const r = install(h.paths, { agents });
    assert.strictEqual(r.agents.opencode.status, "failed");
    assert.match(r.agents.opencode.error, /no write access/);
    assert.strictEqual(r.agents.claude.status, "installed");
    assert.strictEqual(r.agents.antigravity.status, "installed");
    assert.strictEqual(r.agents.codex.status, "installed");
    assert.ok(r.validation.ok);
    fs.chmodSync(path.join(ap.opencodeDir, "commands"), 0o755);
  } finally { h.cleanup(); }
});

test("the installed skill has everything /bb init --login needs to open a terminal", () => {
  const h = tmpHome();
  try {
    install(h.paths, { agents: [], version: "t" });
    for (const rel of ["assets/terminals.json", "scripts/bbclient/terminal.py", "scripts/bbclient/signin.py"]) {
      assert.ok(fs.existsSync(path.join(h.paths.skillDir, rel)), rel);
    }
    const { spawnSync } = require("child_process");
    const r = spawnSync("python3", ["-B", h.paths.bbPy, "init", "--help"], { encoding: "utf8", env: { ...h.env, BB_HOME: h.paths.bbHome } });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /--launch/);
  } finally { h.cleanup(); }
});

test("packaged files are checked against the manifest before installing", () => {
  const n = readManifest(require("../lib/paths").resolvePaths(process.env).distDir).files.length;
  assert.strictEqual(n, 67);
});

test("upgrading from the /bb-* layout: retired commands and the old Antigravity copy go, edits and foreign files stay", () => {
  const h = tmpHome();
  try {
    const { ap, agents } = withAgents(h);
    install(h.paths, { agents });
    const tracking = require("../lib/tracking");
    const brewboard = (what) => `Run \`/bb ${what}\` by reading ~/.bb/skill/SKILL.md (Brewboard).\n`;
    const claudeCmd = (n) => path.join(ap.claudeDir, "commands", n);
    const ocCmd = (n) => path.join(ap.opencodeDir, "commands", n);
    const oldAg = path.join(ap.geminiConfig, "skills", "bb", "SKILL.md");
    // What an earlier version installed and recorded (one of them edited by the user since).
    const t = tracking.readTracking(h.paths);
    const old = { [claudeCmd("bb-find.md")]: ["claude", "find"], [claudeCmd("bb-list_tasks.md")]: ["claude", "list_tasks"],
                  [claudeCmd("bb-show.md")]: ["claude", "show"], [ocCmd("bb-log_time.md")]: ["opencode", "log_time"],
                  [oldAg]: ["antigravity", "skill"] };
    for (const [file, [agent, what]] of Object.entries(old)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, brewboard(what));
      t.files[file] = { sha256: tracking.sha(Buffer.from(brewboard(what))), agents: [agent], mode: "644", created: true, original: null };
    }
    tracking.writeTracking(h.paths, t);
    fs.writeFileSync(claudeCmd("bb-show.md"), "my notes in Brewboard's old /bb-show command");
    // Not recorded: a manual copy of an old shortcut, and an unrelated command of the same name.
    fs.writeFileSync(ocCmd("bb-moms.md"), brewboard("moms"));
    fs.writeFileSync(claudeCmd("bb-status.md"), "my own status command");

    const r = install(h.paths, { agents });
    assert.deepStrictEqual(files(path.join(ap.claudeDir, "commands")), ["bb-show.md", "bb-status.md", "bb.md"]);
    assert.deepStrictEqual(files(path.join(ap.opencodeDir, "commands")), ["bb.md", ...SUBS.map((x) => `bb ${x}.md`)].sort());
    assert.ok(fs.existsSync(path.join(ap.claudeDir, "skills", "bb find", "SKILL.md")), "/bb find replaces /bb-find");
    assert.strictEqual(fs.readFileSync(claudeCmd("bb-show.md"), "utf8"), "my notes in Brewboard's old /bb-show command");
    assert.strictEqual(fs.readFileSync(claudeCmd("bb-status.md"), "utf8"), "my own status command");
    assert.ok(!fs.existsSync(oldAg) && fs.existsSync(path.join(ap.antigravityDir, "skills", "bb", "SKILL.md")));
    for (const f of [claudeCmd("bb-find.md"), claudeCmd("bb-list_tasks.md")]) assert.ok(r.agents.claude.removed.includes(f), f);
    assert.ok(r.agents.antigravity.removed.includes(oldAg));
    assert.ok(fs.existsSync(path.join(r.backupDir, ".claude/commands/bb-find.md")), "removed copies are backed up");
    const after = tracking.readTracking(h.paths);
    assert.deepStrictEqual(after.moved.map((m) => m.path), [ocCmd("bb-moms.md")], "the manual copy is moved aside, restorable");
    assert.ok(after.files[claudeCmd("bb-show.md")], "the edited copy stays recorded, so uninstall still reports it");
    assert.deepStrictEqual(r.agents.claude.kept, [claudeCmd("bb-show.md")]);
    assert.ok(r.validation.ok);
  } finally { h.cleanup(); }
});

test("an update removes the folders an earlier layout created once they are empty, and keeps anything else", () => {
  const h = tmpHome();
  try {
    const { ap, agents } = withAgents(h);
    install(h.paths, { agents });
    const tracking = require("../lib/tracking");
    // What the previous layout installed and recorded: a plugin folder and a nested command folder.
    const t = tracking.readTracking(h.paths);
    const oldFiles = { [path.join(ap.claudeDir, "skills", "bb", ".claude-plugin", "plugin.json")]: "claude",
                       [path.join(ap.claudeDir, "skills", "bb", "commands", "find.md")]: "claude",
                       [path.join(ap.opencodeDir, "commands", "bb", "find.md")]: "opencode",
                       [path.join(ap.antigravityDir, "plugins", "bb", "skills", "find", "SKILL.md")]: "antigravity" };
    for (const [file, agent] of Object.entries(oldFiles)) {
      for (let d = path.dirname(file); !fs.existsSync(d); d = path.dirname(d)) t.dirs.push(d);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "old Brewboard entry");
      t.files[file] = { sha256: tracking.sha(Buffer.from("old Brewboard entry")), agents: [agent], mode: "644", created: true, original: null };
    }
    tracking.writeTracking(h.paths, t);
    const mine = path.join(ap.antigravityDir, "plugins", "bb", "notes.txt"); // something of the user's in a folder we made
    fs.writeFileSync(mine, "keep me");
    const r = install(h.paths, { agents });
    assert.ok(r.validation.ok);
    for (const gone of [path.join(ap.claudeDir, "skills", "bb"), path.join(ap.opencodeDir, "commands", "bb"),
                        path.join(ap.antigravityDir, "plugins", "bb", "skills")]) assert.ok(!fs.existsSync(gone), gone);
    assert.strictEqual(fs.readFileSync(mine, "utf8"), "keep me", "a folder holding a user file stays");
    const after = tracking.readTracking(h.paths);
    assert.ok(after.dirs.includes(path.join(ap.antigravityDir, "plugins", "bb")), "and stays recorded for uninstall");
    assert.ok(!after.dirs.includes(path.join(ap.claudeDir, "skills", "bb")), "removed folders leave the record");
    assert.ok(fs.existsSync(path.join(ap.claudeDir, "skills", "bb find", "SKILL.md")), "current entries untouched");
    assert.ok(fs.existsSync(h.paths.backupsDir), "backups (in ~/.bb) are never pruned this way");
  } finally { h.cleanup(); }
});

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

test("installs the core skill and the right files for each agent", () => {
  const h = tmpHome();
  try {
    const { ap, agents } = withAgents(h);
    const r = install(h.paths, { agents, version: "t" });
    assert.ok(r.validation.ok);
    assert.strictEqual(fs.statSync(h.paths.bbPy).mode & 0o777, 0o755);
    assert.strictEqual(fs.statSync(h.paths.bbHome).mode & 0o777, 0o700);
    assert.ok(files(path.join(ap.claudeDir, "commands")).includes("bb-list_tasks.md"));
    assert.strictEqual(files(path.join(ap.claudeDir, "commands")).length, 13);
    assert.strictEqual(files(path.join(ap.opencodeDir, "commands")).length, 13);
    assert.ok(fs.existsSync(path.join(ap.agentSkills, "bb", "SKILL.md")));
    assert.ok(fs.existsSync(path.join(ap.geminiConfig, "skills", "bb", "SKILL.md")));
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
        claude: [path.join(ap.claudeDir, "commands", "bb.md")],
        codex: [path.join(ap.agentSkills, "bb", "SKILL.md")],
        opencode: [path.join(ap.opencodeDir, "commands", "bb.md"), path.join(ap.agentSkills, "bb", "SKILL.md")],
        antigravity: [path.join(ap.geminiConfig, "skills", "bb", "SKILL.md")],
      }[only];
      want.forEach((f) => assert.ok(fs.existsSync(f), f));
      const all = { claude: path.join(ap.claudeDir, "commands", "bb.md"), oc: path.join(ap.opencodeDir, "commands", "bb.md"),
                    ag: path.join(ap.geminiConfig, "skills", "bb", "SKILL.md"), shared: path.join(ap.agentSkills, "bb", "SKILL.md") };
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
    const legacyAg = path.join(ap.antigravityDir, "skills", "bb", "SKILL.md");
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
    fs.writeFileSync(path.join(ap.claudeDir, "commands", "bb-find.md"), "edited Brewboard command");
    const r2 = install(h.paths, { agents });
    assert.ok(r2.backupDir && fs.existsSync(path.join(r2.backupDir, ".claude/commands/bb-find.md")));
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

test("packaged files are checked against the manifest before installing", () => {
  const n = readManifest(require("../lib/paths").resolvePaths(process.env).distDir).files.length;
  assert.strictEqual(n, 38);
});

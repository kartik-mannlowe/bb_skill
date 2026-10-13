"use strict";
// The four supported coding agents: where each discovers Brewboard, and how it is invoked.
// Paths verified on 2026-10-12 against the installed CLIs (Claude Code 2.1.296, Codex 0.162.1,
// OpenCode 1.18.35, Antigravity CLI 1.3.1):
//   Claude Code  ~/.claude/commands/*.md                  slash commands /bb, /bb-*
//   Codex        ~/.agents/skills/<name>/SKILL.md         user Agent Skills ($bb); custom prompts are gone
//   OpenCode     ~/.config/opencode/commands/*.md         slash commands /bb, /bb-*
//                ~/.agents/skills/<name>/SKILL.md         auto-loaded external skills (so no second copy
//                                                         in ~/.config/opencode/skills: duplicate name)
//   Antigravity  ~/.gemini/config/skills/<name>/SKILL.md  global skills; a skill is the slash command /bb
// Discovery checks without a model call: `codex debug prompt-input`, `opencode debug skill`,
// `opencode debug config`, `agy -p "/skills"` (see test/agents-e2e.test.js).
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function agentPaths(env, home) {
  const xdg = env.XDG_CONFIG_HOME || path.join(home, ".config");
  return {
    claudeDir: env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"),
    codexDir: env.CODEX_HOME || path.join(home, ".codex"),
    agentSkills: path.join(home, ".agents", "skills"),
    opencodeDir: path.join(xdg, "opencode"),
    geminiConfig: path.join(home, ".gemini", "config"),
    antigravityDir: path.join(home, ".gemini", "antigravity-cli"),
  };
}

const SHARED_SKILL = (ap) => path.join(ap.agentSkills, "bb", "SKILL.md");

const AGENTS = [
  {
    id: "claude", name: "Claude Code", cli: "claude", tested: "2.1.296",
    configDirs: (ap) => [ap.claudeDir],
    targets: (ap, dist) => dist.filter((f) => f.startsWith("adapters/claude-code/"))
      .map((f) => ({ from: f, to: path.join(ap.claudeDir, "commands", path.basename(f)) })),
    legacy: (ap) => ["bb-tickets.md", "erpnext-bb.md"].map((n) => path.join(ap.claudeDir, "commands", n)),
    discovery: "~/.claude/commands/*.md (slash commands)",
    usage: "/bb (menu), /bb list_tasks …, and shortcuts /bb-list_tasks, /bb-log_time, …",
  },
  {
    id: "codex", name: "Codex CLI", cli: "codex", tested: "0.162.1",
    configDirs: (ap) => [ap.codexDir],
    targets: (ap) => [{ from: "adapters/agent-skill/bb.md", to: SHARED_SKILL(ap) }],
    legacy: (ap) => [path.join(ap.codexDir, "prompts", "bb.md"), path.join(ap.codexDir, "skills", "brewboard", "SKILL.md")],
    discovery: "~/.agents/skills/bb/SKILL.md (user Agent Skill)",
    usage: "$bb <subcommand> (Codex has no custom slash commands), or ask about Brewboard in plain words",
  },
  {
    id: "opencode", name: "OpenCode", cli: "opencode", tested: "1.18.35",
    configDirs: (ap) => [ap.opencodeDir],
    targets: (ap, dist) => [
      ...dist.filter((f) => f.startsWith("adapters/opencode/"))
        .map((f) => ({ from: f, to: path.join(ap.opencodeDir, "commands", path.basename(f)) })),
      { from: "adapters/agent-skill/bb.md", to: SHARED_SKILL(ap) },
    ],
    // An older manual install put the skill here too; OpenCode would then see `bb` twice.
    legacy: (ap) => [path.join(ap.opencodeDir, "skills", "bb", "SKILL.md")],
    discovery: "~/.config/opencode/commands/*.md (slash commands) + ~/.agents/skills/bb (auto-loaded skill)",
    usage: "/bb (menu), /bb list_tasks …, and shortcuts /bb-list_tasks, /bb-log_time, …",
  },
  {
    id: "antigravity", name: "Antigravity CLI", cli: "agy", tested: "1.3.1",
    configDirs: (ap) => [ap.antigravityDir, ap.geminiConfig],
    targets: (ap) => [{ from: "adapters/agent-skill/bb.md", to: path.join(ap.geminiConfig, "skills", "bb", "SKILL.md") }],
    // Not a discovery path (an older manual guide used it).
    legacy: (ap) => [path.join(ap.antigravityDir, "skills", "bb", "SKILL.md")],
    discovery: "~/.gemini/config/skills/bb/SKILL.md (global skill = slash command)",
    usage: "/bb <subcommand>",
  },
];

function which(bin, env) {
  const r = spawnSync("sh", ["-c", 'command -v "$1"', "sh", bin], { encoding: "utf8", env });
  return r.status === 0 ? r.stdout.trim() : null;
}

// Runs `<cli> --version`. Some CLIs create their cache/config/data folders on first run (OpenCode
// does even for --version), so the probe gets throwaway XDG folders: checking never writes to HOME.
function cliVersion(bin, env, run = spawnSync) {
  const scratch = fs.mkdtempSync(path.join(require("os").tmpdir(), "bb-probe-"));
  const xdg = Object.fromEntries(["XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]
    .map((k) => [k, path.join(scratch, k.toLowerCase())]));
  let r;
  try { r = run(bin, ["--version"], { encoding: "utf8", env: { ...env, ...xdg }, timeout: 10000 }); }
  finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  if (r.status !== 0 || !r.stdout) return null;
  const m = /\d+\.\d+(\.\d+)?/.exec(r.stdout);
  return m ? m[0] : r.stdout.trim().split("\n")[0].slice(0, 40);
}

// Each agent: {id, name, cli path, version, configDir found?, present}. Never writes anything.
function detectAgents({ env = process.env, home, whichFn = which, versionFn = cliVersion, exists = fs.existsSync } = {}) {
  const ap = agentPaths(env, home);
  return AGENTS.map((a) => {
    const cliPath = whichFn(a.cli, env);
    const configFound = a.configDirs(ap).some((d) => exists(d));
    return { ...a, ap, cliPath, version: cliPath ? versionFn(cliPath, env) : null, configFound,
             present: Boolean(cliPath || configFound) };
  });
}

// True if `target` could be created: the nearest existing ancestor must be a writable directory.
function writable(target) {
  let dir = path.dirname(target);
  for (;;) {
    if (fs.existsSync(dir)) {
      try { fs.accessSync(dir, fs.constants.W_OK); return fs.statSync(dir).isDirectory(); } catch { return false; }
    }
    const up = path.dirname(dir);
    if (up === dir) return false;
    dir = up;
  }
}

function isBrewboardFile(file) {
  try {
    const text = fs.readFileSync(file, "utf8");
    return /Brewboard/.test(text) && /\.bb\/skill|bb\.py/.test(text);
  } catch { return false; }
}

module.exports = { AGENTS, agentPaths, detectAgents, writable, isBrewboardFile, cliVersion, SHARED_SKILL };

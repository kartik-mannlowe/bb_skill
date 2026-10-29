"use strict";
// The four supported coding agents: where each discovers Brewboard, and how it is invoked.
// Paths verified on 2026-10-29 against the installed CLIs (Claude Code 2.1.312, Codex 0.165.0,
// OpenCode 1.18.35, Antigravity CLI 1.4.10). Each has the main entry point plus one suggestion entry per subcommand,
// named `bb <subcommand>`: picking it types `/bb <subcommand> ` (`$bb …` in Codex), which the CLI then sends to the
// main entry point with the subcommand as its first argument (see SUBCOMMANDS in scripts/build-dist.js):
//   Claude Code  ~/.claude/commands/bb.md                         /bb [subcommand]
//                ~/.claude/skills/bb <sub>/SKILL.md                skills; the folder name is what is typed
//   Codex        ~/.agents/skills/bb/SKILL.md                     user Agent Skill $bb [subcommand]
//                $CODEX_HOME/skills/bb-<id>/SKILL.md              skills named "bb <sub>" (Codex reads this
//                                                                 folder; OpenCode and Antigravity don't)
//   OpenCode     ~/.config/opencode/commands/bb.md                /bb [subcommand]
//                ~/.config/opencode/commands/bb <sub>.md          commands; the file name is what is typed
//                ~/.agents/skills/bb/SKILL.md                     auto-loaded external skill (so no second copy
//                                                                 in ~/.config/opencode/skills: duplicate name)
//   Antigravity  ~/.gemini/antigravity-cli/skills/bb/SKILL.md     global skill = slash command /bb. 1.4.x also reads
//                                                                 ~/.gemini/config/skills, but the antigravity-cli
//                                                                 copy wins, so only one copy is kept
//                ~/.gemini/antigravity-cli/skills/bb-<id>/SKILL.md skills named "bb <sub>"
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

// The /bb-<subcommand> commands earlier versions installed for Claude Code and OpenCode. An update removes them
// (they are tracked); these names also catch untracked copies from a manual install.
const RETIRED_COMMANDS = ["init", "list_projects", "list_tasks", "list_tickets", "cycles", "log_time", "timesheets",
  "create_mom", "moms", "show", "find", "status", "tickets"].map((s) => `bb-${s}.md`);

// Every packaged file below `prefix`, placed at the same relative path below `dir`.
const under = (dist, prefix, dir) => dist.filter((f) => f.startsWith(prefix))
  .map((f) => ({ from: f, to: path.join(dir, ...f.slice(prefix.length).split("/")) }));

const AGENTS = [
  {
    id: "claude", name: "Claude Code", cli: "claude", tested: "2.1.312",
    configDirs: (ap) => [ap.claudeDir],
    targets: (ap, dist) => [
      ...dist.filter((f) => f.startsWith("adapters/claude-code/"))
        .map((f) => ({ from: f, to: path.join(ap.claudeDir, "commands", path.basename(f)) })),
      ...under(dist, "adapters/claude-skills/", path.join(ap.claudeDir, "skills")),
    ],
    legacy: (ap) => [...RETIRED_COMMANDS, "erpnext-bb.md"].map((n) => path.join(ap.claudeDir, "commands", n)),
    discovery: "~/.claude/commands/bb.md (slash command) + ~/.claude/skills/bb <subcommand> (suggestions)",
    usage: "/bb (menu) or /bb <subcommand>, e.g. /bb list_tasks; each subcommand is also suggested as /bb <subcommand>",
  },
  {
    id: "codex", name: "Codex CLI", cli: "codex", tested: "0.165.0",
    configDirs: (ap) => [ap.codexDir],
    targets: (ap, dist) => [
      { from: "adapters/agent-skill/bb.md", to: SHARED_SKILL(ap) },
      ...dist.filter((f) => /^adapters\/codex\/bb-[a-z-]+\/SKILL\.md$/.test(f))
        .map((f) => ({ from: f, to: path.join(ap.codexDir, "skills", f.split("/")[2], "SKILL.md") })),
    ],
    legacy: (ap) => [path.join(ap.codexDir, "prompts", "bb.md"), path.join(ap.codexDir, "skills", "brewboard", "SKILL.md")],
    discovery: "~/.agents/skills/bb/SKILL.md (user Agent Skill) + ~/.codex/skills/bb-*/SKILL.md (picker entries)",
    usage: "$bb <subcommand> (Codex has no custom slash commands); each subcommand is also in the $ picker as bb <subcommand>",
  },
  {
    id: "opencode", name: "OpenCode", cli: "opencode", tested: "1.18.35",
    configDirs: (ap) => [ap.opencodeDir],
    targets: (ap, dist) => [
      ...under(dist, "adapters/opencode/", path.join(ap.opencodeDir, "commands")),
      { from: "adapters/agent-skill/bb.md", to: SHARED_SKILL(ap) },
    ],
    // An older manual install put the skill here too; OpenCode would then see `bb` twice.
    legacy: (ap) => [path.join(ap.opencodeDir, "skills", "bb", "SKILL.md"),
                     ...RETIRED_COMMANDS.map((n) => path.join(ap.opencodeDir, "commands", n))],
    discovery: "~/.config/opencode/commands/bb.md and bb <subcommand>.md (slash commands) + ~/.agents/skills/bb (auto-loaded skill)",
    usage: "/bb (menu) or /bb <subcommand>, e.g. /bb list_tasks; each subcommand is also suggested as /bb <subcommand>",
  },
  {
    id: "antigravity", name: "Antigravity CLI", cli: "agy", tested: "1.4.10",
    configDirs: (ap) => [ap.antigravityDir, ap.geminiConfig],
    targets: (ap, dist) => [
      { from: "adapters/agent-skill/bb.md", to: path.join(ap.antigravityDir, "skills", "bb", "SKILL.md") },
      ...under(dist, "adapters/antigravity-skills/", path.join(ap.antigravityDir, "skills")),
    ],
    // Where earlier versions installed it. Antigravity 1.4.9 still reads it, so a copy left there would be a second
    // `bb` registration (shadowed by the one above, but stale after the next update).
    legacy: (ap) => [path.join(ap.geminiConfig, "skills", "bb", "SKILL.md")],
    discovery: "~/.gemini/antigravity-cli/skills/bb/SKILL.md (global skill = /bb) + skills/bb-* (suggestions)",
    usage: "/bb (menu) or /bb <subcommand>; each subcommand is also suggested as /bb <subcommand>",
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

module.exports = { AGENTS, agentPaths, detectAgents, writable, isBrewboardFile, cliVersion, SHARED_SKILL, RETIRED_COMMANDS };

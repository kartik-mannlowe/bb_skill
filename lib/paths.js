"use strict";
// Where everything lives. HOME, BB_HOME and CLAUDE_CONFIG_DIR are honoured so tests (and unusual
// setups) can redirect them; the bb.py client reads BB_HOME the same way.
const os = require("os");
const path = require("path");

function resolvePaths(env = process.env, overrides = {}) {
  const home = env.HOME || os.homedir();
  const bbHome = overrides.bbHome || env.BB_HOME || path.join(home, ".bb");
  const claudeDir = env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");
  return {
    home,
    bbHome,
    skillDir: path.join(bbHome, "skill"),
    bbPy: path.join(bbHome, "skill", "scripts", "bb.py"),
    configFile: path.join(bbHome, "config.json"),
    backupsDir: path.join(bbHome, "backups"),
    lockFile: path.join(bbHome, "login.lock"),
    claudeDir,
    commandsDir: path.join(claudeDir, "commands"),
    distDir: path.join(__dirname, "..", "dist"),
    binPath: path.join(__dirname, "..", "bin", "brewboard-skill.js"),
  };
}

module.exports = { resolvePaths };

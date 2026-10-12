"use strict";
// User-facing text in one place, so tests can check it and it stays consistent.
const { installedAgents } = require("./install");
const { AGENTS } = require("./agents");

const RUN = "npx --yes --package=github:kartik-mannlowe/bb_skill brewboard-skill";

const bold = (s) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);

function wizardHeader() {
  return [bold("Brewboard sign-in"), "",
    "You will be asked for your server address, login ID and password. The password is not shown",
    "while you type, is sent only to your server's sign-in endpoint, and is never saved.", ""].join("\n");
}

function sharedSecretWarning() {
  return ["", bold("This Brewboard server shares one API secret per account."),
    "It has no per-client credentials. Signing in from the CLI replaces your account's API secret:",
    "the Brewboard web UI (and any other client) signed in as you will be signed out, and signing in to",
    "the web UI later will sign the CLI out. Ask your administrator to deploy per-client credentials",
    "(brewboard_backend: Brewboard API Credential) to avoid this.", ""].join("\n");
}

const START = { claude: "claude", codex: "codex", opencode: "opencode", antigravity: "agy" };

// One line per agent Brewboard is installed for: how to start it and how to call /bb there.
function agentLines(paths) {
  const ids = installedAgents(paths);
  const list = AGENTS.filter((a) => ids.includes(a.id));
  if (!list.length) return ["No coding agent was detected. Install Claude Code, Codex, OpenCode or Antigravity and run this again."];
  return list.map((a) => `${a.name.padEnd(16)} start \`${START[a.id]}\`, then: ${a.usage}`);
}

function howToStart(paths) {
  return ["Open a new terminal tab, start your coding agent and use Brewboard:", ...agentLines(paths).map((l) => `  ${l}`),
    "Subcommands: init, list_projects, list_tasks, tickets, cycles, log_time, timesheets, create_mom, moms, show, find, status.",
    "What works depends on your Brewboard role."].join("\n");
}

function success({ user, perClient, expiresOn, paths }) {
  return ["", bold("Brewboard authentication configured successfully."), "",
    `Your skill has been installed and your authentication configuration has been verified (signed in as ${user}).`,
    perClient
      ? `This CLI has its own credential${expiresOn ? ` (expires ${expiresOn})` : ""}; signing in to the web UI does not affect it.`
      : "This server uses one shared API secret per account: a later web UI sign-in will sign the CLI out.",
    "", "You can close this login tab and open a new terminal tab to start your coding agent and use the Brewboard commands:",
    "", ...agentLines(paths).map((l) => `  ${l}`), "",
    "Subcommands: /bb init, /bb list_projects, /bb list_tasks, /bb tickets, /bb log_time, /bb create_mom, /bb find, /bb status, …",
    "What works depends on your Brewboard role."].join("\n");
}

function recovery() {
  return ["", "To try again:            " + RUN + " --login",
    "To check what is saved:  " + RUN + " --check",
    "Nothing secret is printed by either command."].join("\n");
}

function help(version) {
  return `brewboard-skill ${version}: install the Brewboard /bb skill for Claude Code and sign in.

Usage:
  ${RUN} [option]

Options:
  (none)        Install or update the skill and commands, then check the sign-in. If you are not
                signed in, asks whether to sign in now (in a new terminal tab).
  --login       Sign in (or sign in again) now. Opens a new terminal tab when possible.
  --here        With --login: run the sign-in in this terminal instead of a new tab.
  --check       Read-only system check: prerequisites, agents, terminal, saved sign-in. Installs nothing,
                never signs in or rotates anything.
  --no-login    Install or update only; skip the sign-in check.
  --agents L    Only these agents (comma list): claude, codex, opencode, antigravity. Default: all detected.
  --uninstall   Remove the skill and the agent files Brewboard installed. Keeps ~/.bb/config.json.
  --version     Print the version.
  --help        This help.

Files:
  ~/.bb/skill/                       the skill (SKILL.md, scripts/bb.py)
  ~/.claude/commands/bb*.md          Claude Code:  /bb, /bb-*
  ~/.agents/skills/bb/SKILL.md       Codex ($bb) and OpenCode (auto-loaded skill)
  ~/.config/opencode/commands/bb*.md OpenCode:     /bb, /bb-*
  ~/.gemini/config/skills/bb/        Antigravity:  /bb
  ~/.bb/installed.json               which files Brewboard owns (used by updates and --uninstall)
  ~/.bb/config.json      server URL and API credential (mode 600; never your password)
  ~/.bb/backups/         copies of files replaced by an update

Recovery:
  Sign-in rejected?   run with --check to see why, then --login to sign in again.
  No desktop / SSH?   --login --here signs in inside the current terminal.`;
}

module.exports = { wizardHeader, sharedSecretWarning, success, recovery, help, howToStart, agentLines, RUN };

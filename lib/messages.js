"use strict";
// User-facing text in one place, so tests can check it and it stays consistent. Every function takes the
// output stream's style (lib/ui.js); without one the text is plain.
const { installedAgents } = require("./install");
const { PLAIN } = require("./ui");

const RUN = "npx --yes --package=github:kartik-mannlowe/bb_skill brewboard-skill";

function wizardHeader(style = PLAIN) {
  return [style.heading("Brewboard sign-in"), "",
    "You will be asked for your server address, login ID and password. The password is not shown",
    "while you type, is sent only to your server's sign-in endpoint, and is never saved.", ""].join("\n");
}

function sharedSecretWarning(style = PLAIN) {
  return ["", style.status("warn", style.bold("This Brewboard server shares one API secret per account.")),
    "It has no per-client credentials. Signing in from the CLI replaces your account's API secret:",
    "the Brewboard web UI (and any other client) signed in as you will be signed out, and signing in to",
    "the web UI later will sign the CLI out. Ask your administrator to deploy per-client credentials",
    "(brewboard_backend: Brewboard API Credential) to avoid this.", ""].join("\n");
}

// The one closing line once sign-in works: "ready" only when at least one coding agent was set up, because
// that is where Brewboard is used. How to call it differs per agent; the /bb menu and the skill explain the rest.
function ready(paths, style = PLAIN) {
  if (!installedAgents(paths).length) {
    return style.item("warn", "Signed in, but no coding agent is set up yet. Install Claude Code, Codex, OpenCode or " +
                              "Antigravity, then run this installer again.");
  }
  return style.item("ok", style.bold("Brewboard is ready.") + " Open your coding agent and start using Brewboard.");
}

function success({ user, perClient, expiresOn, paths, style = PLAIN, inTab = false }) {
  return ["", style.status("ok", style.bold("Brewboard authentication configured successfully.")),
    `  Signed in as ${user}. ` + (perClient
      ? `This CLI has its own credential${expiresOn ? ` (expires ${expiresOn})` : ""}; signing in to the web UI does not affect it.`
      : "This server uses one shared API secret per account: a later web UI sign-in will sign the CLI out."),
    "", ready(paths, style), ...(inTab ? [style.dim("   You can close this tab.")] : [])].join("\n");
}

function recovery(style = PLAIN) {
  const next = style.paint(style.symbol("next"), "next");
  return ["", `${next} To try again:            ${RUN} --login`,
    `${next} To check what is saved:  ${RUN} --check`,
    style.dim("  Nothing secret is printed by either command.")].join("\n");
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
  uninstall     Remove what this installer added (same as --uninstall). Shows the plan and asks first.
    --dry-run         only show the plan; change nothing
    --yes, -y         apply without asking (needed when not in a terminal)
    --force           also remove files you changed, if the installer created them
    --remove-backups  also delete the update backups in ~/.bb/backups/install-*
  --version     Print the version.
  --help        This help.

Files:
  ~/.bb/skill/                       the skill (SKILL.md, scripts/bb.py)
  ~/.claude/commands/bb*.md          Claude Code:  /bb, /bb-*
  ~/.agents/skills/bb/SKILL.md       Codex ($bb) and OpenCode (auto-loaded skill)
  ~/.config/opencode/commands/bb*.md OpenCode:     /bb, /bb-*
  ~/.gemini/config/skills/bb/        Antigravity:  /bb
  ~/.bb/installed.json               which files Brewboard owns (used by updates and uninstall)
  ~/.bb/backups/originals/           files that were there before Brewboard (put back by uninstall)
  ~/.bb/config.json      server URL and API credential (mode 600; never your password)
  ~/.bb/backups/         copies of files replaced by an update

Uninstall:
  ${RUN} uninstall --dry-run   # preview
  ${RUN} uninstall             # apply after confirming
  Removes only files recorded in ~/.bb/installed.json that are unchanged, puts back files that were
  there before, deletes the saved sign-in only if this installer created it (and you did not change
  it), and removes folders it created once they are empty. Exit code 2: something was kept.

Recovery:
  Sign-in rejected?   run with --check to see why, then --login to sign in again.
  No desktop / SSH?   --login --here signs in inside the current terminal.`;
}

module.exports = { wizardHeader, sharedSecretWarning, success, recovery, help, ready, RUN };

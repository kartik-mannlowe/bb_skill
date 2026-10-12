"use strict";
// Orchestration: preflight (read-only) → install core + detected agents → sign-in check →
// (ask) → sign in (new tab, else inline) → report.
const fs = require("fs");
const path = require("path");
const { resolvePaths } = require("./paths");
const { findPython } = require("./prereq");
const { install, uninstall } = require("./install");
const { preflight, renderPreflight } = require("./preflight");
const { AGENTS } = require("./agents");
const { authCheck } = require("./check");
const prompt = require("./prompt");
const terminal = require("./terminal");
const status = require("./status");
const lock = require("./lock");
const messages = require("./messages");
const { runWizard } = require("./wizard");

const VERSION = require("../package.json").version;
const FLAGS = new Set(["--login", "--here", "--check", "--no-login", "--uninstall", "--version", "--help", "-h", "-v",
                       "--wizard", "--status-file", "--bb-home", "--agents"]);
const VALUED = { "--status-file": "statusFile", "--bb-home": "bbHome", "--agents": "agents" };

function parseArgs(argv) {
  const out = { flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!FLAGS.has(a)) throw Object.assign(new Error(`Unknown option ${a}. See --help.`), { usage: true });
    if (VALUED[a]) {
      if (!argv[i + 1]) throw Object.assign(new Error(`${a} needs a value`), { usage: true });
      out[VALUED[a]] = argv[++i];
    } else out.flags.add(a);
  }
  if (out.agents) {
    out.agents = out.agents.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
    const unknown = out.agents.filter((x) => !AGENTS.some((ag) => ag.id === x));
    if (unknown.length) {
      throw Object.assign(new Error(`Unknown agent ${unknown.join(", ")}. Use: ${AGENTS.map((ag) => ag.id).join(", ")}`), { usage: true });
    }
  }
  return out;
}

const STATUS_TEXT = {
  ok: "signed in",
  not_configured: "not signed in yet",
  credentials_rejected: "the saved credentials are no longer accepted",
  not_brewboard: "the saved server is not a Brewboard backend",
  unreachable: "the saved server cannot be reached",
};

async function main(argv, { env = process.env, stdin = process.stdin, stdout = process.stdout,
                            stderr = process.stderr, deps = {} } = {}) {
  const say = (s = "") => stdout.write(s + "\n");
  let args;
  try { args = parseArgs(argv); } catch (e) { stderr.write(e.message + "\n"); return 2; }
  const f = args.flags;
  if (f.has("--version") || f.has("-v")) { say(VERSION); return 0; }
  if (f.has("--help") || f.has("-h")) { say(messages.help(VERSION)); return 0; }
  const paths = resolvePaths(env, { bbHome: args.bbHome });

  // Internal: the sign-in tab runs this.
  if (f.has("--wizard")) {
    const py = (findPython(env) || {}).cmd || "python3";
    const r = await runWizard({ paths, statusFile: args.statusFile, python: py, env, pauseAtEnd: true,
                                io: { input: stdin, output: stdout } });
    return r.state === "success" || r.state === "cancelled" ? 0 : 1;
  }

  // 1. Preflight: read-only. Nothing below runs if it finds a blocking problem.
  const distBbPy = path.join(paths.distDir, "skill", "scripts", "bb.py");
  const report = await (deps.preflight || preflight)({
    paths, env, agentFilter: args.agents, isTTY: Boolean(stdin.isTTY),
    authCheckFn: async () => {
      const py = (findPython(env) || {}).cmd;
      if (!py) return { status: "error", message: "Python not found" };
      // Before the first install, the packaged bb.py runs the same read-only check.
      return authCheck({ paths: fs.existsSync(paths.bbPy) ? paths : { ...paths, bbPy: distBbPy }, python: py, env });
    },
  });
  say(renderPreflight(report));
  if (!report.ok) {
    stderr.write(`\nCannot install: ${report.blocking.map((r) => `${r.check}: ${r.result}${r.action ? ` (${r.action})` : ""}`).join("; ")}.\n`);
    stderr.write("Nothing was changed.\n");
    return 1;
  }
  const python = report.python.cmd;
  if (f.has("--check")) {
    if (report.config.status !== "ok") say(`\nNot signed in (${STATUS_TEXT[report.config.status] || report.config.status}). Sign in with:  ${messages.RUN} --login`);
    return report.config.status === "ok" ? 0 : 3;
  }

  if (f.has("--uninstall")) {
    const r = uninstall(paths);
    say(`\nRemoved ${r.removed.length} Brewboard file(s)/folder(s).`);
    r.keptModified.forEach((p) => say(`  kept because you changed it: ${p}`));
    if (r.kept.length) say(`Kept: ${r.kept.join(", ")}. Run \`bb.py logout\` before uninstalling to revoke the ` +
                           "credential, or delete ~/.bb/config.json yourself.");
    return 0;
  }

  // 2. Install: core skill + every detected (and selected) agent.
  if (!f.has("--login") || !fs.existsSync(paths.bbPy)) {
    const r = install(paths, { agents: report.agents.filter((a) => a.install), version: VERSION });
    say("");
    say(`Brewboard skill ${VERSION}: core ${r.core.status} (${paths.skillDir})`);
    for (const a of report.agents) {
      const res = r.agents[a.id];
      if (!res) { say(`  ${a.name.padEnd(16)} skipped (${a.present ? "not selected or not writable" : "not installed"})`); continue; }
      if (res.status === "failed") { say(`  ${a.name.padEnd(16)} FAILED: ${res.error}`); continue; }
      say(`  ${a.name.padEnd(16)} ${res.status}: ${a.discovery}`);
      res.removed.forEach((p) => say(`  ${"".padEnd(16)} removed old copy ${p} (backed up)`));
    }
    if (r.backupDir) say(`  replaced files backed up to ${r.backupDir}`);
    if (!r.validation.ok) {
      stderr.write(`Error: installed files do not match the package: ${r.validation.mismatched.join(", ")}\n`);
      return 1;
    }
    if (Object.values(r.agents).some((x) => x.status === "failed")) {
      say("  Some agents failed; the others are installed. Fix the cause and run again.");
    }
  }
  if (f.has("--no-login")) return 0;

  // 3. Sign-in.
  if (!f.has("--login")) {
    const check = report.config;
    if (check.status === "ok") {
      say(`\nSigned in to ${check.url} as ${check.user}. Nothing else to do.`);
      say(messages.howToStart(paths));
      return 0;
    }
    say("");
    say("Brewboard authentication required");
    say(`  Status: ${STATUS_TEXT[check.status] || check.status}${check.message ? ` — ${check.message}` : ""}`);
    (check.next_steps || []).forEach((s) => say(`  - ${s}`));
    if (!stdin.isTTY) {
      say("\nThis is not an interactive terminal, so no sign-in was started. Run in a terminal:");
      say(`  ${messages.RUN} --login`);
      return 0;
    }
    const choice = await prompt.select({ input: stdin, output: stdout, message: "\nWould you like to sign in to Brewboard now?",
      choices: [{ label: "Yes", value: "yes", hint: "open a new terminal tab to configure authentication" },
                { label: "Cancel", value: "cancel", hint: "exit the login workflow", cancel: true }] })
      .catch((e) => (e instanceof prompt.Cancelled ? "cancel" : Promise.reject(e)));
    if (choice !== "yes") {
      say("\nSign-in skipped. The skill stays installed; no credentials were created or changed.");
      say(`Sign in later with:  ${messages.RUN} --login`);
      return 0;
    }
  }
  return startLogin({ paths, python, env, stdin, stdout, say, here: f.has("--here"), deps });
}

async function startLogin({ paths, python, env, stdin, stdout, say, here, deps }) {
  const held = lock.inspect(paths.lockFile);
  if (held && held.active) { say(`A Brewboard sign-in is already running (pid ${held.pid}). Finish it in its tab first.`); return 1; }

  const reason = here ? "you asked to sign in here (--here)" : (deps.noGuiReason || terminal.noGuiReason)(env);
  const term = reason ? null : (deps.findTerminal || terminal.findTerminal)(env);
  if (term) {
    const statusFile = status.createStatusFile();
    status.writeStatus(statusFile, "pending");
    const command = [process.execPath, paths.binPath, "--wizard", "--status-file", statusFile, "--bb-home", paths.bbHome];
    const launched = await (deps.launchTab || terminal.launchTab)(term, "Brewboard sign-in", command, { env });
    if (launched.ok) {
      say(`\nOpening a new ${term.name} tab for Brewboard sign-in…`);
      const result = await (deps.waitForStatus || status.waitForStatus)(statusFile, {
        onStarted: () => say("The sign-in tab is open. Complete the steps there; this terminal waits (Ctrl+C stops waiting)."),
      });
      status.removeStatusFile(statusFile);
      if (result.state !== "not_started") return reportTabResult(result, say, paths);
      say(`The ${term.name} tab did not start the sign-in.`);
    } else {
      status.removeStatusFile(statusFile);
      say(`\nCould not open a ${term.name} tab (${launched.error}).`);
    }
  }
  const why = reason || (term ? "the new tab did not start" : "no supported terminal (ptyxis, gnome-terminal, konsole, xfce4-terminal) was found");
  if (!stdin.isTTY) {
    say(`\nCannot open a sign-in tab: ${why}. Run this in an interactive terminal:\n  ${messages.RUN} --login --here`);
    return 1;
  }
  say(`\nSigning in here instead: ${why}.\n`);
  const r = await runWizard({ paths, python, env, io: { input: stdin, output: stdout } });
  return r.state === "success" || r.state === "cancelled" ? 0 : 1;
}

function reportTabResult(result, say, paths) {
  if (result.state === "success") {
    say(`\nSign-in completed in the other tab: Brewboard authentication configured for ${result.user}.`);
    say(messages.howToStart(paths));
    return 0;
  }
  if (result.state === "cancelled") { say("\nSign-in was cancelled in the other tab. Nothing was changed."); return 0; }
  if (result.state === "timeout") { say("\nStopped waiting after 15 minutes. If the sign-in tab is still open you can finish there."); return 1; }
  say(`\nSign-in did not complete: ${result.message || result.state}`);
  say(messages.recovery());
  return 1;
}

module.exports = { main, parseArgs, VERSION };

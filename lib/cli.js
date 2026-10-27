"use strict";
// Orchestration: preflight (read-only) → install core + detected agents → sign-in check →
// (ask) → sign in (new tab, else inline) → report.
const fs = require("fs");
const path = require("path");
const { resolvePaths } = require("./paths");
const { findPython } = require("./prereq");
const { install } = require("./install");
const { planUninstall, executeUninstall, hasWork, exitCode } = require("./uninstall");
const { preflight, renderPreflight } = require("./preflight");
const { AGENTS } = require("./agents");
const { authCheck } = require("./check");
const prompt = require("./prompt");
const terminal = require("./terminal");
const status = require("./status");
const lock = require("./lock");
const messages = require("./messages");
const ui = require("./ui");
const { runWizard } = require("./wizard");

const VERSION = require("../package.json").version;
const FLAGS = new Set(["--login", "--here", "--check", "--no-login", "--uninstall", "--version", "--help", "-h", "-v",
                       "--wizard", "--status-file", "--bb-home", "--agents",
                       "--dry-run", "--yes", "-y", "--force", "--remove-backups"]);
const UNINSTALL_ONLY = ["--dry-run", "--yes", "-y", "--force", "--remove-backups"];
const VALUED = { "--status-file": "statusFile", "--bb-home": "bbHome", "--agents": "agents" };

function parseArgs(argv) {
  const out = { flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "uninstall" && i === 0) { out.flags.add("--uninstall"); continue; } // subcommand form
    if (!FLAGS.has(a)) throw Object.assign(new Error(`Unknown option ${a}. See --help.`), { usage: true });
    if (VALUED[a]) {
      if (!argv[i + 1]) throw Object.assign(new Error(`${a} needs a value`), { usage: true });
      out[VALUED[a]] = argv[++i];
    } else out.flags.add(a);
  }
  const stray = UNINSTALL_ONLY.filter((x) => out.flags.has(x));
  if (stray.length && !out.flags.has("--uninstall")) {
    throw Object.assign(new Error(`${stray.join(", ")} only applies to uninstall. See --help.`), { usage: true });
  }
  if (out.flags.has("--uninstall")) {
    const clash = [...out.flags].filter((x) => !["--uninstall", ...UNINSTALL_ONLY].includes(x));
    if (out.agents) clash.push("--agents");
    if (out.statusFile) clash.push("--status-file");
    if (clash.length) throw Object.assign(new Error(`uninstall cannot be combined with ${clash.join(", ")}.`), { usage: true });
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
  // --version and --help stay conventional: plain text, no banner, no colour.
  if (f.has("--version") || f.has("-v")) { say(VERSION); return 0; }
  if (f.has("--help") || f.has("-h")) { say(messages.help(VERSION)); return 0; }
  const paths = resolvePaths(env, { bbHome: args.bbHome });
  const style = ui.createStyle(stdout, env);
  const errStyle = ui.createStyle(stderr, env);

  // Uninstall: handled before the preflight, so it never installs, signs in, or runs the agent CLIs.
  if (f.has("--uninstall")) {
    return runUninstall({ paths, stdin, stdout, stderr, say, style, errStyle, dryRun: f.has("--dry-run"),
                          yes: f.has("--yes") || f.has("-y"), force: f.has("--force"), removeBackups: f.has("--remove-backups") });
  }

  // Internal: the sign-in tab runs this (its own terminal, so it shows the banner there).
  if (f.has("--wizard")) {
    const py = (findPython(env) || {}).cmd || "python3";
    const r = await runWizard({ paths, statusFile: args.statusFile, python: py, env, pauseAtEnd: true, banner: true,
                                io: { input: stdin, output: stdout } });
    return r.state === "success" || r.state === "cancelled" ? 0 : 1;
  }

  // The banner: once, and only when a person is watching this terminal.
  if (stdout.isTTY) ui.printBanner(stdout, style, { version: VERSION });

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
  say(renderPreflight(report, style, stdout.isTTY ? style.width() : Infinity));
  if (!report.ok) {
    stderr.write(`\n${errStyle.status("error", `Cannot install: ${report.blocking.map((r) => `${r.check}: ${r.result}${r.action ? ` (${r.action})` : ""}`).join("; ")}.`)}\n`);
    stderr.write("  Nothing was changed.\n");
    return 1;
  }
  const python = report.python.cmd;
  if (f.has("--check")) {
    // The panel already shows the sign-in state; only the way to fix it is added.
    const why = report.config.status === "not_configured" ? "" : ` (${STATUS_TEXT[report.config.status] || report.config.status})`;
    if (report.config.status !== "ok") say(`\n  ${style.item("todo", `Not signed in${why}. Sign in with:`)}\n     ${messages.RUN} --login`);
    return report.config.status === "ok" ? 0 : 3;
  }

  // 2. Install: core skill + every detected (and selected) agent.
  if (!f.has("--login") || !fs.existsSync(paths.bbPy)) {
    const r = install(paths, { agents: report.agents.filter((a) => a.install), version: VERSION });
    if (!r.validation.ok) {
      stderr.write(`${errStyle.status("error", `Error: installed files do not match the package: ${r.validation.mismatched.join(", ")}`)}\n`);
      return 1;
    }
    // What happened, in a few lines: no paths, no per-file detail (installed.json keeps that for uninstall).
    const configured = report.agents.filter((a) => r.agents[a.id] && r.agents[a.id].status !== "failed");
    const failed = report.agents.filter((a) => r.agents[a.id] && r.agents[a.id].status === "failed");
    const CORE = { installed: "Brewboard skill installed", updated: "Brewboard skill updated", unchanged: "Brewboard skill up to date" };
    say("");
    say(`  ${style.heading(failed.length ? "INSTALLATION INCOMPLETE" : "INSTALLATION COMPLETE")}`);
    say("");
    say(`  ${style.item("ok", CORE[r.core.status] || `Brewboard skill ${r.core.status}`)}`);
    if (configured.length) {
      say(`  ${style.item("ok", `${configured.length} coding-agent integration${configured.length === 1 ? "" : "s"} configured`)}`);
      say(`     ${style.dim(configured.map((a) => a.name).join(" · "))}`);
    } else if (!failed.length) say(`  ${style.item("warn", "No coding agent configured")}`);
    failed.forEach((a) => say(`  ${style.item("error", `${a.name} could not be configured: ${r.agents[a.id].error}`)}`));
    if (failed.length) say(`     ${configured.length ? "The others are configured. " : ""}Fix the cause and run again.`);
  }
  if (f.has("--no-login")) return 0;

  // 3. Sign-in.
  if (!f.has("--login")) {
    const check = report.config;
    if (check.status === "ok") {
      say(`\n  ${style.item("ok", `Signed in as ${check.user}`)}`);
      say(`\n  ${messages.ready(paths, style)}`);
      return 0;
    }
    say("");
    say(`  ${style.heading("AUTHENTICATION REQUIRED")}`);
    say("");
    say("  Sign in to connect Brewboard to your workspace.");
    if (check.status !== "not_configured") {
      const why = STATUS_TEXT[check.status] || check.status;
      say(`  ${style.item("warn", `${why[0].toUpperCase()}${why.slice(1)}${check.message ? ` — ${check.message}` : ""}`)}`);
    }
    (check.next_steps || []).forEach((s) => say(`     ${style.paint(style.symbol("next"), "next")} ${s}`));
    if (!stdin.isTTY) {
      say("\n  This is not an interactive terminal, so no sign-in was started. Run in a terminal:");
      say(`     ${messages.RUN} --login`);
      return 0;
    }
    const where = report.terminal && !f.has("--here") ? "opens a new terminal tab" : "runs in this terminal";
    const choice = await prompt.select({ input: stdin, output: stdout, style, indent: "  ", message: "\n  Sign in to Brewboard now?",
      choices: [{ label: "Sign in now", value: "yes", hint: where },
                { label: "Skip", value: "cancel", hint: "sign in later", cancel: true }] })
      .catch((e) => (e instanceof prompt.Cancelled ? "cancel" : Promise.reject(e)));
    if (choice !== "yes") {
      say(`\n  ${style.item("info", "Sign-in skipped. Brewboard stays installed; no credentials were created or changed.")}`);
      say(`     Sign in later with:  ${messages.RUN} --login`);
      return 0;
    }
  }
  return startLogin({ paths, python, env, stdin, stdout, say, style, here: f.has("--here"), deps });
}

function renderPlan(plan, paths, say, style = ui.PLAIN) {
  const rel = (p) => (p.startsWith(paths.home + path.sep) ? `~/${path.relative(paths.home, p)}` : p);
  const list = (title, items, fmt = (x) => rel(x.path)) => {
    if (!items.length) return;
    say(`${style.bold(title)} (${items.length}):`);
    items.forEach((x) => say(`  ${fmt(x)}`));
  };
  const generated = plan.remove.filter((x) => x.generated).length;
  list("Remove", plan.remove.filter((x) => !x.generated), (x) => `${rel(x.path)}${x.note ? `  (${x.note})` : ""}`);
  if (generated) say(`  + ${generated} generated Python cache file(s) inside ~/.bb/skill`);
  list("Remove although you changed them (--force; created by the installer)", plan.forceRemove);
  list("Put back what was there before Brewboard", plan.restore, (x) => `${rel(x.path)}  ← ${rel(x.from)}`);
  list("Keep", plan.keep, (x) => `${rel(x.path)}  (${x.reason})`);
  list("Cannot put back (backup kept)", plan.conflicts, (x) => `${rel(x.path)}  (${x.reason}; backup: ${rel(x.backup)})`);
  if (plan.config) {
    const c = plan.config;
    if (c.action === "remove") say(`Saved Brewboard sign-in: REMOVE ${rel(c.path)}. Your saved Brewboard credentials will be deleted from this computer${c.forced ? " (changed since the installer wrote it; --force)" : ""}.`);
    else if (c.action === "restore") say(`Saved Brewboard sign-in: restore your earlier ${rel(c.path)} from ${rel(c.from)}.`);
    else if (c.action === "keep") say(`Saved Brewboard sign-in: keep ${rel(c.path)} (${c.reason}).`);
  }
  list("Not tracked: review by hand (left alone)", plan.manual.map((p) => ({ path: p })));
  if (plan.backups.length) {
    say(plan.removeBackups ? `Remove ${plan.backups.length} update backup folder(s) in ~/.bb/backups (--remove-backups).`
                           : `Keep ${plan.backups.length} update backup folder(s) in ~/.bb/backups (add --remove-backups to delete them).`);
  }
  if (plan.gone.length) say(`Already gone: ${plan.gone.length} tracked file(s).`);
}

async function runUninstall({ paths, stdin, stdout, stderr, say, style = ui.PLAIN, errStyle = ui.PLAIN, dryRun, yes, force,
                              removeBackups }) {
  const plan = planUninstall(paths, { force, removeBackups });
  say(style.heading(`Brewboard uninstall${dryRun ? " (dry run: nothing will be changed)" : ""}`));
  if (plan.blocked) {
    stderr.write(`${errStyle.status("error", `Cannot uninstall: ${plan.blocked}`)}\n`);
    plan.manual.forEach((p) => say(`  ${p}`));
    return 1;
  }
  if (plan.none) {
    say("No Brewboard installation record (~/.bb/installed.json) was found, so nothing is removed automatically.");
    if (plan.manual.length) {
      say("These look like Brewboard files from an earlier or manual install. Review and delete them by hand if you want:");
      plan.manual.forEach((p) => say(`  ${p}`));
      return 2;
    }
    say("Nothing to do.");
    return 0;
  }
  if (plan.schema === 1) say("Note: this installation was recorded by version 0.1.0; files that existed before it cannot be restored automatically.");
  renderPlan(plan, paths, say, style);
  if (!hasWork(plan)) { say("\nNothing to remove."); return plan.keep.length || plan.conflicts.length || plan.manual.length ? 2 : 0; }
  if (dryRun) { say("\nDry run: nothing was changed. Run without --dry-run to apply."); return 0; }

  if (!yes) {
    if (!stdin.isTTY) {
      say("\nNot an interactive terminal: nothing was changed. Re-run with --yes to apply the plan above.");
      return 1;
    }
    const msg = plan.forceRemove.length ? `\nApply this, including removing ${plan.forceRemove.length} file(s) you changed?` : "\nApply this?";
    const choice = await prompt.select({ input: stdin, output: stdout, style, message: msg,
      choices: [{ label: "Yes", value: "yes", hint: "remove and restore as listed" },
                { label: "Cancel", value: "cancel", hint: "change nothing", cancel: true }] })
      .catch((e) => (e instanceof prompt.Cancelled ? "cancel" : Promise.reject(e)));
    if (choice !== "yes") { say("\nCancelled. Nothing was changed."); return 1; }
  }

  const r = executeUninstall(paths, plan);
  say("");
  say(`Removed ${r.removed.length} file(s)${r.configRemoved ? " and the saved Brewboard sign-in" : ""}; restored ${r.restored.length}${r.configRestored ? " plus your earlier config.json" : ""}; removed ${r.dirsRemoved.length} empty folder(s).`);
  r.failed.forEach((f) => say(`  ${style.status("error", `FAILED to ${f.step} ${f.path}: ${f.error}`)}`));
  if (r.kept.length) say(`  Kept ${r.kept.length} changed file(s) (listed above).`);
  if (r.conflicts.length) say(`  ${r.conflicts.length} file(s) could not be put back; their backups are kept.`);
  if (r.configRemoved) say("  Note: the credential is only deleted locally; it stays valid on the server until it expires or is revoked.");
  say(r.trackingRemoved ? style.status("ok", "Brewboard is uninstalled.")
    : style.status("warn", "Some items remain (see above); ~/.bb/installed.json keeps them, so you can run uninstall again."));
  const leftovers = [paths.configFile, path.join(paths.bbHome, "state.json"), paths.backupsDir].filter((p) => fs.existsSync(p));
  if (leftovers.length) say(`Left in place: ${leftovers.join(", ")}`);
  return exitCode(r);
}

async function startLogin({ paths, python, env, stdin, stdout, say, style = ui.PLAIN, here, deps }) {
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
      if (result.state !== "not_started") return reportTabResult(result, say, paths, style);
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

function reportTabResult(result, say, paths, style = ui.PLAIN) {
  if (result.state === "success") {
    say(`\n  ${style.item("ok", `Signed in as ${result.user} (in the sign-in tab)`)}`);
    say(`\n  ${messages.ready(paths, style)}`);
    return 0;
  }
  if (result.state === "cancelled") { say(`\n${style.status("info", "Sign-in was cancelled in the other tab. Nothing was changed.")}`); return 0; }
  if (result.state === "timeout") { say(`\n${style.status("warn", "Stopped waiting after 15 minutes. If the sign-in tab is still open you can finish there.")}`); return 1; }
  say(`\n${style.status("error", `Sign-in did not complete: ${result.message || result.state}`)}`);
  say(messages.recovery(style));
  return 1;
}

module.exports = { main, parseArgs, VERSION };

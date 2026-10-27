"use strict";
// Read-only system check, run before anything is written (and on its own with --check).
// Every row has a level (what the installer does) and a view (what the readiness panel shows: group, a short
// label without paths, a display state and, for problems that are not blockers, a one-line hint).
// Levels:
//   fail         a required prerequisite is missing: stop, nothing is changed
//   unsupported  this environment cannot be supported: stop, nothing is changed
//   warn         carry on, but the user should know
//   pass / info  fine / for information (e.g. an optional agent that is not installed)
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { versionAtLeast } = require("./prereq");
const { detectAgents, writable } = require("./agents");
const terminal = require("./terminal");
const tracking = require("./tracking");
const { PLAIN, wrap } = require("./ui");

const MIN_NODE = [18, 17];
const MIN_PY = [3, 8];
const MIN_FREE_BYTES = 20 * 1024 * 1024;

function python(env, run) {
  const candidates = env.BB_PYTHON ? [env.BB_PYTHON] : ["python3", "python"];
  for (const cmd of candidates) {
    const r = run(cmd, ["-c", "import sys, ssl, json, urllib.request, getpass; print('%d.%d.%d' % sys.version_info[:3])"],
                  { encoding: "utf8", env, timeout: 15000 });
    if (r.status === 0 && r.stdout) return { cmd, version: r.stdout.trim(), modulesOk: true };
    const bare = run(cmd, ["-c", "import sys; print('%d.%d.%d' % sys.version_info[:3])"], { encoding: "utf8", env, timeout: 15000 });
    if (bare.status === 0 && bare.stdout) return { cmd, version: bare.stdout.trim(), modulesOk: false };
  }
  return null;
}

function freeBytes(dir) {
  try {
    const s = fs.statfsSync(dir);
    return s.bavail * s.bsize;
  } catch { return null; } // statfs needs Node 18.15+; unknown is not fatal
}

function existingAncestor(p) {
  let d = p;
  while (!fs.existsSync(d) && path.dirname(d) !== d) d = path.dirname(d);
  return d;
}

async function preflight({ paths, env = process.env, platform = process.platform, arch = process.arch,
                           nodeVersion = process.versions.node, run = spawnSync, detect = detectAgents,
                           isTTY = Boolean(process.stdin.isTTY), authCheckFn = null, agentFilter = null } = {}) {
  const rows = [];
  // view: { group, label, state?, hint? }; state defaults from the level (pass ok, info skip, warn warn, fail error).
  const add = (check, level, result, action = "", view = {}) =>
    rows.push({ check, level, result, action, group: view.group, label: view.label || check,
                state: view.state || STATE[level], hint: view.hint || null });
  const RUNTIME = "Runtime", PERMS = "Permissions", INTEGRATIONS = "Integrations", BREWBOARD = "Brewboard";

  // Environment
  if (platform === "linux" || platform === "darwin") {
    add("Operating system", "pass", `${platform} ${os.release()} (${arch})`, "", { group: RUNTIME, label: `${OS_NAME[platform]} ${arch}` });
  } else {
    add("Operating system", "unsupported", `${platform} (${arch})`, "Supported: Linux and macOS. On Windows use WSL.",
        { group: RUNTIME, label: `${platform} ${arch} (unsupported)` });
  }

  const node = nodeVersion.split(".").map(Number);
  versionAtLeast(node, MIN_NODE) ? add("Node.js", "pass", nodeVersion, "", { group: RUNTIME, label: `Node.js ${nodeVersion}` })
    : add("Node.js", "fail", nodeVersion, `Install Node.js ${MIN_NODE.join(".")} or newer.`,
          { group: RUNTIME, label: `Node.js ${nodeVersion} (needs ${MIN_NODE.join(".")}+)` });

  const py = python(env, run);
  if (!py) add("Python", "fail", "not found", `Install Python ${MIN_PY.join(".")}+ (python3); bb.py needs it.`, { group: RUNTIME, label: "Python not found" });
  else if (!versionAtLeast(py.version.split(".").map(Number), MIN_PY)) {
    add("Python", "fail", py.version, `Python ${MIN_PY.join(".")}+ is required.`, { group: RUNTIME, label: `Python ${py.version} (needs ${MIN_PY.join(".")}+)` });
  } else if (!py.modulesOk) {
    add("Python", "fail", `${py.version} (ssl/json/urllib missing)`, "Install a full Python 3 build with the ssl module.",
        { group: RUNTIME, label: `Python ${py.version} (no ssl)` });
  } else add("Python", "pass", `${py.version} (${py.cmd})`, "", { group: RUNTIME, label: `Python ${py.version}` });

  const homeOk = writable(path.join(paths.home, "x"));
  homeOk ? add("Home directory", "pass", `${paths.home} writable`, "", { group: PERMS })
    : add("Home directory", "fail", `${paths.home} not writable`, "Fix permissions or set HOME.", { group: PERMS, label: "Home directory not writable" });
  const bbOk = writable(path.join(paths.bbHome, "x"));
  bbOk ? add("~/.bb", "pass", `${paths.bbHome} writable`, "", { group: PERMS, label: "Brewboard configuration" })
    : add("~/.bb", "fail", `${paths.bbHome} not writable`, "Fix its permissions.", { group: PERMS, label: "Brewboard configuration not writable" });

  const free = freeBytes(existingAncestor(paths.bbHome));
  if (free === null) add("Disk space", "info", "unknown", "", { group: PERMS, label: "Disk space unknown" });
  else if (free < MIN_FREE_BYTES) {
    add("Disk space", "fail", `${Math.round(free / 1048576)} MB free`, "Free at least 20 MB.",
        { group: PERMS, label: `Disk space low (${Math.round(free / 1048576)} MB)` });
  } else add("Disk space", "pass", `${Math.round(free / 1048576)} MB free`, "", { group: PERMS });

  // Agents (optional, independent)
  const agents = detect({ env, home: paths.home }).map((a) => {
    const wanted = !agentFilter || agentFilter.includes(a.id);
    const targets = a.targets(a.ap, ["adapters/claude-code/bb.md", "adapters/opencode/bb.md"]);
    const canWrite = targets.every((t) => writable(t.to));
    const install = wanted && a.present && canWrite;
    let level, result, action, label = a.name, hint = null;
    if (!wanted) { level = "info"; result = "not selected (--agents)"; action = "skipped"; label = `${a.name} not selected`; }
    else if (!a.present) { level = "info"; result = "not installed"; action = "skipped; rerun after installing it"; label = `${a.name} not detected`; }
    else if (!canWrite) {
      level = "warn"; result = `${a.cliPath ? "installed" : "config found"}, but its directory is not writable`; action = "skipped; fix permissions";
      label = `${a.name} (not writable)`; hint = `${a.name}: its configuration folder is not writable, so it is skipped. Fix the permissions and run again.`;
    } else {
      level = a.cliPath ? "pass" : "warn";
      result = a.cliPath ? `installed ${a.version || "(version unknown)"}` : `config found, \`${a.cli}\` not on PATH`;
      label = a.cliPath ? `${a.name}${a.version ? ` ${a.version}` : ""}` : `${a.name} (\`${a.cli}\` not on PATH)`;
      if (a.cliPath && a.version && a.version !== a.tested && versionAtLeast(a.version.split(".").map(Number), a.tested.split(".").map(Number)) === false) {
        level = "warn"; result += ` (older than tested ${a.tested})`; label += " (older than tested)";
      }
      action = `install → ${a.discovery}`;
    }
    add(a.name, level, result, action, { group: INTEGRATIONS, label, hint });
    return { ...a, install };
  });
  if (!agents.some((a) => a.install)) {
    add("Agents", "warn", "no supported agent detected", "The skill is installed; rerun after installing Claude Code, Codex, OpenCode or Antigravity.",
        { group: INTEGRATIONS, label: "No coding agent detected",
          hint: "No coding agent detected: Brewboard is installed, but add Claude Code, Codex, OpenCode or Antigravity and run this again to use it." });
  }

  // Sign-in terminal (shown last in the Brewboard group)
  const noGui = terminal.noGuiReason(env);
  const term = noGui ? null : terminal.findTerminal(env);
  const terminalRow = () => {
    if (term) add("Terminal", "pass", `new tab via ${term.name}`, "sign-in opens a new tab", { group: BREWBOARD, label: "Sign-in opens a new tab" });
    else if (isTTY) add("Terminal", "info", `current terminal (${noGui || "no supported terminal app"})`, "sign-in runs here", { group: BREWBOARD, label: "Sign-in runs in this terminal", state: "info" });
    else add("Terminal", "warn", "no interactive terminal", "run --login from a terminal to sign in", { group: BREWBOARD, label: "No interactive terminal" });
  };

  // Existing installation + configuration
  let owned = {};
  try { owned = tracking.readTracking(paths) || {}; } catch (e) {
    if (!(e instanceof tracking.TrackingError)) throw e;
    add("Install record", "fail", "unreadable", `${e.message}. It records which files Brewboard owns, so it is never ` +
        "overwritten: restore it, or move it aside to start a new record (files installed before then count as " +
        "yours and are kept by uninstall).", { group: BREWBOARD, label: "Install record unreadable" });
  }
  const installed = fs.existsSync(paths.bbPy);
  add("Brewboard skill", "info", installed ? `installed${owned.version ? ` (${owned.version})` : ""}` : "not installed", installed ? "update" : "install",
      { group: BREWBOARD, state: installed ? "ok" : "todo",
        label: installed ? `Skill installed${owned.version ? ` (${owned.version})` : ""}` : "Skill not installed" });

  let config = { status: "not_configured" };
  if (authCheckFn) {
    config = await authCheckFn();
    const map = {
      ok: ["pass", `valid: ${config.user} on ${config.url}`, "no sign-in needed", `Signed in as ${config.user}`],
      not_configured: ["info", "missing", "offer sign-in", "Sign-in required", "todo"],
      credentials_rejected: ["warn", "rejected by the server", "offer sign-in again", "Saved sign-in no longer accepted"],
      unreachable: ["warn", `server unreachable${config.url ? ` (${config.url})` : ""}`, "check the network/VPN, or sign in to another server",
                    "Brewboard server unreachable"],  // explained by the sign-in section / --check line
      not_brewboard: ["warn", "saved URL is not a Brewboard backend", "offer sign-in", "Saved server is not Brewboard"],
    };
    const [level, result, action, label, state, hint] = map[config.status] ||
      ["warn", `${config.status}${config.message ? `: ${config.message}` : ""}`, "offer sign-in", "Sign-in could not be checked"];
    add("Brewboard sign-in", level, result, action, { group: BREWBOARD, label, state, hint });
  }
  terminalRow();

  const blocking = rows.filter((r) => r.level === "fail" || r.level === "unsupported");
  return { rows, ok: blocking.length === 0, blocking, agents, python: py, terminal: term, noGui, config };
}

const STATE = { pass: "ok", info: "skip", warn: "warn", fail: "error", unsupported: "error" };
const OS_NAME = { linux: "Linux", darwin: "macOS" };
const GROUPS = ["Runtime", "Permissions", "Integrations", "Brewboard"];

// The readiness panel: checks grouped as Runtime / Permissions / Integrations / Brewboard, two per line when the
// terminal is wide enough (one per line otherwise), each a status symbol and a short label. No paths, no action
// column. Blockers are red, problems amber, pending steps amber circles, things not present dim. Hints for
// non-blocking problems follow the panel; blockers are explained by the caller ("Cannot install: ...").
function renderPreflight(report, style = PLAIN, width = Infinity) {
  const symWidth = style.unicode ? 1 : 2;
  const cellText = (r) => style.item(r.state, r.label);
  const cellWidth = (r) => symWidth + 2 + r.label.length;
  const widest = Math.max(...report.rows.map(cellWidth));
  const twoUp = 2 + widest + 4 + widest <= width;
  const out = [`  ${style.heading("SYSTEM READINESS")}`];
  for (const group of GROUPS) {
    const rows = report.rows.filter((r) => r.group === group);
    if (!rows.length) continue;
    out.push("", `  ${style.bold(group)}`);
    for (let i = 0; i < rows.length; i += twoUp ? 2 : 1) {
      const pad = " ".repeat(widest - cellWidth(rows[i]) + 4);
      out.push(`  ${cellText(rows[i])}${twoUp && rows[i + 1] ? pad + cellText(rows[i + 1]) : ""}`);
    }
  }
  const hints = report.rows.filter((r) => r.hint && (r.state === "warn" || r.state === "error"));
  if (hints.length) {
    out.push("");
    for (const r of hints) {
      for (const [n, line] of wrap(r.hint, width - symWidth - 4).entries()) {
        out.push(n === 0 ? `  ${style.status("warn", line)}` : `  ${" ".repeat(symWidth)} ${line}`);
      }
    }
  }
  return out.join("\n");
}

module.exports = { preflight, renderPreflight, MIN_NODE, MIN_PY };

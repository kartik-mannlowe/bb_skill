"use strict";
// Read-only system check, run before anything is written (and on its own with --check).
// Every row has a level:
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
  const add = (check, level, result, action = "") => rows.push({ check, level, result, action });

  // Environment
  if (platform === "linux" || platform === "darwin") add("Operating system", "pass", `${platform} ${os.release()} (${arch})`);
  else add("Operating system", "unsupported", `${platform} (${arch})`, "Supported: Linux and macOS. On Windows use WSL.");

  const node = nodeVersion.split(".").map(Number);
  versionAtLeast(node, MIN_NODE) ? add("Node.js", "pass", nodeVersion)
    : add("Node.js", "fail", nodeVersion, `Install Node.js ${MIN_NODE.join(".")} or newer.`);

  const py = python(env, run);
  if (!py) add("Python", "fail", "not found", `Install Python ${MIN_PY.join(".")}+ (python3); bb.py needs it.`);
  else if (!versionAtLeast(py.version.split(".").map(Number), MIN_PY)) add("Python", "fail", py.version, `Python ${MIN_PY.join(".")}+ is required.`);
  else if (!py.modulesOk) add("Python", "fail", `${py.version} (ssl/json/urllib missing)`, "Install a full Python 3 build with the ssl module.");
  else add("Python", "pass", `${py.version} (${py.cmd})`);

  const homeOk = writable(path.join(paths.home, "x"));
  homeOk ? add("Home directory", "pass", `${paths.home} writable`) : add("Home directory", "fail", `${paths.home} not writable`, "Fix permissions or set HOME.");
  const bbOk = writable(path.join(paths.bbHome, "x"));
  bbOk ? add("~/.bb", "pass", `${paths.bbHome} writable`) : add("~/.bb", "fail", `${paths.bbHome} not writable`, "Fix its permissions.");

  const free = freeBytes(existingAncestor(paths.bbHome));
  if (free === null) add("Disk space", "info", "unknown");
  else if (free < MIN_FREE_BYTES) add("Disk space", "fail", `${Math.round(free / 1048576)} MB free`, "Free at least 20 MB.");
  else add("Disk space", "pass", `${Math.round(free / 1048576)} MB free`);

  // Agents (optional, independent)
  const agents = detect({ env, home: paths.home }).map((a) => {
    const wanted = !agentFilter || agentFilter.includes(a.id);
    const targets = a.targets(a.ap, ["adapters/claude-code/bb.md", "adapters/opencode/bb.md"]);
    const canWrite = targets.every((t) => writable(t.to));
    const install = wanted && a.present && canWrite;
    let level, result, action;
    if (!wanted) { level = "info"; result = "not selected (--agents)"; action = "skipped"; }
    else if (!a.present) { level = "info"; result = "not installed"; action = "skipped; rerun after installing it"; }
    else if (!canWrite) { level = "warn"; result = `${a.cliPath ? "installed" : "config found"}, but its directory is not writable`; action = "skipped; fix permissions"; }
    else {
      level = a.cliPath ? "pass" : "warn";
      result = a.cliPath ? `installed ${a.version || "(version unknown)"}` : `config found, \`${a.cli}\` not on PATH`;
      if (a.cliPath && a.version && a.version !== a.tested && versionAtLeast(a.version.split(".").map(Number), a.tested.split(".").map(Number)) === false) {
        level = "warn"; result += ` (older than tested ${a.tested})`;
      }
      action = `install → ${a.discovery}`;
    }
    add(a.name, level, result, action);
    return { ...a, install };
  });
  if (!agents.some((a) => a.install)) {
    add("Agents", "warn", "no supported agent detected", "The skill is installed; rerun after installing Claude Code, Codex, OpenCode or Antigravity.");
  }

  // Sign-in terminal
  const noGui = terminal.noGuiReason(env);
  const term = noGui ? null : terminal.findTerminal(env);
  if (term) add("Terminal", "pass", `new tab via ${term.name}`, "sign-in opens a new tab");
  else if (isTTY) add("Terminal", "info", `current terminal (${noGui || "no supported terminal app"})`, "sign-in runs here");
  else add("Terminal", "warn", "no interactive terminal", "run --login from a terminal to sign in");

  // Existing installation + configuration
  let owned = {};
  try { owned = tracking.readTracking(paths) || {}; } catch (e) {
    if (!(e instanceof tracking.TrackingError)) throw e;
    add("Install record", "fail", "unreadable", `${e.message}. It records which files Brewboard owns, so it is never ` +
        "overwritten: restore it, or move it aside to start a new record (files installed before then count as " +
        "yours and are kept by uninstall).");
  }
  const installed = fs.existsSync(paths.bbPy);
  add("Brewboard skill", "info", installed ? `installed${owned.version ? ` (${owned.version})` : ""}` : "not installed", installed ? "update" : "install");

  let config = { status: "not_configured" };
  if (authCheckFn) {
    config = await authCheckFn();
    const map = {
      ok: ["pass", `valid: ${config.user} on ${config.url}`, "no sign-in needed"],
      not_configured: ["info", "missing", "offer sign-in"],
      credentials_rejected: ["warn", "rejected by the server", "offer sign-in again"],
      unreachable: ["warn", `server unreachable${config.url ? ` (${config.url})` : ""}`, "check the network/VPN, or sign in to another server"],
      not_brewboard: ["warn", "saved URL is not a Brewboard backend", "offer sign-in"],
    };
    const [level, result, action] = map[config.status] || ["warn", `${config.status}${config.message ? `: ${config.message}` : ""}`, "offer sign-in"];
    add("Brewboard sign-in", level, result, action);
  }

  const blocking = rows.filter((r) => r.level === "fail" || r.level === "unsupported");
  return { rows, ok: blocking.length === 0, blocking, agents, python: py, terminal: term, noGui, config };
}

const ICON = { pass: "ok", info: "--", warn: "!!", fail: "XX", unsupported: "XX" };

function renderPreflight(report) {
  const w1 = Math.max(5, ...report.rows.map((r) => r.check.length));
  const w2 = Math.max(6, ...report.rows.map((r) => r.result.length));
  const line = (a, b, c, d) => `  ${a.padEnd(2)}  ${b.padEnd(w1)}  ${c.padEnd(w2)}  ${d}`.trimEnd();
  return ["System check", line("", "Check", "Result", "Action"), line("", "-".repeat(w1), "-".repeat(w2), "------"),
          ...report.rows.map((r) => line(ICON[r.level], r.check, r.result, r.action))].join("\n");
}

module.exports = { preflight, renderPreflight, MIN_NODE, MIN_PY };

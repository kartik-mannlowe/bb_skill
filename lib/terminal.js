"use strict";
// Opening a new terminal tab (or window) for the sign-in wizard.
// The terminals and their argument templates live in dist/skill/assets/terminals.json, shared with bb.py
// (bbclient/terminal.py, which opens `/bb init --login` the same way). Every launcher takes an argument
// array: no shell, no string interpolation, paths with spaces are safe. The command line carries only
// non-secret values (program path, a status-file path, the ~/.bb directory); passwords and API secrets
// are typed into the tab, never passed in.
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const TABLE_FILE = path.join(__dirname, "..", "dist", "skill", "assets", "terminals.json");

// {name, bin, mode: "tab"|"window", env, args(title, cmd)} from the shared table.
function loadTerminals(file = TABLE_FILE) {
  return JSON.parse(fs.readFileSync(file, "utf8")).terminals.map((t) => ({
    ...t,
    template: t.args,
    args: (title, cmd) => t.args.flatMap((a) => (a === "{command}" ? cmd : [a.split("{title}").join(title)])),
  }));
}

const TERMINALS = loadTerminals();
const GENERIC = "x-terminal-emulator";

function which(bin, env = process.env) {
  const r = spawnSync("sh", ["-c", 'command -v "$1"', "sh", bin], { encoding: "utf8", env });
  return r.status === 0 ? r.stdout.trim() : null;
}

// Why a new graphical tab cannot be opened here, or null if it can.
function noGuiReason(env = process.env, exists = fs.existsSync) {
  if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) return "this is an SSH session";
  if (exists("/.dockerenv") || exists("/run/.containerenv") || env.container) return "this runs inside a container";
  if (process.platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) return "there is no graphical session";
  if (process.platform !== "linux") return `opening tabs is implemented for Linux desktops only (${process.platform})`;
  return null;
}

// The forced one (BB_TERMINAL), else the terminal the user is in (if it is installed), else the
// distribution's default, else the first installed one (tab terminals before window-only ones).
function findTerminal(env = process.env, whichFn = which, realpath = (p) => fs.realpathSync(p)) {
  if (env.BB_TERMINAL) {
    const forced = TERMINALS.find((t) => t.name === env.BB_TERMINAL);
    if (forced && whichFn(forced.bin, env)) return forced;
    if (env.BB_TERMINAL === "none") return null;
  }
  const current = TERMINALS.find((t) => t.env.some((k) => env[k]) && whichFn(t.bin, env));
  if (current) return current;
  const alt = whichFn(GENERIC, env); // the distribution's default, if it is one we know
  if (alt) {
    try {
      const base = path.basename(realpath(alt)).replace(/\.wrapper$/, "");
      const def = TERMINALS.find((t) => t.bin !== GENERIC && (base === t.bin || base.startsWith(t.bin)));
      if (def) return def;
    } catch { /* fall through */ }
  }
  return TERMINALS.find((t) => whichFn(t.bin, env)) || null;
}

// Starts the terminal and resolves {ok, error}. ok means the terminal program accepted the
// request (exit 0, or still running after `settleMs` as a standalone instance); whether the tab
// actually started is confirmed separately through the status file.
function launchTab(term, title, command, { spawnFn = spawn, settleMs = 8000, env = process.env } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(term.bin, term.args(title, command), { detached: true, stdio: "ignore", env });
    } catch (e) {
      return resolve({ ok: false, error: e.message });
    }
    let settled = false;
    const finish = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => { child.unref(); finish({ ok: true }); }, settleMs);
    child.on("error", (e) => finish({ ok: false, error: e.code === "ENOENT" ? `${term.bin} not found` : e.message }));
    child.on("exit", (code, signal) => finish(code === 0 ? { ok: true }
      : { ok: false, error: `${term.bin} exited with ${signal || `code ${code}`}` }));
  });
}

module.exports = { TERMINALS, TABLE_FILE, loadTerminals, findTerminal, noGuiReason, launchTab, which };

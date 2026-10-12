"use strict";
// Opening a new terminal tab for the sign-in wizard.
// Every launcher takes an argument array: no shell, no string interpolation, paths with spaces
// are safe. The command line carries only non-secret values (program path, a status-file path,
// the ~/.bb directory); passwords and API secrets are typed into the tab, never passed in.
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const TERMINALS = [
  // Ptyxis: Ubuntu 25.10+ default (`x-terminal-emulator` points to it on 26.04).
  { name: "ptyxis", bin: "ptyxis", args: (title, cmd) => ["--tab", "-T", title, "--", ...cmd] },
  { name: "gnome-terminal", bin: "gnome-terminal", args: (title, cmd) => ["--tab", `--title=${title}`, "--", ...cmd] },
  { name: "konsole", bin: "konsole", args: (title, cmd) => ["--new-tab", "-p", `tabtitle=${title}`, "-e", ...cmd] },
  { name: "xfce4-terminal", bin: "xfce4-terminal", args: (title, cmd) => ["--tab", `--title=${title}`, "-x", ...cmd] },
];

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

function findTerminal(env = process.env, whichFn = which, realpath = (p) => fs.realpathSync(p)) {
  if (env.BB_TERMINAL) {
    const forced = TERMINALS.find((t) => t.name === env.BB_TERMINAL);
    if (forced && whichFn(forced.bin, env)) return forced;
    if (env.BB_TERMINAL === "none") return null;
  }
  const alt = whichFn("x-terminal-emulator", env); // the distribution's default, if it is one we know
  if (alt) {
    try {
      const base = path.basename(realpath(alt)).replace(/\.wrapper$/, "");
      const def = TERMINALS.find((t) => base === t.bin || base.startsWith(t.bin));
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

module.exports = { TERMINALS, findTerminal, noGuiReason, launchTab, which };

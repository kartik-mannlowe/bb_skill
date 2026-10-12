"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("events");
const terminal = require("../lib/terminal");

const has = (...bins) => (b) => (bins.includes(b) ? `/usr/bin/${b}` : null);

test("detects when no graphical tab can be opened", () => {
  const none = () => false;
  assert.match(terminal.noGuiReason({ DISPLAY: ":0", SSH_CONNECTION: "1 2 3 4" }, none), /SSH/);
  assert.match(terminal.noGuiReason({ DISPLAY: ":0" }, (p) => p === "/.dockerenv"), /container/);
  assert.match(terminal.noGuiReason({}, none), /no graphical session/);
  assert.strictEqual(terminal.noGuiReason({ WAYLAND_DISPLAY: "wayland-0" }, none), null);
});

test("prefers the distribution default terminal (Ptyxis on Ubuntu 26.04), then known ones", () => {
  const real = (p) => (p.endsWith("x-terminal-emulator") ? "/usr/bin/ptyxis" : p);
  assert.strictEqual(terminal.findTerminal({}, has("x-terminal-emulator", "ptyxis", "gnome-terminal"), real).name, "ptyxis");
  assert.strictEqual(terminal.findTerminal({}, has("gnome-terminal"), real).name, "gnome-terminal");
  assert.strictEqual(terminal.findTerminal({}, has("konsole"), real).name, "konsole");
  assert.strictEqual(terminal.findTerminal({}, has(), real), null);
  assert.strictEqual(terminal.findTerminal({ BB_TERMINAL: "none" }, has("ptyxis"), real), null);
});

test("tab commands are argument arrays with only non-secret values", () => {
  const cmd = ["/usr/bin/node", "/path with spaces/bin/brewboard-skill.js", "--wizard", "--status-file", "/tmp/s/status.json"];
  const pt = terminal.TERMINALS.find((t) => t.name === "ptyxis").args("Brewboard sign-in", cmd);
  assert.deepStrictEqual(pt, ["--tab", "-T", "Brewboard sign-in", "--", ...cmd]);
  const gt = terminal.TERMINALS.find((t) => t.name === "gnome-terminal").args("Brewboard sign-in", cmd);
  assert.deepStrictEqual(gt.slice(-cmd.length), cmd);
  assert.ok(gt.includes("--"));
});

function fakeSpawn(behaviour) {
  const calls = [];
  const fn = (bin, args, opts) => {
    calls.push({ bin, args, opts });
    const child = new EventEmitter();
    child.unref = () => {};
    setImmediate(() => behaviour(child));
    return child;
  };
  fn.calls = calls;
  return fn;
}

test("launch succeeds only when the terminal accepts the request", async () => {
  const term = terminal.TERMINALS[0];
  const okSpawn = fakeSpawn((c) => c.emit("exit", 0));
  assert.deepStrictEqual(await terminal.launchTab(term, "t", ["node", "x"], { spawnFn: okSpawn }), { ok: true });
  assert.strictEqual(okSpawn.calls[0].opts.shell, undefined); // never through a shell
  const missing = fakeSpawn((c) => c.emit("error", Object.assign(new Error("x"), { code: "ENOENT" })));
  assert.match((await terminal.launchTab(term, "t", ["node"], { spawnFn: missing })).error, /not found/);
  const fails = fakeSpawn((c) => c.emit("exit", 1));
  assert.strictEqual((await terminal.launchTab(term, "t", ["node"], { spawnFn: fails })).ok, false);
  const lingers = fakeSpawn(() => {});
  assert.deepStrictEqual(await terminal.launchTab(term, "t", ["node"], { spawnFn: lingers, settleMs: 50 }), { ok: true });
});

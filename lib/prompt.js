"use strict";
// Interactive prompts on a TTY, built on readline keypress events (no dependencies).
//   select():   ↑/↓ (or j/k) to move, Enter to choose, Esc / q / Ctrl+C to cancel
//   text():     line input with an optional default
//   password(): hidden input: nothing is echoed, not even asterisks; Ctrl+C cancels
// Streams are injectable so tests can drive them; a non-TTY input raises NotInteractive.
const readline = require("readline");

class Cancelled extends Error { constructor() { super("cancelled"); this.code = "cancelled"; } }
class NotInteractive extends Error { constructor() { super("not an interactive terminal"); this.code = "not_interactive"; } }

const CSI = "\x1b[";
const color = (out, code, s) => (out.isTTY ? `${CSI}${code}m${s}${CSI}0m` : s);

function withRawKeys(input, output, onKey) {
  if (!input.isTTY) return Promise.reject(new NotInteractive());
  return new Promise((resolve, reject) => {
    readline.emitKeypressEvents(input);
    const wasRaw = input.isRaw;
    input.setRawMode(true);
    input.resume();
    const done = (fn, value) => {
      input.removeListener("keypress", handler);
      input.setRawMode(wasRaw || false);
      input.pause();
      fn(value);
    };
    const handler = (str, key = {}) => {
      try {
        onKey(str, key, (v) => done(resolve, v), (e) => done(reject, e));
      } catch (e) {
        done(reject, e);
      }
    };
    input.on("keypress", handler);
  });
}

function select({ message, choices, input = process.stdin, output = process.stdout, initial = 0 }) {
  let index = initial;
  const draw = (first) => {
    if (!first) output.write(`${CSI}${choices.length}A`);
    for (let i = 0; i < choices.length; i++) {
      const c = choices[i];
      const line = i === index ? color(output, "36", `❯ ${c.label}`) : `  ${c.label}`;
      output.write(`${CSI}2K${line}${c.hint ? color(output, "2", ` — ${c.hint}`) : ""}\n`);
    }
  };
  output.write(`${message}\n${color(output, "2", "(use ↑/↓ and Enter; Esc cancels)")}\n`);
  draw(true);
  return withRawKeys(input, output, (str, key, resolve, reject) => {
    if ((key.ctrl && key.name === "c") || key.name === "escape" || str === "q") {
      const cancel = choices.find((c) => c.cancel);
      if (cancel) return resolve(cancel.value);
      return reject(new Cancelled());
    }
    if (key.name === "up" || str === "k") index = (index + choices.length - 1) % choices.length;
    else if (key.name === "down" || str === "j" || key.name === "tab") index = (index + 1) % choices.length;
    else if (key.name === "return" || key.name === "enter") return resolve(choices[index].value);
    else return undefined;
    draw(false);
    return undefined;
  });
}

function text({ message, input = process.stdin, output = process.stdout, defaultValue = "" }) {
  const hint = defaultValue ? color(output, "2", ` [${defaultValue}]`) : "";
  output.write(`${message}${hint} `);
  let buf = "";
  return withRawKeys(input, output, (str, key, resolve, reject) => {
    if (key.ctrl && (key.name === "c" || key.name === "d")) { output.write("\n"); return reject(new Cancelled()); }
    if (key.name === "return" || key.name === "enter") { output.write("\n"); return resolve(buf.trim() || defaultValue); }
    if (key.name === "backspace") {
      if (buf) { buf = buf.slice(0, -1); output.write("\b \b"); }
      return undefined;
    }
    if (str && !key.ctrl && !key.meta && str >= " ") { buf += str; output.write(str); }
    return undefined;
  });
}

function password({ message, input = process.stdin, output = process.stdout }) {
  output.write(`${message} ${color(output, "2", "(input hidden)")} `);
  const chars = [];
  return withRawKeys(input, output, (str, key, resolve, reject) => {
    if (key.ctrl && key.name === "c") { chars.fill(""); chars.length = 0; output.write("\n"); return reject(new Cancelled()); }
    if (key.name === "return" || key.name === "enter") {
      output.write("\n");
      const value = chars.join("");
      chars.fill(""); chars.length = 0;
      return resolve(value);
    }
    if (key.name === "backspace") { chars.pop(); return undefined; }
    if (str && !key.ctrl && !key.meta) for (const ch of str) if (ch >= " ") chars.push(ch);
    return undefined; // nothing is written for typed characters
  });
}

module.exports = { select, text, password, Cancelled, NotInteractive };

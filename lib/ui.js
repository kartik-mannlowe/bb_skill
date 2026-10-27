"use strict";
// Terminal presentation for the installer: colour, status symbols, headings and the Brewboard banner.
//   - colour only when the stream is a TTY, NO_COLOR is unset or empty, and TERM is not "dumb";
//   - Unicode symbols only in a UTF-8 locale (LC_ALL / LC_CTYPE / LANG), otherwise ASCII; BB_ASCII=1 forces ASCII;
//   - the banner art is dist/skill/assets/banner.txt (shared with bb.py's bbclient/ui.py), printed at most once
//     per process, using the widest wordmark that fits the terminal.
// No screen clearing, no cursor tricks, no animation: output stays readable when captured or piped.
const fs = require("fs");
const path = require("path");

// level -> [unicode symbol, ascii fallback, colour]
const LEVELS = {
  ok: ["✓", "ok", "32"], warn: ["!", "!!", "33"], error: ["✗", "XX", "31"],
  info: ["•", "--", "36"], skip: ["–", "--", "2"], next: ["›", ">", "36"],
  todo: ["○", "..", "33"], // a step still to do (not a failure)
};
const ROLES = { heading: "1;36", logo: "1;36", bold: "1", dim: "2" };
const WORDMARK = "B R E W B O A R D";
const TAGLINE = "Your workspace. Your workflow.";
const ART_FILE = path.join(__dirname, "..", "dist", "skill", "assets", "banner.txt");

function colorEnabled(stream, env = process.env) {
  if (env.NO_COLOR || env.TERM === "dumb") return false;
  return Boolean(stream && stream.isTTY);
}

function unicodeEnabled(env = process.env) {
  if (env.BB_ASCII || env.TERM === "dumb") return false;
  const loc = (env.LC_ALL || env.LC_CTYPE || env.LANG || "").toLowerCase();
  return loc.includes("utf-8") || loc.includes("utf8");
}

function createStyle(stream, env = process.env) {
  const color = colorEnabled(stream, env);
  const unicode = unicodeEnabled(env);
  const paint = (text, role) => {
    const code = ROLES[role] || (LEVELS[role] || [])[2];
    return color && code && text ? `\x1b[${code}m${text}\x1b[0m` : String(text);
  };
  const symbol = (level) => LEVELS[level][unicode ? 0 : 1];
  return {
    color, unicode, paint, symbol,
    status: (level, text) => `${paint(symbol(level), level)} ${text}`,
    // A panel or summary line: coloured symbol, two spaces, text (failures, warnings and pending steps tinted).
    item: (level, text) => {
      const tone = { error: "error", warn: "warn", todo: "warn", skip: "dim" }[level];
      return `${paint(symbol(level), level === "skip" ? "dim" : level)}  ${tone ? paint(text, tone) : text}`;
    },
    heading: (text) => paint(text, "heading"),
    bold: (text) => paint(text, "bold"),
    dim: (text) => paint(text, "dim"),
    width: () => (stream && stream.columns) || Number(env.COLUMNS) || 80,
  };
}

const PLAIN = createStyle(null, {});

// {variant: [lines], tagline} from banner.txt; {} if it cannot be read.
function loadArt(file = ART_FILE) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return {}; }
  const art = {};
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith(";")) continue;
    const m = /^\[(.+)\]\s*$/.exec(line);
    if (m) { current = m[1]; art[current] = []; } else if (current) art[current].push(line.trimEnd());
  }
  const tagline = (art.tagline || []).join(" ").trim();
  delete art.tagline;
  for (const k of Object.keys(art)) if (!art[k].length) delete art[k];
  if (tagline) art.tagline = tagline;
  return art;
}

// The widest wordmark that fits in `width` columns, else the one-line wordmark (unspaced if need be).
function logo(width, art = loadArt()) {
  for (const [name, lines] of Object.entries(art)) {
    if (name !== "tagline" && Math.max(...lines.map((l) => l.length)) <= width) return [...lines];
  }
  return [WORDMARK.length <= width ? WORDMARK : WORDMARK.replace(/ /g, "")];
}

// [wordmark lines, tagline lines]: the version sits at the right edge of the tagline when it fits.
function bannerParts(width = 80, version = null, art = loadArt()) {
  const mark = logo(width, art);
  const tagline = art.tagline || TAGLINE;
  const ver = version ? `v${version}` : "";
  const span = Math.max(...mark.map((l) => l.length), tagline.length);
  if (ver && tagline.length + 2 + ver.length <= span && span <= width) return [mark, [tagline.padEnd(span - ver.length) + ver]];
  // Very narrow: the tagline wraps at its sentence break.
  if (tagline.length > width) return [mark, [...tagline.replace(/\. /g, ".\n").split("\n"), ...(ver ? [ver] : [])]];
  return [mark, [tagline, ...(ver ? [ver] : [])]];
}

function bannerLines({ width = 80, version = null, status = [], art } = {}) {
  const [mark, info] = bannerParts(width, version, art || loadArt());
  return [...mark, ...info, ...status];
}

function renderBanner(style, { version = null, status = [], art } = {}) {
  const [mark, info] = bannerParts(style.width() - 2, version, art || loadArt());
  const out = ["", ...mark.map((l) => `  ${style.paint(l, "logo")}`), ...info.map((l) => `  ${style.dim(l)}`),
               ...status.map((l) => `  ${l}`), ""];
  return out.join("\n") + "\n";
}

let shown = false;

// Prints the banner once per process; later calls do nothing and return false.
function printBanner(stream, style, opts = {}) {
  if (shown) return false;
  shown = true;
  stream.write(renderBanner(style, opts));
  return true;
}

const resetBanner = () => { shown = false; }; // tests only

const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "");

// Word-wraps plain text to `width` columns (a word longer than the width stays whole).
function wrap(text, width) {
  if (!Number.isFinite(width) || width < 10 || text.length <= width) return [text];
  const lines = [];
  let cur = "";
  for (const word of text.split(/\s+/)) {
    if (cur && cur.length + 1 + word.length > width) { lines.push(cur); cur = word; } else cur = cur ? `${cur} ${word}` : word;
  }
  if (cur) lines.push(cur);
  return lines;
}

module.exports = { createStyle, colorEnabled, unicodeEnabled, PLAIN, loadArt, logo, bannerParts, bannerLines,
                   renderBanner, printBanner, resetBanner, stripAnsi, wrap, WORDMARK, TAGLINE, ART_FILE, LEVELS };

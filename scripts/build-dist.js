#!/usr/bin/env node
// Maintainer tool (not shipped): regenerates the generated parts of dist/ from the files authored in this
// repository and rewrites dist/manifest.json. It reads nothing outside this repository.
//
//   Authored (edit these)   dist/skill/**                     the skill, its Python client (bb.py) and assets
//                           dist/adapters/claude-code/bb*.md  Claude Code commands, also the source of OpenCode's
//                           dist/adapters/agent-skill/bb.md   the shared Agent Skill pointer
//   Generated (never edit)  dist/adapters/opencode/bb*.md     from the Claude Code commands (toOpencode below)
//                           dist/manifest.json                sha256 + mode of every packaged file
//
//   npm run build        regenerate the generated files and the manifest
//   npm run check-dist   verify all of it, read-only (scripts/check-dist.js)
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DIST = path.join(__dirname, "..", "dist");
const GROUPS = ["skill/", "adapters/claude-code/", "adapters/opencode/", "adapters/agent-skill/"];
const EXECUTABLE = new Set(["skill/scripts/bb.py"]);
const FORBIDDEN = /(^|\/)(__pycache__|\.venv|node_modules)(\/|$)|\.(pyc|tgz|pem|key|sqlite)$|(^|\/)(\.env[^/]*|config\.json|state\.json|db\.json)$/;

// OpenCode reads the same command files, minus Claude Code's argument-hint and its AskUserQuestion tool.
const OPENCODE_RULES = [
  [/^argument-hint:.*\n/m, ""],
  ["use the AskUserQuestion tool (four pages), never a numbered list.",
   "use your native selection UI if you have one (paged as in SKILL.md), otherwise the numbered list SKILL.md describes for other agents."],
  ["AskUserQuestion or any native selector", "a question tool or any native selector"],
  ["Do NOT use AskUserQuestion to pick", "Do NOT use a question tool to pick"],
  ["(no AskUserQuestion, no row numbers)", "(no question tool, no row numbers)"],
];

function toOpencode(text, name = "command") {
  let out = text;
  for (const [from, to] of OPENCODE_RULES) out = typeof from === "string" ? out.split(from).join(to) : out.replace(from, to);
  if (/AskUserQuestion/.test(out)) {
    throw new Error(`${name}: mentions AskUserQuestion in a way scripts/build-dist.js has no OpenCode rule for; add one`);
  }
  return out;
}

// {name: content} of the OpenCode commands the Claude Code commands produce.
function expectedOpencode(dist = DIST) {
  const dir = path.join(dist, "adapters", "claude-code");
  return Object.fromEntries(fs.readdirSync(dir).filter((f) => /^bb[\w-]*\.md$/.test(f)).sort()
    .map((f) => [f, toOpencode(fs.readFileSync(path.join(dir, f), "utf8"), f)]));
}

// Relative paths of the files below dir. Symlinks and other non-regular entries are refused: the package ships
// regular files only (check-dist rejects anything else, so the build must not write it into the manifest).
function walk(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    const rel = path.relative(base, full).split(path.sep).join("/");
    if (e.isDirectory()) return walk(full, base);
    if (!e.isFile()) throw new Error(`not allowed in dist/ (delete or move them first): ${rel} is not a regular file`);
    return [rel];
  });
}

const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const group = (p) => GROUPS.findIndex((g) => p.startsWith(g));

// The manifest dist/ should have: every packaged file, grouped as the installer expects, with its intended mode.
function manifestFor(dist = DIST) {
  const files = walk(dist).filter((p) => p !== "manifest.json");
  const bad = files.filter((p) => FORBIDDEN.test(p) || group(p) < 0);
  if (bad.length) throw new Error(`not allowed in dist/ (delete or move them first): ${bad.join(", ")}`);
  files.sort((a, b) => group(a) - group(b) || (a < b ? -1 : 1));
  return { source: "this repository: scripts/build-dist.js",
           files: files.map((p) => ({ path: p, sha256: sha(fs.readFileSync(path.join(dist, p))),
                                      mode: EXECUTABLE.has(p) ? "755" : "644" })) };
}

function build(dist = DIST, log = console.log) {
  const outDir = path.join(dist, "adapters", "opencode");
  const want = expectedOpencode(dist);
  fs.mkdirSync(outDir, { recursive: true });
  for (const f of fs.readdirSync(outDir)) if (!(f in want)) fs.rmSync(path.join(outDir, f));
  for (const [f, text] of Object.entries(want)) fs.writeFileSync(path.join(outDir, f), text);
  const manifest = manifestFor(dist);
  for (const f of manifest.files) fs.chmodSync(path.join(dist, f.path), parseInt(f.mode, 8));
  fs.writeFileSync(path.join(dist, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  log(`Built dist/: ${Object.keys(want).length} OpenCode commands generated, manifest lists ${manifest.files.length} files.`);
  return manifest;
}

if (require.main === module) {
  try { build(); } catch (e) { console.error(e.message); process.exit(1); }
}
module.exports = { build, manifestFor, expectedOpencode, toOpencode, OPENCODE_RULES };

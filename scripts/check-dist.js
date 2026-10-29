#!/usr/bin/env node
// Maintainer tool (not shipped): verifies dist/, read-only (it never writes). Exit 1 when
//   - a packaged file is missing, changed, has the wrong executable bit or is not a regular file,
//   - dist/ holds anything the manifest does not list (or anything that must never be packaged),
//   - a generated file is stale: the OpenCode command, the Codex shortcut skills or the manifest differ
//     from what `npm run build` (scripts/build-dist.js) makes from the authored files.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { manifestFor, expectedGenerated, GENERATED_DIRS } = require("./build-dist");

const DIST = path.join(__dirname, "..", "dist");
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

// Every entry below dir (files, symlinks and directories), relative and "/"-separated; links are not followed.
function entries(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    const rel = path.relative(base, full).split(path.sep).join("/");
    return e.isDirectory() ? [{ rel, dir: true }, ...entries(full, base)] : [{ rel, dir: false }];
  });
}

// Every way dist/ differs from its manifest. [] means identical.
function verifyDist(dist = DIST) {
  if (!fs.existsSync(dist)) return [`${dist} does not exist`];
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(dist, "manifest.json"), "utf8")); } catch (e) {
    return [`manifest.json is missing or not valid JSON (${e.code || e.message})`];
  }
  if (!manifest || !Array.isArray(manifest.files) || !manifest.files.length) return ["manifest.json lists no files"];
  const problems = [];
  const listed = new Set();
  const dirs = new Set();
  for (const f of manifest.files) {
    const p = f && f.path;
    if (typeof p !== "string" || !p || p.startsWith("/") || p.split("/").includes("..") || p === "manifest.json") {
      problems.push(`manifest.json has an invalid path ${JSON.stringify(p)}`);
      continue;
    }
    if (listed.has(p)) { problems.push(`manifest.json lists ${p} twice`); continue; }
    listed.add(p);
    for (let d = path.posix.dirname(p); d !== "."; d = path.posix.dirname(d)) dirs.add(d);
    let st;
    try { st = fs.lstatSync(path.join(dist, p)); } catch { problems.push(`missing ${p}`); continue; }
    if (!st.isFile()) { problems.push(`${p} is not a regular file`); continue; }
    if (sha(fs.readFileSync(path.join(dist, p))) !== f.sha256) problems.push(`${p} differs from its manifest entry`);
    // Git and npm keep only the executable bit (the rest follows the umask); the installer sets the exact mode.
    const mode = st.mode & 0o777;
    if (Boolean(mode & 0o111) !== Boolean(parseInt(f.mode, 8) & 0o111)) problems.push(`${p} has mode ${mode.toString(8)}, expected ${f.mode}`);
  }
  for (const e of entries(dist)) {
    if (e.rel === "manifest.json" || listed.has(e.rel) || (e.dir && dirs.has(e.rel))) continue;
    problems.push(`unexpected ${e.dir ? "directory" : "file"} ${e.rel}`);
  }
  return problems;
}

// Every way the generated files differ from what `npm run build` would write. [] means up to date.
function verifyGenerated(dist = DIST) {
  const problems = [];
  let want;
  try { want = expectedGenerated(dist); } catch (e) { return [e.message]; }
  // OpenCode's /bb comes from the Claude Code command of the same file name; every other generated file from the table.
  const fromClaude = (rel) => /^adapters\/opencode\/[^/]+$/.test(rel) &&
    fs.existsSync(path.join(dist, "adapters", "claude-code", path.posix.basename(rel)));
  const source = (rel) => (fromClaude(rel) ? `adapters/claude-code/${path.posix.basename(rel)}` : "SUBCOMMANDS in scripts/build-dist.js");
  for (const [rel, text] of Object.entries(want)) {
    let have = null;
    try { have = fs.readFileSync(path.join(dist, rel), "utf8"); } catch { /* reported below */ }
    if (have === null) problems.push(`${rel} is missing (generated from ${source(rel)})`);
    else if (have !== text) problems.push(`${rel} is stale (generated from ${source(rel)})`);
  }
  for (const d of GENERATED_DIRS) {
    if (!fs.existsSync(path.join(dist, d))) continue;
    for (const e of entries(path.join(dist, d))) {
      const rel = `${d}/${e.rel}`;
      if (e.dir || rel in want) continue;
      problems.push(/^adapters\/opencode\/bb[\w-]*\.md$/.test(rel) ? `${rel} has no Claude Code source` : `${rel} is not a generated file`);
    }
  }
  let fresh;
  try { fresh = manifestFor(dist); } catch (e) { return [...problems, e.message]; }
  let current = null;
  try { current = JSON.parse(fs.readFileSync(path.join(dist, "manifest.json"), "utf8")); } catch { /* verifyDist reports it */ }
  if (current && JSON.stringify(current) !== JSON.stringify(fresh)) problems.push("manifest.json is out of date");
  return problems;
}

function main({ dist = DIST, log = console.log, error = console.error } = {}) {
  const problems = [...verifyDist(dist), ...verifyGenerated(dist)];
  if (problems.length) {
    error(`dist/ is not consistent (run \`npm run build\` after editing authored files):\n  ${[...new Set(problems)].join("\n  ")}`);
    return 1;
  }
  log(`dist/ matches dist/manifest.json and the generated files are current (${JSON.parse(fs.readFileSync(path.join(dist, "manifest.json"), "utf8")).files.length} files).`);
  return 0;
}

if (require.main === module) {
  try { process.exit(main()); } catch (e) { console.error(e.message); process.exit(1); }
}
module.exports = { verifyDist, verifyGenerated, main };

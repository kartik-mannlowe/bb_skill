"use strict";
// ~/.bb/installed.json: what the installer owns, so updates and uninstall touch only that.
//
// Schema 2:
// {
//   "schema": 2, "version": "<package version>", "updated": "<iso>",
//   "files":  { "<abs path>": { "sha256", "agents": [...], "mode": "644",
//                               "created": true | false,      // false: a file was there before Brewboard
//                               "original": "<abs path>" | null } },   // where that earlier file was kept
//   "moved":  [ { "path", "backup", "sha256", "agent", "mode" } ],     // old Brewboard copies moved aside
//   "dirs":   [ "<abs dir the installer created>" ],                   // removed on uninstall only if empty
//   "config": { "path", "created": bool, "original": "<abs path>" | null, "sha256" },  // ~/.bb/config.json
//   "backup_runs": [ "<abs dir>" ]                                     // ~/.bb/backups/install-<ts>
// }
// Schema 1 (0.1.0) had only files[path] = {sha256, agents}; it is read with created/original unknown.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const trackingFile = (paths) => path.join(paths.bbHome, "installed.json");
const originalsDir = (paths) => path.join(paths.backupsDir, "originals");

class TrackingError extends Error {}

function empty() {
  return { schema: 2, version: null, updated: null, files: {}, moved: [], dirs: [], config: null, backup_runs: [] };
}

// Reads and validates; returns null when there is no file. Throws TrackingError when it is unusable.
function readTracking(paths) {
  const file = trackingFile(paths);
  if (!fs.existsSync(file)) return null;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) {
    throw new TrackingError(`${file} is not valid JSON (${e.message})`);
  }
  if (!raw || typeof raw !== "object" || typeof raw.files !== "object" || Array.isArray(raw.files)) {
    throw new TrackingError(`${file} has no "files" record`);
  }
  const t = { ...empty(), ...raw, schema: raw.schema || 1 };
  for (const [p, info] of Object.entries(t.files)) {
    if (!path.isAbsolute(p) || !info || typeof info.sha256 !== "string") throw new TrackingError(`${file}: bad entry for ${p}`);
    if (!("created" in info)) info.created = null; // schema 1: unknown
    if (!("original" in info)) info.original = null;
  }
  t.moved = Array.isArray(t.moved) ? t.moved : [];
  t.dirs = Array.isArray(t.dirs) ? t.dirs : [];
  t.backup_runs = Array.isArray(t.backup_runs) ? t.backup_runs : [];
  return t;
}

// Like readTracking, but a missing or unreadable file yields an empty record (used while installing).
function loadForUpdate(paths) {
  try { return readTracking(paths) || empty(); } catch { return empty(); }
}

function writeTracking(paths, t) {
  const file = trackingFile(paths);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...t, schema: 2, updated: new Date().toISOString() }, null, 2) + "\n", { mode: 0o644 });
  fs.renameSync(tmp, file);
}

// Where the pre-Brewboard copy of `file` is kept (stable: never pruned with update backups).
function originalPathFor(paths, file) {
  const rel = path.relative(paths.home, file);
  return path.join(originalsDir(paths), rel.startsWith("..") ? path.join("_outside_home", file) : rel);
}

// Creates `dir` and missing ancestors; records each one it creates in t.dirs.
function ensureDir(t, dir, mode = 0o755) {
  const missing = [];
  let d = dir;
  while (!fs.existsSync(d)) { missing.unshift(d); const up = path.dirname(d); if (up === d) break; d = up; }
  for (const m of missing) {
    fs.mkdirSync(m, { mode });
    if (!t.dirs.includes(m)) t.dirs.push(m);
  }
}

// Called by the sign-in wizard after it saved and verified ~/.bb/config.json.
// `before` is the raw content that was there before the first write (null: there was none).
// Returns false, writing nothing, when installed.json exists but cannot be read: it is never overwritten.
function recordConfig(paths, before) {
  let t;
  try { t = readTracking(paths) || empty(); } catch (e) {
    if (e instanceof TrackingError) return false;
    throw e;
  }
  const content = fs.readFileSync(paths.configFile);
  if (!t.config || t.config.path !== paths.configFile) {
    let original = null;
    if (before !== null) {
      original = originalPathFor(paths, paths.configFile);
      ensureDir(t, path.dirname(original), 0o700);
      fs.writeFileSync(original, before, { mode: 0o600 }); // the user's own earlier sign-in, kept to restore
      fs.chmodSync(original, 0o600);
    }
    t.config = { path: paths.configFile, created: before === null, original, sha256: sha(content) };
  } else {
    t.config.sha256 = sha(content); // a later sign-in through the installer: still installer-written
  }
  writeTracking(paths, t);
  return true;
}

module.exports = { readTracking, loadForUpdate, writeTracking, originalPathFor, originalsDir, ensureDir, recordConfig,
                   trackingFile, TrackingError, sha, empty };
